// Los créditos del disco, ordenados por el bloque del canal (Brian, 2026-09-21).
//
// La descripción del canal de CRV es la verdad principal y trae sus créditos
// ya repartidos: Musicians, Guest Musicians y Other Credits. El core, en
// cambio, clasificaba por el texto del rol, así que «Keyboards» bajo Guest
// Musicians acababa en Músicos. Este módulo planifica —sin escribir— cómo
// dejar cada crédito en su sitio, y `applyCreditSectionPlan` lo ejecuta con la
// vía auditada del operador.
//
// Dos fases, en este orden:
//
//  * CANAL. Un crédito del canal toma el tipo de su bloque: Musicians →
//    músico, Guest Musicians → invitado.
//  * OTRAS FUENTES, en los discos que el canal ya acredita:
//      - Músicos: nadie se pierde. Los del bloque Musicians son los
//        principales; cualquier otro músico que aporte otra fuente pasa a
//        invitado. Solo sobra el que repite a un principal.
//      - Producción, Composición y Arte: solo sobra lo repetido, es decir,
//        quien el canal ya acredita en la misma sección de ese disco. Lo que
//        el canal no menciona (un estudio, un productor ejecutivo) se queda.
//      - «Otros créditos» y los invitados de otras fuentes no se tocan.
//
// Nunca se toca un crédito que una persona escribió o corrigió: su claim
// humano manda sobre cualquier fuente.
import type { PoolClient } from "pg";
import { withOperatorRun, updateRelation, deleteRelation, createEntity, createRelation } from "../merge/operator.js";
import { creditTypeForRole, isRoleAgnosticCreditType, type CreditType } from "../merge/relations.js";
import { normalizeEntityName, removeDiacritics } from "../normalization/entity-name.js";
import { looksLikeOrganization, parseCreditSections, parseYouTubeDescription } from "./parsers.js";

export type CreditKind = "album_credit" | "track_credit";

export interface CreditRow {
  kind: CreditKind;
  id: number;
  albumId: number;
  creditType: CreditType;
  role: string;
  /** "p12", "a3" u "o7": a quién acredita. */
  target: string;
  /** Tiene un claim vivo del canal. */
  fromChannel: boolean;
  /** Bloque del canal del que salió, si es uno de los dos de músicos. */
  section: "musicians" | "guest_musicians" | null;
  /** Una persona lo escribió o lo corrigió. */
  human: boolean;
}

export type PlannedChange =
  | { action: "retype"; credit: CreditRow; to: CreditType; reason: string }
  | { action: "retire"; credit: CreditRow; reason: string };

const CATEGORY: Readonly<Partial<Record<CreditType, string>>> = {
  producer: "Producción", recording: "Producción", mixing: "Producción", mastering: "Producción",
  writer: "Composición", composer: "Composición",
  artwork: "Arte", photography: "Arte",
};

/** Fase 1: cada crédito del canal, al tipo de su bloque. */
export function planChannelSections(credits: CreditRow[]): PlannedChange[] {
  const plan: PlannedChange[] = [];
  for (const credit of credits) {
    if (!credit.fromChannel || credit.human || credit.section === null) continue;
    const expected: CreditType = credit.section === "guest_musicians" ? "guest" : "musician";
    if (credit.creditType !== expected) {
      plan.push({ action: "retype", credit, to: expected,
        reason: `el canal lo acredita en ${credit.section === "guest_musicians" ? "Guest Musicians" : "Musicians"}` });
    }
  }
  return plan;
}

/** Fase 2: lo de otras fuentes, en los discos que el canal ya acredita. */
export function planOtherSources(credits: CreditRow[]): PlannedChange[] {
  const principals = new Map<number, Set<string>>();
  const covered = new Map<number, Set<string>>();
  for (const credit of credits) {
    if (!credit.fromChannel) continue;
    if (credit.section === "musicians") {
      const set = principals.get(credit.albumId) ?? new Set<string>();
      set.add(credit.target);
      principals.set(credit.albumId, set);
    }
    const category = CATEGORY[credit.creditType];
    if (category) {
      const set = covered.get(credit.albumId) ?? new Set<string>();
      set.add(`${category}|${credit.target}`);
      covered.set(credit.albumId, set);
    }
  }
  const plan: PlannedChange[] = [];
  for (const credit of credits) {
    if (credit.fromChannel || credit.human) continue;
    if (credit.creditType === "musician") {
      const main = principals.get(credit.albumId);
      if (!main) continue;
      if (main.has(credit.target)) {
        plan.push({ action: "retire", credit, reason: "repite a un músico principal del canal" });
      } else {
        plan.push({ action: "retype", credit, to: "guest", reason: "no está entre los músicos del canal: pasa a invitado" });
      }
      continue;
    }
    const category = CATEGORY[credit.creditType];
    if (category && covered.get(credit.albumId)?.has(`${category}|${credit.target}`)) {
      plan.push({ action: "retire", credit, reason: `el canal ya lo acredita en ${category} de este disco` });
    }
  }
  return plan;
}

/** Todos los créditos de los discos que tienen al menos un crédito del canal. */
export async function readCreditRows(client: PoolClient): Promise<CreditRow[]> {
  const { rows } = await client.query<{
    kind: CreditKind; id: string; album_id: string; credit_type: CreditType; role: string; target: string;
    from_channel: boolean; sections: string[] | null; human: boolean; has_claims: boolean;
  }>(`
    WITH yt AS (SELECT id FROM ingest.sources WHERE slug='youtube-data-api'),
    credits AS (
      SELECT 'album_credit'::text AS kind, ac.id, ac.album_id, ac.credit_type, ac.role,
             ac.person_id, ac.artist_id, ac.organization_id
        FROM public.album_credits ac
      UNION ALL
      SELECT 'track_credit', tc.id, t.album_id, tc.credit_type, tc.role,
             tc.person_id, tc.artist_id, tc.organization_id
        FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id
    ),
    linked AS (
      SELECT CASE WHEN cl.album_credit_id IS NOT NULL THEN 'album_credit' ELSE 'track_credit' END AS kind,
             coalesce(cl.album_credit_id, cl.track_credit_id) AS id,
             bool_or(cl.source_id = (SELECT id FROM yt) AND cl.status IN ('candidate','accepted')) AS from_channel,
             bool_or(cl.created_by = 'human') AS human,
             array_agg(DISTINCT substring(e.selector FROM '^section:(.*)$'))
               FILTER (WHERE cl.source_id = (SELECT id FROM yt) AND e.selector IN ('section:musicians','section:guest_musicians')
                       -- Solo "Rol: Nombre"; un "Produced by X" suelto dentro del bloque no es un músico.
                       AND e.excerpt !~ '^[^:]+ (by|at) ') AS sections
        FROM ingest.claims cl
        LEFT JOIN ingest.claim_evidence e ON e.claim_id = cl.id
       WHERE cl.album_credit_id IS NOT NULL OR cl.track_credit_id IS NOT NULL
       GROUP BY 1, 2
    )
    SELECT c.kind, c.id::text, c.album_id::text, c.credit_type::text AS credit_type, c.role,
           CASE WHEN c.person_id IS NOT NULL THEN 'p' || c.person_id
                WHEN c.artist_id IS NOT NULL THEN 'a' || c.artist_id
                ELSE 'o' || c.organization_id END AS target,
           coalesce(l.from_channel, false) AS from_channel, l.sections, coalesce(l.human, false) AS human,
           l.id IS NOT NULL AS has_claims
      FROM credits c
      LEFT JOIN linked l ON l.kind = c.kind AND l.id = c.id
     WHERE c.album_id IN (
       SELECT DISTINCT coalesce(ac.album_id, t.album_id)
         FROM ingest.claims cl
         LEFT JOIN public.album_credits ac ON ac.id = cl.album_credit_id
         LEFT JOIN public.track_credits tc ON tc.id = cl.track_credit_id
         LEFT JOIN public.tracks t ON t.id = tc.track_id
        WHERE cl.source_id = (SELECT id FROM yt) AND cl.status IN ('candidate','accepted')
          AND (cl.album_credit_id IS NOT NULL OR cl.track_credit_id IS NOT NULL))`);
  const credits = rows.map((row) => {
    const sections = (row.sections ?? []).filter(Boolean);
    // Un mismo crédito citado en los dos bloques no tiene bloque claro: no se retipa.
    const section = sections.length === 1 ? sections[0] as CreditRow["section"] : null;
    return {
      kind: row.kind, id: Number(row.id), albumId: Number(row.album_id), creditType: row.credit_type,
      role: row.role, target: row.target, fromChannel: row.from_channel, section, human: row.human,
    };
  });
  return inheritSiblingOrigin(credits, rows.map((row) => row.has_claims));
}

/**
 * "Keyboards (tracks 01, 03, 05, 10)" es un claim y cuatro filas: el claim
 * guarda la FK de la primera y las otras tres quedan sin claim propio. Una
 * fila de pista sin claims hereda el origen de la hermana enlazada —mismo
 * disco, mismo acreditado, mismo rol—, que es de donde salió.
 */
export function inheritSiblingOrigin(credits: CreditRow[], hasClaims: boolean[]): CreditRow[] {
  const key = (credit: CreditRow) => `${credit.albumId}|${credit.target}|${credit.role.trim().toLowerCase()}`;
  const origin = new Map<string, CreditRow>();
  credits.forEach((credit, index) => {
    if (credit.kind === "track_credit" && hasClaims[index] && credit.fromChannel && !origin.has(key(credit))) origin.set(key(credit), credit);
  });
  return credits.map((credit, index) => {
    if (credit.kind !== "track_credit" || hasClaims[index]) return credit;
    const sibling = origin.get(key(credit));
    return sibling ? { ...credit, fromChannel: true, section: sibling.section } : credit;
  });
}

export interface ApplyResult { runs: number[]; retyped: number; retired: number; skipped: Array<{ change: PlannedChange; error: string }> }

/**
 * Aplica un plan en lotes, cada uno en su run de operador. Un cambio que la
 * vía auditada rechaza (la fila ya no existe, p. ej.) se anota y se sigue.
 */
export async function applyCreditSectionPlan(plan: PlannedChange[], options: { note: string; operator: string; batchSize?: number }): Promise<ApplyResult> {
  const result: ApplyResult = { runs: [], retyped: 0, retired: 0, skipped: [] };
  const size = options.batchSize ?? 250;
  for (let start = 0; start < plan.length; start += size) {
    const batch = plan.slice(start, start + size);
    const { runId } = await withOperatorRun(
      { name: "creditos-por-seccion", operator: options.operator, note: options.note, params: { from: start, count: batch.length } },
      async (context) => {
        for (const change of batch) {
          await context.client.query("SAVEPOINT credit_change");
          try {
            if (change.action === "retype") {
              await updateRelation({ ...context, note: `${options.note} — ${change.reason}` }, change.credit.kind, change.credit.id, { credit_type: change.to });
              result.retyped += 1;
            } else {
              await deleteRelation({ ...context, note: `${options.note} — ${change.reason}` }, change.credit.kind, change.credit.id);
              result.retired += 1;
            }
            await context.client.query("RELEASE SAVEPOINT credit_change");
          } catch (error) {
            await context.client.query("ROLLBACK TO SAVEPOINT credit_change");
            result.skipped.push({ change, error: error instanceof Error ? error.message : String(error) });
          }
        }
      },
    );
    result.runs.push(runId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fase MÚSICOS (Brian, 2026-09-22): disco por disco, sin pasar por el ER.
//
// El canal ya separa Musicians de Guest Musicians. Se leen esos dos bloques de
// la descripción y se comparan, por nombre normalizado, solo con las personas
// que ese disco ya acredita:
//  - quien está en Musicians es músico; cualquier otro músico del disco pasa a
//    invitado con su rol intacto;
//  - de los créditos repetidos de una persona se conserva el rol más completo
//    («Guitars» cae ante «Guitars & Backing Vocals»); roles distintos se
//    conservan los dos («Kid Voice» y «Backing Vocals»);
//  - un nombre del canal que el disco no tiene se busca por nombre o alias
//    exacto en el catálogo y, si no hay ninguno, se crea la persona.

export type ChannelSection = "musicians" | "guest_musicians";

export interface ChannelEntry { section: ChannelSection; role: string; name: string; trackNumbers: number[] }

export interface MusicianCredit {
  kind: CreditKind;
  id: number;
  creditType: CreditType;
  role: string;
  personId: number;
  personName: string;
  /** null en créditos de disco. */
  trackId: number | null;
  human: boolean;
}

export interface AlbumMusicianInput {
  albumId: number;
  /** El solista que firma el disco también es persona aunque sea artista. */
  artistName?: string;
  entries: ChannelEntry[];
  credits: MusicianCredit[];
  /** track_number → ids de pista (más de uno en discos dobles). */
  tracks: Map<number, number[]>;
}

/** Claves de nombre y alias de cada persona del catálogo. */
export interface PersonIndex {
  keysOf: Map<number, string[]>;
  byKey: Map<string, Set<number>>;
  /** Nombres de artistas y organizaciones: con ese nombre no se crea una persona. */
  nonPersonKeys: Set<string>;
}

// Conjuntos, no personas: se listan para revisión en vez de crearlos.
const ENSEMBLE = /\b(?:band|banda|orchestra|orquesta|ensemble|choir|coro|quartet|cuarteto|quintet|symphonic|sinf[oó]nica|friends|family)\b/iu;

function looksLikePerson(name: string, people: PersonIndex): boolean {
  const bare = name.replace(QUOTED, " ").trim();
  return bare.split(/\s+/u).length >= 2 && !/@/u.test(name) && !ENSEMBLE.test(name)
    && !nameKeys(name).some((key) => people.nonPersonKeys.has(key));
}

const nameTokens = (name: string) => new Set(normalizeEntityName(name.replace(QUOTED, " ")).secondaryKey.split(" ").filter(Boolean));

export type MusicianChange =
  | { action: "retype"; albumId: number; credit: MusicianCredit; to: CreditType; reason: string }
  | { action: "retire"; albumId: number; credit: MusicianCredit; reason: string }
  | { action: "add"; albumId: number; kind: CreditKind; trackId: number | null; personId: number | null; name: string;
      creditType: CreditType; role: string; reason: string }
  | { action: "review"; albumId: number; name: string; reason: string };

const QUOTED = /\s*["“”«»][^"“”«»]*["“”«»]\s*/gu;

export function nameKey(name: string): string {
  return normalizeEntityName(name).compactSecondaryKey;
}

/** Clave completa y, si lleva apodo entre comillas, también sin él. */
function nameKeys(name: string): string[] {
  const bare = name.replace(QUOTED, " ").trim();
  return [...new Set([nameKey(name), ...(bare && bare !== name.trim() ? [nameKey(bare)] : [])])].filter(Boolean);
}

/**
 * Variantes de apodo, solo para comparar dentro de un mismo disco:
 * `Carlos "Tato" Rodríguez` también es «Tato Rodríguez» y «Tato». Fuera del
 * disco un apodo suelto no alcanza para identificar a nadie.
 */
function nicknameKeys(name: string): string[] {
  const match = name.match(/^(.*?)\s*["“”«»]([^"“”«»]+)["“”«»]\s*(.*)$/u);
  if (!match) return [];
  const nick = match[2]!.trim();
  const surname = match[3]!.trim();
  return [nameKey(nick), ...(surname ? [nameKey(`${nick} ${surname}`)] : [])].filter(Boolean);
}

export function buildPersonIndex(people: Array<{ id: number; names: string[] }>, nonPersonNames: string[] = []): PersonIndex {
  const keysOf = new Map<number, string[]>();
  const byKey = new Map<string, Set<number>>();
  for (const person of people) {
    const keys = [...new Set(person.names.flatMap(nameKeys))];
    keysOf.set(person.id, keys);
    for (const key of keys) {
      const set = byKey.get(key) ?? new Set<number>();
      set.add(person.id);
      byKey.set(key, set);
    }
  }
  return { keysOf, byKey, nonPersonKeys: new Set(nonPersonNames.map(nameKey)) };
}

/** «Drums & Backing Vocals» → {drum, backing vocal}. El alcance entre paréntesis no es rol. */
export function roleParts(role: string): Set<string> {
  return new Set(removeDiacritics(role.toLowerCase()).replace(/\([^)]*\)/gu, " ")
    .split(/\s*(?:&|,|\/|\+|\band\b|\by\b)\s*/u)
    .map((part) => part.trim().split(/\s+/u).map((word) => word.replace(/s$/u, "")).join(" "))
    .filter(Boolean));
}

const isSubset = (small: Set<string>, big: Set<string>) => [...small].every((part) => big.has(part));

export function planMusicianSections(albums: AlbumMusicianInput[], people: PersonIndex): MusicianChange[] {
  const plan: MusicianChange[] = [];
  for (const album of albums) plan.push(...planAlbum(album, people));
  return plan;
}

function planAlbum(album: AlbumMusicianInput, people: PersonIndex): MusicianChange[] {
  const { albumId } = album;
  const inAlbum = new Map<string, Set<number>>();
  for (const credit of album.credits) {
    for (const key of [...(people.keysOf.get(credit.personId) ?? []), ...nicknameKeys(credit.personName)]) {
      const set = inAlbum.get(key) ?? new Set<number>();
      set.add(credit.personId);
      inAlbum.set(key, set);
    }
  }
  const matchIn = (index: Map<string, Set<number>>, name: string, keys = nameKeys(name)) => {
    const found = new Set<number>();
    for (const key of keys) for (const id of index.get(key) ?? []) found.add(id);
    return [...found];
  };

  type Resolved = { entry: ChannelEntry; personId: number | null; local: boolean };
  const resolved: Resolved[] = [];
  const review: MusicianChange[] = [];
  let musicianInReview = false;
  for (const entry of album.entries) {
    let local = matchIn(inAlbum, entry.name);
    if (local.length === 0) local = matchIn(inAlbum, entry.name, nicknameKeys(entry.name));
    if (local.length === 1) { resolved.push({ entry, personId: local[0]!, local: true }); continue; }
    const global = local.length > 1 ? local : matchIn(people.byKey, entry.name);
    if (global.length > 1) {
      review.push({ action: "review", albumId, name: entry.name,
        reason: local.length > 1 ? "varias personas del disco comparten el nombre" : `${global.length} personas del catálogo con ese nombre` });
      musicianInReview ||= entry.section === "musicians";
      continue;
    }
    if (global.length === 0 && album.artistName !== undefined && nameKey(album.artistName) === nameKey(entry.name)) {
      review.push({ action: "review", albumId, name: entry.name, reason: "es el nombre del artista del disco: no se crea como persona" });
      continue;
    }
    if (global.length === 0 && !looksLikePerson(entry.name, people)) {
      review.push({ action: "review", albumId, name: entry.name, reason: "no está en el catálogo y no parece una persona: no se crea" });
      continue;
    }
    resolved.push({ entry, personId: global[0] ?? null, local: false });
  }

  const musicians = resolved.filter((item) => item.entry.section === "musicians");
  // Si ningún músico del canal está en el disco pero el disco sí tiene músicos,
  // lo más probable es que el video no sea de este disco: no se toca.
  const hasMusicians = album.credits.some((credit) => credit.creditType === "musician");
  if (musicians.length === 0 || musicianInReview || (hasMusicians && !musicians.some((item) => item.local))) {
    return [{ action: "review", albumId, name: "", reason: "el bloque Musicians no casa con los músicos del disco: disco sin tocar" }];
  }
  const principals = new Set(musicians.flatMap((item) => (item.personId === null ? [] : [item.personId])));

  const plan: MusicianChange[] = [...review];
  // «Eleasar» y «Yánez» sueltos en el catálogo son pedazos de «Eleasar Yánez»
  // del canal, no otros músicos: no se bajan a invitado, se listan.
  // Lo mismo con el apodo: «Alz» suelto es `Alejandro Estrada "Alz"` duplicado.
  const channelMusicians = album.entries.filter((entry) => entry.section === "musicians");
  const musicianTokens = channelMusicians.map((entry) => nameTokens(entry.name));
  const musicianNicknames = new Set(channelMusicians.flatMap((entry) => nicknameKeys(entry.name)));
  const personNames = new Map(album.credits.map((credit) => [credit.personId, credit.personName]));
  const partOfUnmatched = (personId: number) => {
    const name = personNames.get(personId) ?? "";
    const tokens = nameTokens(name);
    return (tokens.size > 0 && musicianTokens.some((entry) => isSubset(tokens, entry)))
      || nameKeys(name).some((key) => musicianNicknames.has(key));
  };
  const finalType = new Map<MusicianCredit, CreditType>();
  const flagged = new Set<number>();
  for (const credit of album.credits) {
    let type = credit.creditType;
    if (!credit.human && credit.creditType === "musician" && !principals.has(credit.personId) && partOfUnmatched(credit.personId)) {
      if (!flagged.has(credit.personId)) {
        flagged.add(credit.personId);
        plan.push({ action: "review", albumId, name: credit.personName,
          reason: "parece un duplicado de un músico del canal (pedazo del nombre o apodo): no se baja a invitado" });
      }
    } else if (!credit.human && credit.creditType === "musician" && !principals.has(credit.personId)) {
      type = "guest";
      plan.push({ action: "retype", albumId, credit, to: "guest", reason: "no está en el bloque Musicians del canal: pasa a invitado" });
    }
    finalType.set(credit, type);
  }

  type Item = { credit?: MusicianCredit; parts: Set<string>; human: boolean; id: number; scope: string };
  const scopeOf = (kind: CreditKind, trackId: number | null, personId: number, type: CreditType) => `${kind}|${trackId ?? "album"}|${personId}|${type}`;
  const items: Item[] = album.credits.map((credit) => ({
    credit, parts: roleParts(credit.role), human: credit.human, id: credit.id,
    scope: scopeOf(credit.kind, credit.trackId, credit.personId, finalType.get(credit)!),
  }));

  // Lo que el canal dice y el disco no tiene: se agrega.
  let virtualId = 0;
  const planned: Array<{ personId: number; trackId: number | null; parts: Set<string> }> = [];
  const covers = (personId: number, trackId: number | null, parts: Set<string>) =>
    album.credits.some((credit) => credit.personId === personId && (credit.trackId === trackId || credit.trackId === null)
      && isSubset(parts, roleParts(credit.role)))
    || planned.some((add) => add.personId === personId && (add.trackId === trackId || add.trackId === null) && isSubset(parts, add.parts));
  const newPeople = new Map<string, Array<{ trackId: number | null; parts: Set<string> }>>();
  for (const { entry, personId } of resolved) {
    const type: CreditType = entry.section === "musicians" ? "musician" : "guest";
    const parts = roleParts(entry.role);
    if (parts.size === 0) continue;
    const trackIds = entry.trackNumbers.flatMap((n) => {
      const ids = album.tracks.get(n) ?? [];
      return ids.length === 1 ? ids : [];
    });
    const scoped = entry.trackNumbers.length > 0 && trackIds.length === entry.trackNumbers.length;
    const targets: Array<number | null> = scoped ? trackIds : [null];
    for (const trackId of targets) {
      if (personId !== null && covers(personId, trackId, parts)) continue;
      if (personId === null) {
        const seen = newPeople.get(nameKey(entry.name)) ?? [];
        if (seen.some((add) => (add.trackId === trackId || add.trackId === null) && isSubset(parts, add.parts))) continue;
        newPeople.set(nameKey(entry.name), [...seen, { trackId, parts }]);
      } else {
        planned.push({ personId, trackId, parts });
      }
      const kind: CreditKind = trackId === null ? "album_credit" : "track_credit";
      const reason = personId === null ? "el canal lo acredita y no está en el catálogo: persona nueva"
        : "el canal lo acredita y el disco no lo tenía";
      plan.push({ action: "add", albumId, kind, trackId, personId, name: entry.name, creditType: type, role: entry.role, reason });
      if (personId !== null) items.push({ parts, human: true, id: --virtualId, scope: scopeOf(kind, trackId, personId, type) });
    }
  }

  // Repetidos: dentro de la misma persona, alcance y tipo, cae el rol contenido en otro.
  const byScope = new Map<string, Item[]>();
  for (const item of items) byScope.set(item.scope, [...(byScope.get(item.scope) ?? []), item]);
  for (const group of byScope.values()) {
    for (const item of group) {
      if (!item.credit || item.human) continue;
      const keeper = group.find((other) => other !== item && isSubset(item.parts, other.parts)
        && (other.parts.size > item.parts.size || other.human || other.id < item.id));
      if (!keeper) continue;
      const retyped = plan.findIndex((change) => change.action === "retype" && change.credit === item.credit);
      if (retyped >= 0) plan.splice(retyped, 1);
      plan.push({ action: "retire", albumId, credit: item.credit, reason: "repite un rol que otro crédito de la misma persona ya incluye" });
    }
  }
  return plan;
}

/** Discos con bloque Musicians en su video, con los créditos de músico e invitado a persona. */
export async function readMusicianSectionInputs(client: PoolClient): Promise<{ albums: AlbumMusicianInput[]; people: PersonIndex }> {
  const sections = await client.query<{ album_id: string; section_kind: string; heading: string; content: string; position: number }>(`
    WITH chosen AS (
      SELECT DISTINCT ON (va.album_id) va.album_id, va.video_id
        FROM media.video_albums va
       WHERE EXISTS (SELECT 1 FROM media.youtube_description_sections s WHERE s.video_id = va.video_id AND s.section_kind = 'musicians')
       ORDER BY va.album_id, va.is_primary_link DESC, va.video_id)
    SELECT c.album_id::text, s.section_kind, s.heading, s.content, s.position
      FROM chosen c JOIN media.youtube_description_sections s ON s.video_id = c.video_id
     WHERE s.section_kind IN ('musicians', 'guest_musicians')
     ORDER BY c.album_id, s.position`);
  const albumIds = [...new Set(sections.rows.map((row) => Number(row.album_id)))];
  const credits = await client.query<{ kind: CreditKind; id: string; album_id: string; credit_type: CreditType; role: string; person_id: string; person_name: string; track_id: string | null; human: boolean }>(`
    WITH c AS (
      SELECT 'album_credit'::text AS kind, ac.id, ac.album_id, ac.credit_type, ac.role, ac.person_id, NULL::bigint AS track_id
        FROM public.album_credits ac WHERE ac.album_id = ANY($1::bigint[])
      UNION ALL
      SELECT 'track_credit', tc.id, t.album_id, tc.credit_type, tc.role, tc.person_id, tc.track_id
        FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id WHERE t.album_id = ANY($1::bigint[]))
    SELECT c.kind, c.id::text, c.album_id::text, c.credit_type::text AS credit_type, coalesce(c.role, '') AS role,
           c.person_id::text, (SELECT p.name FROM public.persons p WHERE p.id = c.person_id) AS person_name, c.track_id::text,
           CASE WHEN c.kind = 'album_credit'
                THEN EXISTS (SELECT 1 FROM ingest.claims cl WHERE cl.album_credit_id = c.id AND cl.created_by = 'human')
                ELSE EXISTS (SELECT 1 FROM ingest.claims cl WHERE cl.track_credit_id = c.id AND cl.created_by = 'human')
           END AS human
      FROM c WHERE c.person_id IS NOT NULL AND c.credit_type IN ('musician', 'guest')`, [albumIds]);
  const tracks = await client.query<{ id: string; album_id: string; track_number: number }>(
    "SELECT id::text, album_id::text, track_number FROM public.tracks WHERE album_id = ANY($1::bigint[])", [albumIds]);
  const persons = await client.query<{ id: string; names: string[] }>(`
    SELECT p.id::text, array_remove(array_agg(DISTINCT x.alias) || ARRAY[p.name], NULL) AS names
      FROM public.persons p LEFT JOIN ingest.person_aliases x ON x.person_id = p.id GROUP BY p.id`);

  const byAlbum = new Map<number, AlbumMusicianInput>();
  const albumOf = (id: number) => {
    let album = byAlbum.get(id);
    if (!album) { album = { albumId: id, entries: [], credits: [], tracks: new Map() }; byAlbum.set(id, album); }
    return album;
  };
  const grouped = new Map<number, typeof sections.rows>();
  for (const row of sections.rows) grouped.set(Number(row.album_id), [...(grouped.get(Number(row.album_id)) ?? []), row]);
  for (const [albumId, rows] of grouped) {
    const parsed = parseCreditSections(rows.map((row) => ({ kind: row.section_kind, heading: row.heading, content: row.content, position: row.position })));
    albumOf(albumId).entries = parsed.map((credit) => ({
      section: credit.sectionKind as ChannelSection, role: credit.role, name: credit.name, trackNumbers: credit.trackNumbers,
    }));
  }
  for (const row of credits.rows) {
    albumOf(Number(row.album_id)).credits.push({
      kind: row.kind, id: Number(row.id), creditType: row.credit_type, role: row.role, personId: Number(row.person_id), personName: row.person_name,
      trackId: row.track_id === null ? null : Number(row.track_id), human: row.human,
    });
  }
  for (const row of tracks.rows) {
    const album = albumOf(Number(row.album_id));
    album.tracks.set(row.track_number, [...(album.tracks.get(row.track_number) ?? []), Number(row.id)]);
  }
  const artists = await client.query<{ id: string; name: string }>(
    "SELECT al.id::text, ar.name FROM public.albums al JOIN public.artists ar ON ar.id = al.artist_id WHERE al.id = ANY($1::bigint[])", [albumIds]);
  for (const row of artists.rows) albumOf(Number(row.id)).artistName = row.name;
  const others = await client.query<{ name: string }>("SELECT name FROM public.artists UNION SELECT name FROM public.organizations");
  const people = buildPersonIndex(persons.rows.map((row) => ({ id: Number(row.id), names: row.names })), others.rows.map((row) => row.name));
  return { albums: [...byAlbum.values()], people };
}

export interface MusicianApplyResult { runs: number[]; retyped: number; retired: number; added: number; personsCreated: number; skipped: Array<{ change: MusicianChange; error: string }> }

/** Aplica el plan por lotes de discos, cada lote en su run de operador. */
export async function applyMusicianPlan(plan: MusicianChange[], options: { note: string; operator: string; albumsPerRun?: number }): Promise<MusicianApplyResult> {
  const result: MusicianApplyResult = { runs: [], retyped: 0, retired: 0, added: 0, personsCreated: 0, skipped: [] };
  const writable = plan.filter((change) => change.action !== "review");
  const albums = [...new Set(writable.map((change) => change.albumId))];
  const size = options.albumsPerRun ?? 50;
  // Una persona nueva que aparece en varios discos se crea una sola vez.
  const created = new Map<string, number>();
  for (let start = 0; start < albums.length; start += size) {
    const chunk = new Set(albums.slice(start, start + size));
    const batch = writable.filter((change) => chunk.has(change.albumId));
    const { runId } = await withOperatorRun(
      { name: "musicos-por-seccion", operator: options.operator, note: options.note, params: { albums: [...chunk] } },
      async (context) => {
        for (const change of batch) {
          const note = `${options.note} — ${change.reason}`;
          await context.client.query("SAVEPOINT musician_change");
          try {
            if (change.action === "retype") {
              await updateRelation({ ...context, note }, change.credit.kind, change.credit.id, { credit_type: change.to });
              result.retyped += 1;
            } else if (change.action === "retire") {
              await deleteRelation({ ...context, note }, change.credit.kind, change.credit.id);
              result.retired += 1;
            } else if (change.action === "add") {
              let personId = change.personId ?? created.get(nameKey(change.name));
              if (personId === undefined) {
                personId = (await createEntity({ ...context, note }, "person", { name: change.name }, { allowSimilar: true })).id;
                created.set(nameKey(change.name), personId);
                result.personsCreated += 1;
              }
              const endpoints = change.trackId === null ? { albumId: change.albumId, personId } : { trackId: change.trackId, personId };
              await createRelation({ ...context, note }, change.kind, endpoints, { credit_type: change.creditType, credit_role: change.role });
              result.added += 1;
            }
            await context.client.query("RELEASE SAVEPOINT musician_change");
          } catch (error) {
            await context.client.query("ROLLBACK TO SAVEPOINT musician_change");
            result.skipped.push({ change, error: error instanceof Error ? error.message : String(error) });
          }
        }
      },
    );
    result.runs.push(runId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fase OTROS CRÉDITOS (Brian, 2026-09-22): producción, grabación, mezcla,
// composición, letra y arte del canal, disco por disco y sin ER, con las mismas
// reglas que la de músicos:
//  - cada crédito del canal se casa con quien el disco ya acredita (persona,
//    organización o la banda); si no, por nombre o alias exacto en el catálogo;
//  - se agrega solo lo que el disco no tiene (mismo acreditado, tipo y alcance,
//    con un rol que ya lo incluya);
//  - solo se retira lo repetido: mismo acreditado y tipo, rol contenido en otro
//    («mixed» cae ante «Recorded & Mixed by»). Lo que el canal no menciona se
//    queda;
//  - una persona sin coincidencia se crea; un estudio o sello sin coincidencia
//    se lista, no se inventa.

export type TargetKind = "person" | "organization" | "artist";

export interface OtherCredit {
  kind: CreditKind;
  id: number;
  creditType: CreditType;
  role: string;
  target: { kind: TargetKind; id: number; name: string };
  trackId: number | null;
  human: boolean;
}

export interface ChannelFact {
  name: string;
  targetKind: "person" | "organization";
  creditType: CreditType;
  role: string;
  trackNumbers: number[];
}

export interface AlbumOtherInput {
  albumId: number;
  artist: { id: number; name: string };
  facts: ChannelFact[];
  credits: OtherCredit[];
  tracks: Map<number, number[]>;
}

export interface CatalogIndex {
  person: PersonIndex;
  organization: Map<string, Set<number>>;
}

export type OtherChange =
  | { action: "retire"; albumId: number; credit: OtherCredit; reason: string }
  | { action: "add"; albumId: number; kind: CreditKind; trackId: number | null;
      target: { kind: TargetKind; id: number | null; name: string }; creditType: CreditType; role: string; reason: string }
  | { action: "review"; albumId: number; name: string; reason: string };

/** Partes del rol sin la preposición final ni el alcance: «Track 8 Recorded & Mixed by» → {recorded, mixed}. */
export function creditRoleParts(role: string): Set<string> {
  const clean = role.replace(/^\s*(?:all\s+)?(?:tracks?|pistas?)\s+[\d\s,&y-]+/iu, " ")
    .replace(/\s+(?:by|at|por|en)\s*:?\s*$/iu, "");
  return roleParts(clean);
}

/** Hechos del canal que no son músicos, con la misma partición que emite `api-claims`. */
export function channelFacts(description: string): ChannelFact[] {
  const parsed = parseYouTubeDescription(description);
  const facts: ChannelFact[] = [];
  for (const credit of parsed.credits) {
    const roles = new Map<string, string[]>();
    for (const verb of credit.verbs) {
      const type = creditTypeForRole(verb);
      const group = isRoleAgnosticCreditType(type) ? type : `verb:${verb}`;
      roles.set(group, [...(roles.get(group) ?? []), verb]);
    }
    for (const verbs of roles.values()) {
      const role = verbs.join(" & ");
      const creditType = creditTypeForRole(role);
      if (creditType === "musician") continue;
      for (const name of credit.names) {
        facts.push({ name, targetKind: looksLikeOrganization(name) ? "organization" : "person", creditType, role, trackNumbers: credit.trackNumbers });
      }
      if (credit.venue) facts.push({ name: credit.venue, targetKind: "organization", creditType, role: `${role} at`, trackNumbers: credit.trackNumbers });
    }
  }
  for (const credit of parseCreditSections(parsed.sections)) {
    if (credit.sectionKind === "musicians" || credit.sectionKind === "guest_musicians") continue;
    const creditType = creditTypeForRole(credit.role);
    facts.push({ name: credit.name, targetKind: looksLikeOrganization(credit.name) ? "organization" : "person",
      creditType: creditType === "musician" || creditType === "other" ? "artwork" : creditType, role: credit.role, trackNumbers: credit.trackNumbers });
  }
  return facts;
}

export function planOtherCredits(albums: AlbumOtherInput[], catalog: CatalogIndex): OtherChange[] {
  return albums.flatMap((album) => planOtherAlbum(album, catalog));
}

function planOtherAlbum(album: AlbumOtherInput, catalog: CatalogIndex): OtherChange[] {
  const { albumId } = album;
  const plan: OtherChange[] = [];
  const targetKey = (kind: TargetKind, id: number) => `${kind}:${id}`;
  const inAlbum = new Map<string, Set<string>>();
  for (const credit of album.credits) {
    const keys = credit.target.kind === "person" ? catalog.person.keysOf.get(credit.target.id) ?? nameKeys(credit.target.name) : nameKeys(credit.target.name);
    for (const key of keys) {
      const set = inAlbum.get(key) ?? new Set<string>();
      set.add(targetKey(credit.target.kind, credit.target.id));
      inAlbum.set(key, set);
    }
  }
  const names = new Map(album.credits.map((credit) => [targetKey(credit.target.kind, credit.target.id), credit.target.name]));

  type Resolved = { fact: ChannelFact; target: { kind: TargetKind; id: number | null; name: string } };
  const resolved: Resolved[] = [];
  for (const fact of album.facts) {
    if (nameKey(fact.name) === nameKey(album.artist.name)) {
      resolved.push({ fact, target: { kind: "artist", id: album.artist.id, name: album.artist.name } });
      continue;
    }
    // Un estudio casa con organizaciones y una persona con personas: el disco
    // puede tener «Grabaciones K-Pella» cargado de las dos formas.
    const local = [...new Set(nameKeys(fact.name).flatMap((key) => [...(inAlbum.get(key) ?? [])]))]
      .filter((target) => target.startsWith(`${fact.targetKind}:`) || target.startsWith("artist:"));
    if (local.length === 1) {
      const [kind, id] = local[0]!.split(":") as [TargetKind, string];
      resolved.push({ fact, target: { kind, id: Number(id), name: names.get(local[0]!) ?? fact.name } });
      continue;
    }
    if (local.length > 1) { plan.push({ action: "review", albumId, name: fact.name, reason: "varios acreditados del disco comparten el nombre" }); continue; }
    const index = fact.targetKind === "person" ? catalog.person.byKey : catalog.organization;
    const global = [...new Set(nameKeys(fact.name).flatMap((key) => [...(index.get(key) ?? [])]))];
    if (global.length > 1) { plan.push({ action: "review", albumId, name: fact.name, reason: `${global.length} ${fact.targetKind === "person" ? "personas" : "organizaciones"} del catálogo con ese nombre` }); continue; }
    if (global.length === 1) { resolved.push({ fact, target: { kind: fact.targetKind, id: global[0]!, name: fact.name } }); continue; }
    if (fact.targetKind === "organization") { plan.push({ action: "review", albumId, name: fact.name, reason: "estudio o sello que no está en el catálogo: no se crea" }); continue; }
    if (!looksLikePerson(fact.name, catalog.person)) { plan.push({ action: "review", albumId, name: fact.name, reason: "no está en el catálogo y no parece una persona: no se crea" }); continue; }
    resolved.push({ fact, target: { kind: "person", id: null, name: fact.name } });
  }

  type Item = { credit?: OtherCredit; parts: Set<string>; keep: boolean; id: number; scope: string };
  const scopeOf = (kind: CreditKind, trackId: number | null, target: string, type: CreditType) => `${kind}|${trackId ?? "album"}|${target}|${type}`;
  const items: Item[] = album.credits.map((credit) => ({
    credit, parts: creditRoleParts(credit.role), keep: credit.human, id: credit.id,
    scope: scopeOf(credit.kind, credit.trackId, targetKey(credit.target.kind, credit.target.id), credit.creditType),
  }));
  const partsFor = (type: CreditType, role: string) => (isRoleAgnosticCreditType(type) ? new Set([type]) : creditRoleParts(role));
  const holds = (target: string, type: CreditType, trackId: number | null, parts: Set<string>) => items.some((item) => {
    const [, track, who, itemType] = item.scope.split("|");
    return who === target && itemType === type && (track === "album" || track === String(trackId))
      && (isRoleAgnosticCreditType(type) || isSubset(parts, item.parts));
  });

  let virtualId = 0;
  const newPeople = new Map<string, Set<string>>();
  for (const { fact, target } of resolved) {
    const parts = partsFor(fact.creditType, fact.role);
    if (parts.size === 0) continue;
    const trackIds = fact.trackNumbers.flatMap((n) => {
      const ids = album.tracks.get(n) ?? [];
      return ids.length === 1 ? ids : [];
    });
    const scoped = fact.trackNumbers.length > 0 && trackIds.length === fact.trackNumbers.length;
    for (const trackId of scoped ? trackIds : [null]) {
      const kind: CreditKind = trackId === null ? "album_credit" : "track_credit";
      if (target.id === null) {
        const seen = newPeople.get(nameKey(target.name)) ?? new Set<string>();
        const key = `${trackId}|${fact.creditType}|${[...parts].sort().join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        newPeople.set(nameKey(target.name), seen);
      } else {
        const who = targetKey(target.kind, target.id);
        if (holds(who, fact.creditType, trackId, parts)) continue;
        items.push({ parts, keep: true, id: --virtualId, scope: scopeOf(kind, trackId, who, fact.creditType) });
      }
      plan.push({ action: "add", albumId, kind, trackId, target, creditType: fact.creditType, role: fact.role,
        reason: target.id === null ? "el canal lo acredita y no está en el catálogo: persona nueva" : "el canal lo acredita y el disco no lo tenía" });
    }
  }

  // Solo en quien el canal acredita en este disco: lo demás no se toca.
  const channelTargets = new Set(resolved.flatMap(({ target }) => (target.id === null ? [] : [targetKey(target.kind, target.id)])));
  const byScope = new Map<string, Item[]>();
  for (const item of items) byScope.set(item.scope, [...(byScope.get(item.scope) ?? []), item]);
  for (const group of byScope.values()) {
    for (const item of group) {
      if (!item.credit || item.keep) continue;
      if (!channelTargets.has(targetKey(item.credit.target.kind, item.credit.target.id))) continue;
      if (isRoleAgnosticCreditType(item.credit.creditType)) {
        if (group.some((other) => other !== item && (other.keep || other.id < item.id))) {
          plan.push({ action: "retire", albumId, credit: item.credit, reason: "crédito repetido del mismo acreditado y tipo" });
        }
        continue;
      }
      const keeper = group.find((other) => other !== item && isSubset(item.parts, other.parts)
        && (other.parts.size > item.parts.size || other.keep || other.id < item.id));
      if (keeper) plan.push({ action: "retire", albumId, credit: item.credit, reason: "repite un rol que otro crédito del mismo acreditado ya incluye" });
    }
  }
  return plan;
}

/** Discos con video del canal: su descripción y sus créditos que no son de músico. */
export async function readOtherCreditInputs(client: PoolClient): Promise<{ albums: AlbumOtherInput[]; catalog: CatalogIndex }> {
  const videos = await client.query<{ album_id: string; artist_id: string; artist_name: string; description: string | null }>(`
    SELECT DISTINCT ON (va.album_id) va.album_id::text, ar.id::text AS artist_id, ar.name AS artist_name,
           coalesce(v.metadata->'snippet'->>'description', v.description) AS description
      FROM media.video_albums va
      JOIN media.youtube_videos v ON v.id = va.video_id
      JOIN public.albums al ON al.id = va.album_id JOIN public.artists ar ON ar.id = al.artist_id
     ORDER BY va.album_id, va.is_primary_link DESC, va.video_id`);
  const albumIds = videos.rows.map((row) => Number(row.album_id));
  const credits = await client.query<{ kind: CreditKind; id: string; album_id: string; credit_type: CreditType; role: string;
    target_kind: TargetKind; target_id: string; target_name: string; track_id: string | null; human: boolean }>(`
    WITH c AS (
      SELECT 'album_credit'::text AS kind, ac.id, ac.album_id, ac.credit_type, ac.role, ac.person_id, ac.organization_id, ac.artist_id, NULL::bigint AS track_id
        FROM public.album_credits ac WHERE ac.album_id = ANY($1::bigint[])
      UNION ALL
      SELECT 'track_credit', tc.id, t.album_id, tc.credit_type, tc.role, tc.person_id, tc.organization_id, tc.artist_id, tc.track_id
        FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id WHERE t.album_id = ANY($1::bigint[]))
    SELECT c.kind, c.id::text, c.album_id::text, c.credit_type::text AS credit_type, coalesce(c.role, '') AS role,
           CASE WHEN c.person_id IS NOT NULL THEN 'person' WHEN c.organization_id IS NOT NULL THEN 'organization' ELSE 'artist' END AS target_kind,
           coalesce(c.person_id, c.organization_id, c.artist_id)::text AS target_id,
           coalesce(p.name, o.name, a.name) AS target_name, c.track_id::text,
           CASE WHEN c.kind = 'album_credit'
                THEN EXISTS (SELECT 1 FROM ingest.claims cl WHERE cl.album_credit_id = c.id AND cl.created_by = 'human')
                ELSE EXISTS (SELECT 1 FROM ingest.claims cl WHERE cl.track_credit_id = c.id AND cl.created_by = 'human')
           END AS human
      FROM c LEFT JOIN public.persons p ON p.id = c.person_id LEFT JOIN public.organizations o ON o.id = c.organization_id
             LEFT JOIN public.artists a ON a.id = c.artist_id
     WHERE c.credit_type NOT IN ('musician', 'guest')`, [albumIds]);
  const tracks = await client.query<{ id: string; album_id: string; track_number: number }>(
    "SELECT id::text, album_id::text, track_number FROM public.tracks WHERE album_id = ANY($1::bigint[])", [albumIds]);
  const persons = await client.query<{ id: string; names: string[] }>(`
    SELECT p.id::text, array_remove(array_agg(DISTINCT x.alias) || ARRAY[p.name], NULL) AS names
      FROM public.persons p LEFT JOIN ingest.person_aliases x ON x.person_id = p.id GROUP BY p.id`);
  const organizations = await client.query<{ id: string; names: string[] }>(`
    SELECT o.id::text, array_remove(array_agg(DISTINCT x.alias) || ARRAY[o.name], NULL) AS names
      FROM public.organizations o LEFT JOIN ingest.organization_aliases x ON x.organization_id = o.id GROUP BY o.id`);
  const artists = await client.query<{ name: string }>("SELECT name FROM public.artists UNION SELECT name FROM public.organizations");

  const byAlbum = new Map<number, AlbumOtherInput>();
  for (const row of videos.rows) {
    byAlbum.set(Number(row.album_id), {
      albumId: Number(row.album_id), artist: { id: Number(row.artist_id), name: row.artist_name },
      facts: row.description ? channelFacts(row.description) : [], credits: [], tracks: new Map(),
    });
  }
  for (const row of credits.rows) {
    byAlbum.get(Number(row.album_id))?.credits.push({
      kind: row.kind, id: Number(row.id), creditType: row.credit_type, role: row.role,
      target: { kind: row.target_kind, id: Number(row.target_id), name: row.target_name },
      trackId: row.track_id === null ? null : Number(row.track_id), human: row.human,
    });
  }
  for (const row of tracks.rows) {
    const album = byAlbum.get(Number(row.album_id));
    if (album) album.tracks.set(row.track_number, [...(album.tracks.get(row.track_number) ?? []), Number(row.id)]);
  }
  const organization = new Map<string, Set<number>>();
  for (const row of organizations.rows) {
    for (const key of new Set(row.names.flatMap(nameKeys))) {
      const set = organization.get(key) ?? new Set<number>();
      set.add(Number(row.id));
      organization.set(key, set);
    }
  }
  const person = buildPersonIndex(persons.rows.map((row) => ({ id: Number(row.id), names: row.names })), artists.rows.map((row) => row.name));
  return { albums: [...byAlbum.values()].filter((album) => album.facts.length > 0), catalog: { person, organization } };
}

export interface OtherApplyResult { runs: number[]; retired: number; added: number; personsCreated: number; skipped: Array<{ change: OtherChange; error: string }> }

export async function applyOtherPlan(plan: OtherChange[], options: { note: string; operator: string; albumsPerRun?: number }): Promise<OtherApplyResult> {
  const result: OtherApplyResult = { runs: [], retired: 0, added: 0, personsCreated: 0, skipped: [] };
  const writable = plan.filter((change) => change.action !== "review");
  const albums = [...new Set(writable.map((change) => change.albumId))];
  const size = options.albumsPerRun ?? 50;
  const created = new Map<string, number>();
  for (let start = 0; start < albums.length; start += size) {
    const chunk = new Set(albums.slice(start, start + size));
    const batch = writable.filter((change) => chunk.has(change.albumId));
    const { runId } = await withOperatorRun(
      { name: "otros-creditos-por-canal", operator: options.operator, note: options.note, params: { albums: [...chunk] } },
      async (context) => {
        for (const change of batch) {
          const note = `${options.note} — ${change.reason}`;
          await context.client.query("SAVEPOINT other_change");
          try {
            if (change.action === "retire") {
              await deleteRelation({ ...context, note }, change.credit.kind, change.credit.id);
              result.retired += 1;
            } else if (change.action === "add") {
              let id = change.target.id ?? created.get(nameKey(change.target.name));
              if (id === undefined) {
                id = (await createEntity({ ...context, note }, "person", { name: change.target.name }, { allowSimilar: true })).id;
                created.set(nameKey(change.target.name), id);
                result.personsCreated += 1;
              }
              const who = change.target.kind === "person" ? { personId: id } : change.target.kind === "organization" ? { organizationId: id } : { artistId: id };
              const endpoints = change.trackId === null ? { albumId: change.albumId, ...who } : { trackId: change.trackId, ...who };
              await createRelation({ ...context, note }, change.kind, endpoints, { credit_type: change.creditType, credit_role: change.role });
              result.added += 1;
            }
            await context.client.query("RELEASE SAVEPOINT other_change");
          } catch (error) {
            await context.client.query("ROLLBACK TO SAVEPOINT other_change");
            result.skipped.push({ change, error: error instanceof Error ? error.message : String(error) });
          }
        }
      },
    );
    result.runs.push(runId);
  }
  return result;
}
