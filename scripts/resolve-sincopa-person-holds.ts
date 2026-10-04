// Personas de Sincopa que la promoción masiva retuvo (`no-es-una-persona:*`),
// con las decisiones de Brian (2026-10-03) y el precedente de la cola de
// revisión (2026-09-15: estudios acreditados como personas → organizaciones):
//
//  * convertir: estudios, sellos y productoras pasan a organización; las
//    agrupaciones (cuartetos, coros, orquestas) a artista; teatros, salas,
//    festivales e instituciones a organización «other». El claim de persona se
//    rechaza (no es una persona) y el crédito lo resuelve el puente en la
//    siguiente pasada: busca persona, organización y artista por ese orden.
//  * rotulo: «feat. X», «Arr: X», «X (track», «X version» → el rótulo pasa a
//    rol y el nombre limpio se enlaza a la única persona igual del core o se
//    crea. Lo que no deja nombre («Radio Version», «Instrumental») se rechaza.
//  * lista: «A, B & C», «A - B» se parten y cada parte sigue las mismas reglas.
//    Iniciales y apellidos sueltos no entran sin enlace seguro (tramos C y D).
//  * rechazar: lo que solo llega como paréntesis de un título y el texto suelto
//    (URLs, correos, «his home»): ni persona ni crédito.
//  * truncado: «aúl Monsalve» (la ficha perdió la primera letra) se enlaza solo
//    si un único nombre del core lo completa con una o dos letras.
//
// Los créditos de rótulos y listas se crean como relaciones del operador sobre
// la pista o el disco que ya está en el core; los claims del crédito quedan
// `superseded` con la referencia. Sin pista o disco en el core, la ficha espera.
//
//   tsx scripts/resolve-sincopa-person-holds.ts <ensayos.json…> --out=…json             # ensayo
//   tsx scripts/resolve-sincopa-person-holds.ts <ensayos.json…> --confirm --note="…" --out=…json
//   tsx scripts/resolve-sincopa-person-holds.ts --place-converted=reports/…json [--confirm --note="…"]   # créditos de lo convertido
//   tsx scripts/resolve-sincopa-person-holds.ts --repair-artist-runs=11665,11667 [--confirm]   # créditos de un solista a su persona
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { createEntity, createRelation, updateRelation, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";
import { creditTypeForSection } from "../src/merge/relations.js";
import { classifyPersonName } from "../src/review/person-junk.js";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
export const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

type Role = { creditType: string; role: string };
type Target = { kind: "person" | "organization" | "artist"; name: string; organizationType?: string };

// Rótulos al principio del nombre (los de scripts/cleanup-sincopa-junk-persons.ts).
const PREFIXES: Array<{ re: RegExp; role: Role }> = [
  { re: /^(?:featuring|feat|ft)\.?\s+(.+)$/iu, role: { creditType: "guest", role: "Invitado" } },
  { re: /^(?:with)\s+(.+)$/iu, role: { creditType: "guest", role: "Invitado" } },
  { re: /^(?:arreglos?|arr)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Arreglos" } },
  { re: /^comp\s*[.:]\s*(.+)$/iu, role: { creditType: "composer", role: "composer" } },
  { re: /^(?:recopilaci[oó]n|compilaci[oó]n|compilation|recop|recp|rec)\s*[.:]\s*(?:de\s+)?(.+)$/iu, role: { creditType: "other", role: "Recopilación" } },
  { re: /^(?:recopilaci[oó]n|compilaci[oó]n|recopilado por)\s+(?:de\s+)?(\p{Lu}.+)$/iu, role: { creditType: "other", role: "Recopilación" } },
  { re: /^(?:lyrics|letra|words|l)\s*:\s*(.+)$/iu, role: { creditType: "writer", role: "Letra" } },
  { re: /^(?:m[uú]sica|music|m)\s*:\s*(.+)$/iu, role: { creditType: "composer", role: "composer" } },
  { re: /^(?:adaptaci[oó]n|adapt|adpt)\s*[.:]\s*(.+)$/iu, role: { creditType: "other", role: "Adaptación" } },
  { re: /^rap\s*:\s*(.+)$/iu, role: { creditType: "guest", role: "Rap" } },
  // «Ver. Helcio Do Carmo», «Vers. Esp. P. Medeiros», «Version Esp: Norma Madrid».
  { re: /^(?:ver|vers|versi[oó]n)\.?\s*(?:esp\.?|en espa[nñ]ol)?\s*:?\s+(\p{Lu}.+)$/iu, role: { creditType: "other", role: "Versión" } },
];
// Rótulos al final: «Julio Mendoza (track», «Edgar Macias version», «Adrian Holtz's Remix».
const SUFFIXES: Array<{ re: RegExp; role?: Role }> = [
  { re: /^(.+?)\s*\(tracks?\b.*$/iu },
  { re: /^(.+?)(?:'s)?\s+(?:radio|club|extended)\s+(?:re)?(?:mix|edit)$/iu, role: { creditType: "other", role: "Remezcla" } },
  { re: /^(.+?)(?:'s)?\s+(?:re)?mix$/iu, role: { creditType: "other", role: "Remezcla" } },
  { re: /^(.+?)\s+versi[oó]n$/iu, role: { creditType: "other", role: "Versión" } },
  { re: /^(.+?)\s+version$/iu, role: { creditType: "other", role: "Versión" } },
];

const ORG_COMPANY = /\b(s\.?\s?a\.?|c\.?\s?a\.?|inc\.?|corp\.?|corporaci[oó]n|ltd\.?|llc|gmbh)$|\b(corporaci[oó]n|corporation|company|compa[nñ][ií]a|design|dise[nñ]o|graphics?|gr[aá]fic[ao]s?|creativ[ae]|media|films?|agency|agencia|editorial|ediciones|publishing)\b/iu;
/** «X y Su Orquesta», «X y Sus Vampiros»: una agrupación con nombre propio. */
const WITH_HIS_BAND = /\s+(?:y|and|&)\s+(?:sus?\s+\p{L}|(?:orquesta|conjunto|combo|banda|grupo)\b)/iu;
/** Lo que no es el nombre de nadie aunque venga con mayúscula. */
const NOT_A_NAME = /\b(argentina|venezuela|colombia|cuba|m[eé]xico|espa[nñ]a|usa|aguinaldos?|parrandas?|venezolan[ao]s?|members?|miembros|varios|various|todos|all)\b/iu;
const ORG_STUDIO = /\b(studios?|estudios?|recording|grabaci[oó]n|sound|sonido|mix|mastering|labs?|audio)\b/iu;
const ORG_PRODUCTION = /\b(producciones|production|productions|productora|producer)\b/iu;
const ORG_LABEL = /\b(records?|discos?|discogr[aá]fica|label|music|m[uú]sica|musical)\b/iu;
const PLACE = /\b(teatro|theat(?:er|re)|hall|auditorium|auditorio|sala|festival|universidad|university|conservatorio|conservatory|escuela|school|academia|academy|iglesia|church|catedral|fundaci[oó]n|foundation|sociedad|society|centro|center|radio|televisi[oó]n|colegio|instituto|institute|museo|museum|ateneo|club|college)\b/iu;
const ENSEMBLE = /\b(tr[ií]o|cuarteto|quinteto|sexteto|septeto|octeto|quartet|quintet|sextet|orquesta|orchestra|ensamble|ensemble|coro|coral|choir|camerata|banda|band|conjunto|grupo|combo|estudiantina|rondalla|orfe[oó]n|sinf[oó]nica|filarm[oó]nica|symphony|philharmonic)\b/iu;

/** A qué pasa un nombre que no es de una persona. */
export function convertTarget(raw: string): Target | undefined {
  // «- ASK Estudios», «Cortesy of Teatro Teresa Carreño»: el nombre es lo que sigue.
  const name = raw.replace(/^[^\p{L}\d]+/u, "").replace(/^(?:court?esy of|cortes[ií]a de|gracias a|thanks to)\s+/iu, "").trim();
  if (!name || /^\p{Ll}/u.test(name) || /\bbonus\s+tracks?\b/iu.test(name)) return undefined; // «del Teatro Libre de Bogotá», «Studio Bonus Track».
  // «Quartet», «Studio»: solo la palabra del tipo, sin nombre.
  const rest = name.split(/\s+/u).filter((token) => ![ORG_COMPANY, ORG_STUDIO, ORG_PRODUCTION, ORG_LABEL, PLACE, ENSEMBLE].some((re) => re.test(token)) && !/^(?:the|el|la|los|las|de|del|of|y|and|&)$/iu.test(token));
  if (rest.length === 0 && name.split(/\s+/u).length === 1) return undefined;
  if (WITH_HIS_BAND.test(name)) return { kind: "artist", name };
  if (ORG_COMPANY.test(name)) return { kind: "organization", name, organizationType: ORG_STUDIO.test(name) ? "recording_studio" : "other" };
  if (ORG_STUDIO.test(name)) return { kind: "organization", name, organizationType: "recording_studio" };
  if (ORG_PRODUCTION.test(name)) return { kind: "organization", name, organizationType: "production_company" };
  if (ORG_LABEL.test(name)) return { kind: "organization", name, organizationType: "record_label" };
  if (ENSEMBLE.test(name)) return { kind: "artist", name };
  if (PLACE.test(name)) return { kind: "organization", name, organizationType: "other" };
  return { kind: "organization", name, organizationType: "other" };
}

/** Rótulo → { nombre limpio, rol }; sin rol propio conserva el de la fuente. */
export function stripLabel(name: string): { bare: string; role?: Role } | undefined {
  for (const prefix of PREFIXES) {
    const match = prefix.re.exec(name.trim());
    if (match) return { bare: match[1]!.trim(), role: prefix.role };
  }
  for (const suffix of SUFFIXES) {
    const match = suffix.re.exec(name.trim());
    if (match) return { bare: match[1]!.trim(), ...(suffix.role === undefined ? {} : { role: suffix.role }) };
  }
  return undefined;
}

/**
 * Partes de una lista: coma, « - », «/» siempre; «&» y « y » solo entre dos
 * nombres, porque « y » también es parte de un apellido («Ramón y Rivera») o
 * de una agrupación («Aldemaro Romero y Su Onda Nueva»). El apellido común se
 * reparte: «Mario & Carlos Rigual» → Mario Rigual + Carlos Rigual.
 */
export function splitList(name: string): string[] {
  if (WITH_HIS_BAND.test(name)) return [name.trim()];
  const out: string[] = [];
  for (const chunk of name.split(/\s*,\s*|\s+-\s+|\s*\/\s*/u).map((part) => part.trim()).filter(Boolean)) {
    const pair = /^(.+?)\s+(?:&|y|and)\s+(.+)$/u.exec(chunk);
    if (pair === null) { out.push(chunk); continue; }
    const left = pair[1]!.trim();
    const right = pair[2]!.trim();
    const leftTokens = left.split(/\s+/u);
    const rightTokens = right.split(/\s+/u);
    if (rightTokens.length < 2) { out.push(chunk); continue; } // «Ramón y Rivera»: apellido compuesto.
    if (leftTokens.length === 1 && /^\p{Lu}\p{Ll}+$/u.test(left)) out.push(`${left} ${rightTokens.at(-1)}`, right);
    else out.push(...splitList(left), ...splitList(right));
  }
  return out;
}

/** Un nombre de persona: 2–5 palabras con mayúscula (salvo conectores), sin cifras ni palabras de cosa. */
export function looksLikePersonName(name: string): boolean {
  const tokens = name.split(/\s+/u).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5 || /\d/u.test(name) || NOT_A_NAME.test(name)) return false;
  if ([ORG_COMPANY, ORG_STUDIO, ORG_PRODUCTION, ORG_LABEL, PLACE, ENSEMBLE].some((re) => re.test(name))) return false;
  return tokens.every((token) => /^[\p{Lu}"“]/u.test(token) || /^(?:de|del|la|las|los|el|y|e|da|do|dos|di|van|von|der|den|le|bin|al|ibn|mc|jr\.?|sr\.?)$/iu.test(token));
}

/** Iniciales o una sola palabra: solo con enlace seguro (Brian, 2026-10-02). */
export function needsSafeLink(name: string): boolean {
  const tokens = name.split(/\s+/u).filter(Boolean);
  return tokens.length < 2 || /(?:^|[\s.])\p{L}\.(?=\s|\p{L}|$)/u.test(name);
}

const URLISH = /(?:www\.|https?:|\.com\b|\.net\b|\.org\b|\.co\.uk\b|@)/iu;

interface Hold { identityRaw: string; rule: string }
interface Credit {
  kind: "track_credit" | "album_credit"; identityKey: string; pageId: number; claimIds: number[];
  role: string; scope: string; trackTitle?: string; albumTitle?: string; artistName?: string;
}
interface Part { target: Target; role?: Role; link?: number }
type Plan =
  | { op: "convertir"; identityRaw: string; target: Target; existing?: number }
  | { op: "credito"; identityRaw: string; parts: Part[]; skipped: string[]; credits: number; placeable: number }
  | { op: "rechazar"; identityRaw: string; why: string; credits: number }
  | { op: "esperar"; identityRaw: string; why: string };

/** Nombres del core por tipo, plegados (la base es SQL_ASCII: `lower()` no pliega tildes). */
class Names {
  private readonly byFold = { person: new Map<string, number[]>(), organization: new Map<string, number[]>(), artist: new Map<string, number[]>() };
  readonly persons: Array<{ id: number; fold: string }> = [];
  /** Fichas de persona que son una lista («Testa/Renis», «C. Curet - B. Capó»): nunca son destino de un enlace. */
  readonly listy = new Set<number>();
  readonly soloArtists = new Set<number>();
  readonly members = new Map<number, number[]>();
  /** Homónimos ya decididos por proyecto común para la ficha en curso (nombre plegado → persona). */
  readonly picks = new Map<string, number>();
  static async load(db: Queryable): Promise<Names> {
    const names = new Names();
    for (const [kind, table] of [["person", "persons"], ["organization", "organizations"], ["artist", "artists"]] as const) {
      const { rows } = await db.query<{ id: string; name: string }>(`SELECT id::text, name FROM public.${table}`);
      for (const row of rows) names.add(kind, Number(row.id), row.name);
    }
    const { rows } = await db.query<{ id: string }>("SELECT id::text FROM public.artists WHERE artist_type='solo_artist'");
    for (const row of rows) names.soloArtists.add(Number(row.id));
    const { rows: members } = await db.query<{ artist_id: string; person_id: string }>("SELECT artist_id::text, person_id::text FROM public.artist_members");
    for (const row of members) names.members.set(Number(row.artist_id), [...(names.members.get(Number(row.artist_id)) ?? []), Number(row.person_id)]);
    return names;
  }
  /**
   * El artista con nombre de persona que es el proyecto de esa persona: el crédito
   * de compositor, versión o músico es de ella («Comp: Iván Pérez Rossi»). La
   * persona gana si es la titular del artista o la única con ese nombre y el
   * artista es solista o no tiene miembros y no empieza por artículo
   * («Un Solo Pueblo», «Los Melódicos» siguen siendo del artista).
   */
  personBehind(artistId: number, name: string): number | undefined {
    const persons = this.same("person", name);
    const members = this.members.get(artistId) ?? [];
    const titular = persons.filter((id) => members.includes(id));
    if (titular.length === 1) return titular[0];
    if (persons.length !== 1) return undefined;
    if (this.soloArtists.has(artistId)) return persons[0];
    if (members.length === 0 && looksLikePersonName(name) && !/^(?:los|las|el|la|lo|un|una|the)\s/iu.test(name)) return persons[0];
    return undefined;
  }
  add(kind: Target["kind"], id: number, name: string): void {
    if (kind === "person" && /[/&,]|\s-\s|\S-\s|\s(?:y|and)\s\p{Lu}/u.test(name)) { this.listy.add(id); return; }
    const key = fold(name);
    const list = this.byFold[kind].get(key);
    if (list === undefined) this.byFold[kind].set(key, [id]);
    else if (!list.includes(id)) list.push(id);
    if (kind === "person") this.persons.push({ id, fold: key });
  }
  same(kind: Target["kind"], name: string): number[] { return this.byFold[kind].get(fold(name)) ?? []; }
  /**
   * «J. Vega», «M.A. Caro», «Albinoni»: las personas cuyo nombre encaja (las
   * iniciales abren el nombre y el apellido aparece después; o solo el apellido,
   * fuera del primer nombre). Candidatas, no enlace: hace falta proyecto común.
   */
  loose(name: string): number[] {
    const tokens = name.replace(/\./gu, ". ").split(/\s+/u).filter(Boolean);
    const initials = tokens.filter((token) => /^\p{L}\.$/u.test(token)).map((token) => fold(token));
    const surname = tokens.filter((token) => !/^\p{L}\.$/u.test(token)).map((token) => fold(token)).filter(Boolean);
    if (surname.length === 0) return [];
    return this.persons.filter((row) => {
      const words = row.fold.split(" ");
      if (words.length < 2) return false;
      const at = words.findIndex((word, index) => index > 0 && surname.every((part, offset) => words[index + offset] === part));
      if (at < 1) return false;
      return initials.every((letter, index) => index < at && words[index]!.startsWith(letter));
    }).map((row) => row.id);
  }
}

async function personClaims(db: Queryable, sourceId: number, identityRaw: string): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id::text FROM ingest.claims WHERE source_id=$1 AND entity_kind='person' AND status='candidate' AND identity_raw=$2",
    [sourceId, identityRaw]);
  return rows.map((row) => Number(row.id));
}

async function creditsOf(db: Queryable, sourceId: number, credited: string): Promise<Credit[]> {
  const { rows } = await db.query<{ entity_kind: "track_credit" | "album_credit"; identity_key: string; raw_page_id: string; ids: string[]; fields: Record<string, string> }>(`
    SELECT c.entity_kind, c.identity_key, c.raw_page_id::text, array_agg(c.id::text) AS ids,
           jsonb_object_agg(c.field, c.raw_value #>> '{}') AS fields
      FROM ingest.claims c
     WHERE c.source_id=$1 AND c.entity_kind IN ('track_credit','album_credit') AND c.status='candidate'
       AND c.identity_key IN (SELECT n.identity_key FROM ingest.claims n
                               WHERE n.source_id=$1 AND n.entity_kind IN ('track_credit','album_credit') AND n.field='credited_name'
                                 AND n.status='candidate' AND n.raw_value #>> '{}' = $2)
     GROUP BY c.entity_kind, c.identity_key, c.raw_page_id`, [sourceId, credited]);
  return rows.filter((row) => row.fields["credited_name"] === credited).map((row) => ({
    kind: row.entity_kind, identityKey: row.identity_key, pageId: Number(row.raw_page_id), claimIds: row.ids.map(Number),
    role: row.fields["credit_role"] ?? "", scope: row.fields["credit_scope"] ?? "",
    ...(row.fields["track_title"] === undefined ? {} : { trackTitle: row.fields["track_title"] }),
    ...(row.fields["album_title"] === undefined ? {} : { albumTitle: row.fields["album_title"] }),
    ...(row.fields["artist_name"] === undefined ? {} : { artistName: row.fields["artist_name"] }),
  }));
}

/** La pista o el disco del crédito, si ya está en el core (por la ficha de la que sale). */
async function workOf(db: Queryable, credit: Credit): Promise<number | undefined> {
  if (credit.kind === "album_credit") {
    const { rows } = await db.query<{ album_id: string }>(`
      SELECT DISTINCT album_id::text FROM ingest.claims
       WHERE raw_page_id=$1 AND entity_kind='album' AND status='accepted' AND album_id IS NOT NULL`, [credit.pageId]);
    return rows.length === 1 ? Number(rows[0]!.album_id) : undefined;
  }
  if (credit.trackTitle === undefined) return undefined;
  const { rows } = await db.query<{ track_id: string; title: string }>(`
    SELECT DISTINCT track_id::text, raw_value #>> '{}' AS title FROM ingest.claims
     WHERE raw_page_id=$1 AND entity_kind='track' AND field='title' AND status='accepted' AND track_id IS NOT NULL`, [credit.pageId]);
  const hits = [...new Set(rows.filter((row) => fold(row.title) === fold(credit.trackTitle!)).map((row) => row.track_id))];
  return hits.length === 1 ? Number(hits[0]) : undefined;
}

/**
 * Homónimos: la persona que comparte proyecto con los créditos de la ficha
 * (crédito en un disco de los mismos artistas o integrante de alguno). Una sola
 * o ninguna (Brian: fusionar y enlazar solo con proyecto común).
 */
async function pickHomonym(db: Queryable, candidates: number[], works: Array<{ kind: Credit["kind"]; id: number }>): Promise<number | undefined> {
  const albums = works.filter((work) => work.kind === "album_credit").map((work) => work.id);
  const tracks = works.filter((work) => work.kind === "track_credit").map((work) => work.id);
  const { rows } = await db.query<{ id: string }>(`
    WITH albums AS (
      SELECT unnest($2::bigint[]) AS id UNION SELECT album_id FROM public.tracks WHERE id = ANY($3::bigint[])),
    artists AS (SELECT DISTINCT artist_id FROM public.albums WHERE id IN (SELECT id FROM albums) AND artist_id IS NOT NULL),
    scope AS (SELECT id FROM albums UNION SELECT id FROM public.albums WHERE artist_id IN (SELECT artist_id FROM artists))
    SELECT p::text AS id FROM unnest($1::bigint[]) AS p
     WHERE EXISTS (SELECT 1 FROM public.album_credits c WHERE c.person_id = p AND c.album_id IN (SELECT id FROM scope))
        OR EXISTS (SELECT 1 FROM public.track_credits c JOIN public.tracks t ON t.id = c.track_id WHERE c.person_id = p AND t.album_id IN (SELECT id FROM scope))
        OR EXISTS (SELECT 1 FROM public.artist_members m WHERE m.person_id = p AND m.artist_id IN (SELECT artist_id FROM artists))`,
    [candidates, albums, tracks]);
  return rows.length === 1 ? Number(rows[0]!.id) : undefined;
}

/** «aúl Monsalve» → la única persona cuyo nombre lo completa con una o dos letras al principio. */
function completeTruncated(names: Names, name: string): number | undefined {
  const tail = fold(name);
  const hits = names.persons.filter((row) => {
    const extra = row.fold.length - tail.length;
    return row.fold.endsWith(tail) && extra >= 1 && extra <= 2 && !row.fold.slice(0, extra).includes(" ");
  });
  return hits.length === 1 ? hits[0]!.id : undefined;
}

const orgish = (name: string) => classifyPersonName(name).kind === "organization_like" || WITH_HIS_BAND.test(name)
  || [ENSEMBLE, PLACE, ORG_STUDIO, ORG_PRODUCTION, ORG_COMPANY].some((re) => re.test(name));

/**
 * Las partes de un crédito: el rótulo se quita (y da el rol), lo que queda se
 * parte como lista y cada parte se resuelve. Las que no entran dejan su motivo.
 */
/** Un rótulo que no deja nombre: «Traditional», «tracks 1-4», «08», «Unplugged», «Part I: …». */
const LABEL_ONLY = /^(?:[\d\s.,/-]+$|(?:traditional|tradicional|popular|an[oó]nimo|unplugged|live|en vivo|version|versi[oó]n|part|parte|tracks?|bonus|instrumental|reprise|intro|outro|medley|demo|acoustic|ac[uú]stico)\b)/iu;

function resolveParts(names: Names, raw: string, why: string[], requireLabel = false): Part[] {
  let name = raw.trim();
  let role: Role | undefined;
  const labelled = stripLabel(name);
  if (labelled !== undefined) { name = labelled.bare; role = labelled.role; }
  if (LABEL_ONLY.test(name) && !(labelled !== undefined && /^\p{Lu}\p{Ll}+\s+\p{Lu}/u.test(name))) { why.push(`«${raw}»: rótulo sin nombre`); return []; }
  if (/[()"“”«»]/u.test(name)) { why.push(`«${raw}»: paréntesis o comillas, lo mira una persona`); return []; }
  // Un rótulo que no se reconoce («Version by X», «from … by X») no se adivina.
  if (requireLabel && labelled === undefined && !orgish(name)) { why.push(`«${raw}»: rótulo que no se reconoce`); return []; }
  const parts: Part[] = [];
  for (const piece of splitList(name)) {
    // «Gonzalo Micó - Arr: Pablo Gil»: la parte trae su propio rótulo.
    const inner = stripLabel(piece);
    const part = resolveOne(names, inner?.bare ?? piece, why);
    const partRole = inner?.role ?? role;
    if (part === undefined) continue;
    // «Flanger Dance mix»: una remezcla solo entra si enlaza con alguien que ya existe.
    if (partRole?.role === "Remezcla" && part.link === undefined) { why.push(`«${part.target.name}»: remezcla sin enlace`); continue; }
    parts.push(partRole === undefined ? part : { ...part, role: partRole });
  }
  // «Feat. Tropi & Nana Cadavieco»: el apellido común no se reparte si la otra parte es un artista.
  if (parts.some((part) => part.target.kind === "artist")) {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i]!.target.kind === "person" && !name.includes(parts[i]!.target.name)) {
        why.push(`«${parts[i]!.target.name}»: apellido repartido junto a un artista, una sola palabra`);
        parts.splice(i, 1);
      }
    }
  }
  return parts;
}

function resolveOne(names: Names, raw: string, why: string[]): Part | undefined {
  const name = raw.trim();
  if (!name || URLISH.test(name)) { why.push(`«${raw}»: no deja nombre`); return undefined; }
  const classified = classifyPersonName(name);
  if (classified.kind === "duration" || classified.kind === "fragment" || /^[\d\s.,/-]+$/u.test(name)) { why.push(`«${raw}»: no es un nombre`); return undefined; }
  if (stripLabel(name) !== undefined || /^(?:bonus|instrumental|reprise|radio|extended|alt\.?|vocal|live|en vivo|demo|intro|outro)\b/iu.test(name)) {
    why.push(`«${raw}»: rótulo sin nombre`); return undefined;
  }
  // «J. F. Coral» no es un coro: con iniciales que encajan en una persona, sigue el camino de persona.
  if (orgish(name) && !(needsSafeLink(name) && names.loose(name).length > 0)) {
    const target = convertTarget(name);
    if (target === undefined) { why.push(`«${raw}»: fragmento`); return undefined; }
    return { target };
  }
  const tokens = name.split(/\s+/u).filter(Boolean);
  if (tokens.length > 5 || /\b(?:by|de la pista|track)\b/iu.test(name)) { why.push(`«${name}»: no parece un nombre`); return undefined; }
  // Una sola palabra no entra ni enlazada: el core tiene fichas como «Argentina» (tramos C y D).
  if (tokens.length < 2) {
    const pick = names.picks.get(fold(name));
    if (pick !== undefined) return { target: { kind: "person", name }, link: pick };
    why.push(`«${name}»: una sola palabra, sin enlace seguro`); return undefined;
  }
  if (/^\p{Ll}/u.test(name)) {
    const completed = completeTruncated(names, name);
    if (completed === undefined) { why.push(`«${name}»: empieza en minúscula y no se completa`); return undefined; }
    return { target: { kind: "person", name }, link: completed };
  }
  // «Un Solo Pueblo», «Bacalao Men»: si hay un artista con ese nombre exacto, el crédito es suyo.
  // Un solista con una persona del mismo nombre no: «Comp: Iván Pérez Rossi» es de la persona.
  const band = names.same("artist", name);
  if (band.length === 1) {
    const person = names.personBehind(band[0]!, name);
    return person === undefined ? { target: { kind: "artist", name }, link: band[0]! } : { target: { kind: "person", name }, link: person };
  }
  const same = names.same("person", name);
  if (same.length === 1) return { target: { kind: "person", name }, link: same[0]! };
  if (same.length > 1) {
    const pick = names.picks.get(fold(name));
    if (pick !== undefined) return { target: { kind: "person", name }, link: pick };
    why.push(`«${name}»: ${same.length} personas con ese nombre`); return undefined;
  }
  if (needsSafeLink(name)) {
    const pick = names.picks.get(fold(name));
    if (pick !== undefined) return { target: { kind: "person", name }, link: pick };
    why.push(`«${name}»: iniciales, sin enlace seguro`); return undefined;
  }
  if (!looksLikePersonName(name)) { why.push(`«${name}»: no parece un nombre`); return undefined; }
  return { target: { kind: "person", name } };
}

async function findOrCreate(context: OperatorContext, names: Names, target: Target): Promise<{ id: number; created: boolean }> {
  const found = names.same(target.kind, target.name);
  if (found.length === 1) return { id: found[0]!, created: false };
  if (found.length > 1) throw new Error(`hay ${found.length} ${target.kind} llamados «${target.name}»`);
  const values = target.kind === "artist" ? { name: target.name, artist_type: "group" }
    : target.kind === "organization" ? { name: target.name, organization_type: target.organizationType ?? "other" }
    : { name: target.name };
  // Personas: sin coincidencia segura se crean (la regla de la promoción); organizaciones y artistas
  // también, porque el nombre se miró por tipo y el parecido del ER suele ser otro estudio u otra banda.
  const id = (await createEntity(context, target.kind, values, { allowSimilar: true })).id;
  names.add(target.kind, id, target.name);
  return { id, created: true };
}

/**
 * --place-converted=<informe>: los créditos de las fichas que el run anterior
 * convirtió en organización o artista. El puente no los engancha solo: busca
 * por el grafo de claims de la fuente (que no tiene esa organización) y el ER
 * no da AUTO_MATCH por un nombre sin más contexto. Se crean como relaciones del
 * operador sobre la pista o el disco que ya está en el core.
 */
async function placeConverted(file: string, confirm: boolean, note: string): Promise<void> {
  const pool = getPool();
  const { rows: [source] } = await pool.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='sincopa'");
  const sourceId = Number(source!.id);
  const converted = (JSON.parse(readFileSync(file, "utf8")).plan as Plan[])
    .filter((item): item is Extract<Plan, { op: "convertir" }> => item.op === "convertir" && item.existing !== undefined);
  const work: Array<{ item: Extract<Plan, { op: "convertir" }>; credits: Array<Credit & { work: number }>; waiting: number }> = [];
  for (const item of converted) {
    const credits = await creditsOf(pool, sourceId, item.identityRaw);
    const placed: Array<Credit & { work: number }> = [];
    let waiting = 0;
    for (const credit of credits) {
      const target = await workOf(pool, credit);
      if (target === undefined) waiting += 1;
      else placed.push({ ...credit, work: target });
    }
    if (placed.length > 0 || waiting > 0) work.push({ item, credits: placed, waiting });
  }
  const done = { relations: 0, creditsPlaced: 0, creditsWaiting: work.reduce((sum, row) => sum + row.waiting, 0), failed: 0 };
  let runId: number | undefined;
  if (confirm) {
    const result = await withOperatorRun({ name: "resolve-sincopa-person-holds:place-converted", operator: "brian", note, params: { from: file } }, async (context) => {
      const reason = `[run ${context.runId}] ${note}`;
      for (const { item, credits } of work) {
        for (const credit of credits) {
          await context.client.query("SAVEPOINT place_converted");
          try {
            const endpoint = item.target.kind === "artist" ? { artistId: item.existing! } : { organizationId: item.existing! };
            const relation = await createRelation(context, credit.kind, { ...(credit.kind === "track_credit" ? { trackId: credit.work } : { albumId: credit.work }), ...endpoint },
              { credit_type: creditTypeForSection(undefined, credit.role), credit_role: credit.role });
            if (relation.created) done.relations += 1;
            await context.client.query("UPDATE ingest.claims SET status='superseded', notes=$2, updated_at=now() WHERE id=ANY($1::bigint[]) AND status='candidate'",
              [credit.claimIds, `${reason}: crédito reemplazado por ${credit.kind} ${relation.id} (${item.target.kind} ${item.existing} «${item.target.name}»)`]);
            await context.client.query(`UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                                         WHERE claim_a_id=ANY($1::bigint[]) AND status IN ('open','in_progress')`, [credit.claimIds, reason]);
            done.creditsPlaced += 1;
            await context.client.query("RELEASE SAVEPOINT place_converted");
          } catch (error) {
            await context.client.query("ROLLBACK TO SAVEPOINT place_converted");
            done.failed += 1;
            if (done.failed <= 20) console.error(item.identityRaw, (error as Error).message);
          }
        }
      }
      return done;
    });
    runId = result.runId;
  }
  console.log(JSON.stringify({ dryRun: !confirm, runId, entities: work.length, credits: work.reduce((sum, row) => sum + row.credits.length, 0), ...done }, null, 2));
}

/**
 * --repair-artist-runs=11665,11667: los créditos que esos runs dejaron en un
 * artista que es el proyecto de una persona (regla de personBehind) pasan a la
 * persona. Se leen del diario: solo lo que esos runs insertaron.
 */
async function repairArtistRuns(runs: number[], confirm: boolean, note: string): Promise<void> {
  const pool = getPool();
  const names = await Names.load(pool);
  const { rows } = await pool.query<{ table_name: string; id: string; artist_id: string; name: string }>(`
    SELECT j.table_name, j.new_data->>'id' AS id, a.id::text AS artist_id, a.name
      FROM ingest.change_journal j
      JOIN public.artists a ON a.id = (j.new_data->>'artist_id')::bigint
     WHERE j.run_id = ANY($1::bigint[]) AND j.op = 'I' AND j.table_name IN ('public.album_credits','public.track_credits')`, [runs]);
  const plan = rows.flatMap((row) => {
    const person = names.personBehind(Number(row.artist_id), row.name);
    return person === undefined ? [] : [{ kind: row.table_name === "public.track_credits" ? "track_credit" as const : "album_credit" as const, id: Number(row.id), artistId: Number(row.artist_id), name: row.name, person }];
  });
  const done = { moved: 0, gone: 0, failed: 0 };
  let runId: number | undefined;
  if (confirm) {
    const result = await withOperatorRun({ name: "resolve-sincopa-person-holds:repair-artist-runs", operator: "brian", note, params: { runs } }, async (context) => {
      for (const item of plan) {
        const table = item.kind === "track_credit" ? "track_credits" : "album_credits";
        const { rows: [live] } = await context.client.query<{ artist_id: string | null }>(`SELECT artist_id::text FROM public.${table} WHERE id=$1`, [item.id]);
        if (live === undefined || live.artist_id !== String(item.artistId)) { done.gone += 1; continue; }
        await context.client.query("SAVEPOINT repair_artist");
        try {
          await updateRelation(context, item.kind, item.id, { person_id: item.person });
          done.moved += 1;
          await context.client.query("RELEASE SAVEPOINT repair_artist");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT repair_artist");
          done.failed += 1;
          console.error(item.kind, item.id, item.name, (error as Error).message);
        }
      }
      return done;
    });
    runId = result.runId;
  }
  const byName = new Map<string, number>();
  for (const item of plan) byName.set(`${item.name} → persona ${item.person}`, (byName.get(`${item.name} → persona ${item.person}`) ?? 0) + 1);
  console.log(JSON.stringify({ dryRun: !confirm, runId, credits: plan.length, ...done, byName: Object.fromEntries(byName) }, null, 2));
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: personas retenidas por la promoción (decisiones de Brian 2026-10-03)";
  const fromReport = arg("place-converted");
  if (fromReport !== undefined) { await placeConverted(fromReport, confirm, note); return; }
  const repairRuns = arg("repair-artist-runs");
  if (repairRuns !== undefined) { await repairArtistRuns(repairRuns.split(",").map(Number), confirm, note); return; }
  const files = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const pool = getPool();
  const { rows: [source] } = await pool.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='sincopa'");
  const sourceId = Number(source!.id);

  const names = await Names.load(pool);
  const holds = new Map<string, Hold>();
  for (const file of files) {
    for (const hold of (JSON.parse(readFileSync(file, "utf8")).holds as Array<{ kind: string; identityRaw: string; rule: string }>)) {
      if (hold.kind === "person" && ((hold.rule.startsWith("no-es-una-persona:") && hold.rule !== "no-es-una-persona:entre-comillas")
        || hold.rule === "parte-de-credito-multiple:sin-enlace-seguro")) {
        holds.set(hold.identityRaw, { identityRaw: hold.identityRaw, rule: hold.rule });
      }
    }
  }

  const plan: Plan[] = [];
  for (const hold of holds.values()) {
    const name = hold.identityRaw;
    if ((await personClaims(pool, sourceId, name)).length === 0) continue;
    const rule = hold.rule.replace("no-es-una-persona:", "");
    if (rule === "parentesis-de-titulo" || (rule === "parece-un-titulo" && stripLabel(name) === undefined && (URLISH.test(name) || !/^\p{Ll}\p{L}*\s+\p{Lu}/u.test(name)))) {
      plan.push({ op: "rechazar", identityRaw: name, why: rule === "parentesis-de-titulo" ? "solo aparece como paréntesis de un título" : "texto suelto, no un nombre", credits: (await creditsOf(pool, sourceId, name)).length });
      continue;
    }
    if (rule === "organization_like" || rule === "agrupacion-o-lugar") {
      const target = convertTarget(name);
      if (target === undefined) plan.push({ op: "rechazar", identityRaw: name, why: "fragmento de texto", credits: (await creditsOf(pool, sourceId, name)).length });
      else plan.push({ op: "convertir", identityRaw: name, target });
      continue;
    }
    // rótulos, listas y nombres truncados: el crédito se arma a mano.
    let why: string[] = [];
    let parts = resolveParts(names, name, why, rule === "rotulo");
    const homonyms = why.map((item) => {
      const homonym = /^«(.+)»: \d+ personas con ese nombre$/u.exec(item)?.[1];
      if (homonym !== undefined) return { name: homonym, candidates: names.same("person", homonym) };
      const loose = /^«(.+)»: (?:iniciales|una sola palabra), sin enlace seguro$/u.exec(item)?.[1];
      return loose === undefined ? undefined : { name: loose, candidates: names.loose(loose) };
    }).filter((item): item is { name: string; candidates: number[] } => item !== undefined && item.candidates.length > 0);
    if (homonyms.length > 0) {
      const works: Array<{ kind: Credit["kind"]; id: number }> = [];
      for (const credit of await creditsOf(pool, sourceId, name)) {
        const work = await workOf(pool, credit);
        if (work !== undefined) works.push({ kind: credit.kind, id: work });
      }
      names.picks.clear();
      for (const homonym of homonyms) {
        const pick = works.length === 0 ? undefined : await pickHomonym(pool, homonym.candidates, works);
        if (pick !== undefined) names.picks.set(fold(homonym.name), pick);
      }
      if (names.picks.size > 0) { why = []; parts = resolveParts(names, name, why, rule === "rotulo"); }
      names.picks.clear();
    }
    // Una lista con una parte que lo mira una persona espera entera: no se acredita a medias.
    if (why.some((item) => /paréntesis o comillas|no se reconoce|no parece un nombre|personas con ese nombre/u.test(item))) {
      plan.push({ op: "esperar", identityRaw: name, why: why.join("; ") });
      continue;
    }
    const credits = await creditsOf(pool, sourceId, name);
    // Restos de créditos ya partidos (run 11519): la persona combinada no tiene créditos candidatos.
    if (credits.length === 0) { plan.push({ op: "rechazar", identityRaw: name, why: "sin créditos candidatos: resto de un crédito ya partido", credits: 0 }); continue; }
    if (parts.length === 0) {
      // «Radio Version», «Instrumental»: nada que acreditar.
      if (why.every((item) => /no deja nombre|no es un nombre|rótulo sin nombre/u.test(item))) plan.push({ op: "rechazar", identityRaw: name, why: why.join("; "), credits: credits.length });
      else plan.push({ op: "esperar", identityRaw: name, why: why.join("; ") });
      continue;
    }
    let placeable = 0;
    for (const credit of credits) if (await workOf(pool, credit) !== undefined) placeable += 1;
    // Sin la pista o el disco en el core no se crea a nadie: la ficha espera a que entren.
    if (placeable === 0) { plan.push({ op: "esperar", identityRaw: name, why: "la pista o el disco del crédito aún no está en el core" }); continue; }
    plan.push({ op: "credito", identityRaw: name, parts, skipped: why, credits: credits.length, placeable });
  }

  const done = { converted: 0, rejected: 0, relations: 0, creditsPlaced: 0, creditsWaiting: 0, created: { person: 0, organization: 0, artist: 0 }, failed: 0 };
  const errors: Array<{ identityRaw: string; error: string }> = [];
  let runId: number | undefined;
  if (confirm) {
    const result = await withOperatorRun({ name: "resolve-sincopa-person-holds", operator: "brian", note, params: { items: plan.length } }, async (context) => {
      const reason = `[run ${context.runId}] ${note}`;
      const reject = async (ids: number[], why: string) => {
        if (ids.length === 0) return;
        await context.client.query("UPDATE ingest.claims SET status='rejected', notes=$2, updated_at=now() WHERE id=ANY($1::bigint[]) AND status='candidate'", [ids, `${reason}: ${why}`]);
        await context.client.query(`UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                                     WHERE claim_a_id=ANY($1::bigint[]) AND status IN ('open','in_progress')`, [ids, `${reason}: ${why}`]);
      };
      for (const item of plan) {
        if (item.op === "esperar") continue;
        await context.client.query("SAVEPOINT person_hold");
        try {
          const ownClaims = await personClaims(context.client, sourceId, item.identityRaw);
          if (item.op === "rechazar") {
            const credits = await creditsOf(context.client, sourceId, item.identityRaw);
            await reject([...ownClaims, ...credits.flatMap((credit) => credit.claimIds)], item.why);
            done.rejected += 1;
          } else if (item.op === "convertir") {
            const made = await findOrCreate(context, names, item.target);
            item.existing = made.id;
            if (made.created) done.created[item.target.kind] += 1;
            await reject(ownClaims, `no es una persona: pasa a ${item.target.kind === "artist" ? "artista" : "organización"} ${made.id} «${item.target.name}»`);
            done.converted += 1;
          } else {
            const ids: number[] = [];
            for (const part of item.parts) {
              if (part.link !== undefined) { ids.push(part.link); continue; }
              const made = await findOrCreate(context, names, part.target);
              if (made.created) done.created[part.target.kind] += 1;
              part.link = made.id;
              ids.push(made.id);
            }
            const credits = await creditsOf(context.client, sourceId, item.identityRaw);
            for (const credit of credits) {
              const work = await workOf(context.client, credit);
              if (work === undefined) { done.creditsWaiting += 1; continue; }
              const relationIds: number[] = [];
              for (const [index, part] of item.parts.entries()) {
                const role = part.role ?? { creditType: creditTypeForSection(undefined, credit.role), role: credit.role };
                const endpoint = part.target.kind === "person" ? { personId: ids[index]! } : part.target.kind === "artist" ? { artistId: ids[index]! } : { organizationId: ids[index]! };
                const relation = await createRelation(context, credit.kind, { ...(credit.kind === "track_credit" ? { trackId: work } : { albumId: work }), ...endpoint },
                  { credit_type: role.creditType, credit_role: role.role });
                relationIds.push(relation.id);
                if (relation.created) done.relations += 1;
              }
              await context.client.query("UPDATE ingest.claims SET status='superseded', notes=$2, updated_at=now() WHERE id=ANY($1::bigint[]) AND status='candidate'",
                [credit.claimIds, `${reason}: crédito reemplazado por ${credit.kind} ${relationIds.join(", ")} («${item.identityRaw}» → ${item.parts.map((part) => part.target.name).join(" + ")})`]);
              await context.client.query(`UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                                           WHERE claim_a_id=ANY($1::bigint[]) AND status IN ('open','in_progress')`, [credit.claimIds, reason]);
              done.creditsPlaced += 1;
            }
            await reject(ownClaims, `no es el nombre de una persona: ${item.parts.map((part) => part.target.name).join(" + ")}`);
          }
          await context.client.query("RELEASE SAVEPOINT person_hold");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT person_hold");
          done.failed += 1;
          errors.push({ identityRaw: item.identityRaw, error: (error as Error).message });
        }
      }
      return done;
    });
    runId = result.runId;
  }

  const count = (op: Plan["op"]) => plan.filter((item) => item.op === op).length;
  const summary = { dryRun: !confirm, runId, holds: holds.size, convertir: count("convertir"), credito: count("credito"), rechazar: count("rechazar"), esperar: count("esperar"), ...(confirm ? done : {}), errors: errors.length };
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...summary, plan, errors }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1]?.endsWith("resolve-sincopa-person-holds.ts")) {
  main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
}
