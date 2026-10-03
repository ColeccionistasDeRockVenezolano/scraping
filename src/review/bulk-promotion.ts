// CRV · Promoción masiva de una fuente por sección (ver bulk-policy.ts).
//
// Hace lo que `approveBatch` hace con "todo lo candidato", pero entidad por
// entidad con un veredicto explícito, porque aprobar ciegas lo que el ER dejó
// en REVIEW fabrica homónimos. El camino al core sigue siendo `approveEntity`
// (el merge con createdBy="human"); aquí solo se decide QUÉ veredicto lleva
// cada identidad y se deja constancia de la regla en el rastro:
//
//   * una fila `merge_run` ancla el lote; `withRunScope` liga cada escritura al
//     diario de cambios, así que el lote entero se puede deshacer;
//   * la decisión de ER de cada identidad lleva `reference`: la regla, la
//     sección y el run que la produjeron;
//   * lo que la regla no puede afirmar se queda `candidate` y abierto (`hold`),
//     y las personas creadas que se parecen a una existente salen en
//     `duplicateFlags` para el detector de duplicados.
//
// Orden de dependencia: sellos, artistas, personas, discos, pistas y, al final,
// los tres puentes (membresías y créditos), que se resuelven solos por el claim
// graph una vez que sus extremos tienen destino.
import { getDb, getPool } from "../db/client.js";
import { withRunScope } from "../db/run-binding.js";
import { scrapeRuns } from "../db/schema/ingest.js";
import { finishRun } from "../ingest/runs.js";
import { withCandidateSnapshot } from "../er/repository.js";
import { moduleLogger } from "../logger/index.js";
import { normalizeEntityName } from "../normalization/entity-name.js";
import { approveEntity, dismissEntity, type ApprovalOptions } from "./approval.js";
import {
  decideVerdict, foldName, nearness,
  type BulkKind, type CandidateEvidence, type DecisionEvidence, type DuplicateFlag, type ErAction, type ExistingRef, type Verdict,
} from "./bulk-policy.js";

const log = moduleLogger("review:bulk-promotion");

export const PROMOTION_SECTIONS = ["jazz", "classic", "latin_pop", "new_age", "traditional", "ethnic", "rock_pop"] as const;
export type PromotionSection = (typeof PROMOTION_SECTIONS)[number];

const ENTITY_KINDS: readonly BulkKind[] = ["organization", "artist", "person", "album", "track"];
const RELATION_KINDS = ["artist_membership", "album_credit", "track_credit"] as const;
export type PromotionKind = BulkKind | (typeof RELATION_KINDS)[number];
export const PROMOTION_ORDER: readonly PromotionKind[] = [...ENTITY_KINDS, ...RELATION_KINDS];

/** Campo que lleva el nombre de la identidad de cada tipo. */
const IDENTITY_FIELD: Record<BulkKind, string> = {
  organization: "name", artist: "name", person: "name", album: "title", track: "title",
};
const ER_KIND: Record<BulkKind, string> = {
  organization: "ORGANIZATION", artist: "ARTIST", person: "PERSON", album: "ALBUM", track: "TRACK",
};
const CORE_TABLE: Record<BulkKind, { table: string; name: string; parent?: string }> = {
  organization: { table: "public.organizations", name: "name" },
  artist: { table: "public.artists", name: "name" },
  person: { table: "public.persons", name: "name" },
  album: { table: "public.albums", name: "title", parent: "artist_id" },
  track: { table: "public.tracks", name: "title", parent: "album_id" },
};

export interface PromotionOptions {
  section: PromotionSection;
  note: string;
  /** Sin `confirm` no se escribe nada: solo se calcula el plan. */
  confirm: boolean;
  sourceSlug?: string;
  kinds?: readonly PromotionKind[];
  /** Techo de identidades por tipo (pruebas piloto). */
  limitPerKind?: number;
  /** Solo las identidades con claims candidatos en estas fichas (reingestas dirigidas). */
  pageUrls?: readonly string[];
  decidedBy?: string;
}

export interface HoldItem { kind: PromotionKind; identityRaw: string; rule: string; detail: string; claims: number }
export interface FlagItem { kind: BulkKind; identityRaw: string; targetId?: number; rule: string; flag: DuplicateFlag }
export interface KindSummary {
  identities: number;
  claims: number;
  verdicts: Record<string, number>;
  applied: number;
  unchanged: number;
  stillCandidate: number;
  dismissed: number;
  failed: number;
}

export interface PromotionReport {
  section: PromotionSection;
  dryRun: boolean;
  runId?: number;
  note: string;
  kinds: Partial<Record<PromotionKind, KindSummary>>;
  holds: HoldItem[];
  /** Veredictos de las reglas que se apoyan en evidencia del core (repertorio, posición, decisión vieja), para auditarlos. */
  evidenceVerdicts?: Array<{ kind: PromotionKind; identityRaw: string; rule: string; targetId?: number; detail?: string }>;
  duplicateFlags: FlagItem[];
  errors: Array<{ kind: string; identityRaw: string; error: string }>;
}

interface IdentityRow { identityKey: string; identityRaw: string; claims: number }

async function sourceIdFor(slug: string): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [slug]);
  if (!rows[0]) throw new Error(`fuente desconocida: ${slug}`);
  return Number(rows[0].id);
}

/** Identidades con al menos un claim candidato en páginas de la sección (o de las fichas dadas). */
async function selectIdentities(sourceId: number, kind: PromotionKind, section: PromotionSection, limit?: number, pageUrls?: readonly string[]): Promise<IdentityRow[]> {
  const { rows } = await getPool().query<{ identity_key: string; raw: string | null; claims: number }>(`
    SELECT c.identity_key, min(c.identity_raw) AS raw, count(*)::int AS claims
      FROM ingest.claims c
      JOIN ingest.raw_pages p ON p.id = c.raw_page_id
     WHERE c.source_id = $1 AND c.status = 'candidate' AND c.entity_kind = $2::ingest.claim_entity_kind
       AND c.identity_key IS NOT NULL AND p.url LIKE $3
       ${pageUrls === undefined ? "" : "AND p.url = ANY($4::text[])"}
     GROUP BY c.identity_key
     ORDER BY min(c.id)
     ${limit === undefined ? "" : `LIMIT ${Math.max(1, Math.floor(limit))}`}`,
  [sourceId, kind, `%sincopa.com/${section}/%`, ...(pageUrls === undefined ? [] : [pageUrls])]);
  return rows.map((row) => ({ identityKey: row.identity_key, identityRaw: row.raw ?? row.identity_key, claims: row.claims }));
}

/** Última decisión de ER de la identidad, sobre su claim de nombre. */
async function loadDecisions(sourceId: number, kind: BulkKind, keys: string[]): Promise<Map<string, DecisionEvidence>> {
  const out = new Map<string, DecisionEvidence>();
  for (let offset = 0; offset < keys.length; offset += 2_000) {
    const slice = keys.slice(offset, offset + 2_000);
    const { rows } = await getPool().query<{ identity_key: string; action: ErAction; score: number; candidates: unknown }>(`
      SELECT DISTINCT ON (c.identity_key) c.identity_key, d.action, d.score,
             jsonb_path_query_array(d.candidates, '$[0 to 9]') AS candidates
        FROM ingest.claims c
        JOIN ingest.entity_resolution_decisions d ON d.claim_id = c.id
       WHERE c.source_id = $1 AND c.status = 'candidate' AND c.entity_kind = $2::ingest.claim_entity_kind
         AND c.field = $3 AND c.identity_key = ANY($4::text[]) AND d.entity_kind = $5
       ORDER BY c.identity_key, d.id DESC`,
    [sourceId, kind, IDENTITY_FIELD[kind], slice, ER_KIND[kind]]);
    for (const row of rows) {
      const list = Array.isArray(row.candidates) ? row.candidates as Array<Record<string, unknown>> : [];
      out.set(row.identity_key, {
        action: row.action, score: Number(row.score),
        candidates: list.flatMap((item): CandidateEvidence[] => {
          const id = Number(item["candidateId"]);
          const name = typeof item["canonicalName"] === "string" ? item["canonicalName"] : "";
          if (!Number.isFinite(id) || name === "") return [];
          return [{ id, name, score: Number(item["score"] ?? 0), ...(typeof item["nameBasis"] === "string" ? { nameBasis: item["nameBasis"] } : {}) }];
        }),
      });
    }
  }
  return out;
}

/**
 * Personas de la sección que la fuente solo nombra como paréntesis final de un
 * título de pista («Profundo (Capricornio)»). Basta un crédito de disco o una
 * línea de créditos en cualquier página de la fuente para que no cuente.
 */
export async function loadTitleParenthesisOnly(sourceId: number, section: PromotionSection): Promise<Set<string>> {
  const creditsOf = async (where: string, params: unknown[]) => (await getPool().query<{ kind: string; name: string; title: string | null }>(`
    SELECT c.entity_kind::text AS kind,
           max(c.raw_value #>> '{}') FILTER (WHERE c.field = 'credited_name') AS name,
           max(c.raw_value #>> '{}') FILTER (WHERE c.field = 'track_title') AS title
      FROM ingest.claims c
     WHERE c.source_id = $1 AND c.entity_kind IN ('album_credit', 'track_credit') AND ${where}
     GROUP BY c.raw_page_id, c.entity_kind, c.identity_key`, [sourceId, ...params])).rows;
  const tally = (rows: Array<{ kind: string; name: string | null; title: string | null }>) => {
    const out = new Map<string, { paren: number; other: number; raw: Set<string> }>();
    for (const row of rows) {
      if (row.name === null) continue;
      const key = normalizeEntityName(row.name).primaryKey;
      const entry = out.get(key) ?? { paren: 0, other: 0, raw: new Set<string>() };
      entry.raw.add(row.name);
      if (row.kind === "track_credit" && (row.title ?? "").includes(`(${row.name})`)) entry.paren += 1;
      else entry.other += 1;
      out.set(key, entry);
    }
    return out;
  };
  const local = tally(await creditsOf(
    `c.raw_page_id IN (SELECT id FROM ingest.raw_pages WHERE url LIKE $2)`, [`%sincopa.com/${section}/%`]));
  const suspects = [...local].filter(([, entry]) => entry.paren > 0 && entry.other === 0);
  if (suspects.length === 0) return new Set();
  // Créditos de esos mismos nombres en toda la fuente (otras secciones, otras páginas).
  const rawNames = suspects.flatMap(([, entry]) => [...entry.raw]);
  const global = tally(await creditsOf(
    `c.identity_key IN (SELECT n.identity_key FROM ingest.claims n
                         WHERE n.source_id = $1 AND n.entity_kind IN ('album_credit', 'track_credit')
                           AND n.field = 'credited_name' AND n.raw_value #>> '{}' = ANY($2::text[]))`, [rawNames]));
  return new Set(suspects.map(([key]) => key).filter((key) => (global.get(key)?.other ?? 0) === 0));
}

/**
 * Personas que la fuente SOLO nombra como uno de varios autores separados por
 * «/» («(Lennon/McCartney)» → «Lennon»). Se mira la evidencia del crédito: el
 * nombre pegado a una barra. Un solo crédito propio en cualquier ficha de la
 * fuente la saca de la lista.
 */
export async function loadSplitPartOnly(sourceId: number, section: PromotionSection): Promise<Set<string>> {
  const creditsOf = async (where: string, params: unknown[]) => (await getPool().query<{ name: string; excerpt: string | null }>(`
    SELECT c.raw_value #>> '{}' AS name, max(e.excerpt) AS excerpt
      FROM ingest.claims c LEFT JOIN ingest.claim_evidence e ON e.claim_id = c.id
     WHERE c.source_id = $1 AND c.entity_kind IN ('album_credit', 'track_credit') AND c.field = 'credited_name' AND ${where}
     GROUP BY c.raw_page_id, c.entity_kind, c.identity_key, c.raw_value #>> '{}'`, [sourceId, ...params])).rows;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const tally = (rows: Array<{ name: string; excerpt: string | null }>) => {
    const out = new Map<string, { split: number; other: number; raw: Set<string> }>();
    for (const row of rows) {
      if (!row.name) continue;
      const key = normalizeEntityName(row.name).primaryKey;
      const entry = out.get(key) ?? { split: 0, other: 0, raw: new Set<string>() };
      entry.raw.add(row.name);
      const name = escape(row.name);
      if (new RegExp(`(?:/\\s*${name}|${name}\\s*/)`, "u").test(row.excerpt ?? "")) entry.split += 1;
      else entry.other += 1;
      out.set(key, entry);
    }
    return out;
  };
  const local = tally(await creditsOf(`c.raw_page_id IN (SELECT id FROM ingest.raw_pages WHERE url LIKE $2)`, [`%sincopa.com/${section}/%`]));
  const suspects = [...local].filter(([, entry]) => entry.split > 0 && entry.other === 0);
  if (suspects.length === 0) return new Set();
  const global = tally(await creditsOf(`c.raw_value #>> '{}' = ANY($2::text[])`, [suspects.flatMap(([, entry]) => [...entry.raw])]));
  return new Set(suspects.map(([key]) => key).filter((key) => (global.get(key)?.other ?? 0) === 0));
}

/** Índice del core por nombre plegado (y por padre en discos y pistas). */
class CoreIndex {
  private readonly byKey = new Map<string, ExistingRef[]>();
  private readonly parentOf = new Map<number, number>();
  private readonly childrenOf = new Map<number, ExistingRef[]>();
  private constructor(private readonly kind: BulkKind) {}

  static async load(kind: BulkKind): Promise<CoreIndex> {
    const index = new CoreIndex(kind);
    const spec = CORE_TABLE[kind];
    const { rows } = await getPool().query<{ id: string; name: string; parent: string | null }>(
      `SELECT id::text, ${spec.name} AS name, ${spec.parent === undefined ? "NULL" : `${spec.parent}::text`} AS parent FROM ${spec.table}`);
    for (const row of rows) index.add(Number(row.id), row.name, row.parent === null ? undefined : Number(row.parent));
    return index;
  }

  add(id: number, name: string, parentId?: number): void {
    if (parentId !== undefined) {
      this.parentOf.set(id, parentId);
      const children = this.childrenOf.get(parentId);
      if (children === undefined) this.childrenOf.set(parentId, [{ id, name }]);
      else if (!children.some((ref) => ref.id === id)) children.push({ id, name });
    }
    const key = this.key(foldName(name), parentId);
    const list = this.byKey.get(key);
    if (list === undefined) this.byKey.set(key, [{ id, name }]);
    else if (!list.some((ref) => ref.id === id)) list.push({ id, name });
  }

  sameName(name: string, parentId?: number): ExistingRef[] {
    return this.byKey.get(this.key(foldName(name), parentId)) ?? [];
  }

  parentFor(id: number): number | undefined { return this.parentOf.get(id); }

  /** Hermanos del core bajo el padre (discos del artista, pistas del disco). */
  children(parentId: number): ExistingRef[] { return this.childrenOf.get(parentId) ?? []; }

  private key(folded: string, parentId?: number): string {
    return this.kind === "album" || this.kind === "track" ? `${parentId ?? "-"}|${folded}` : folded;
  }
}

/**
 * Evidencia del core para un disco o pista de título casi igual a un hermano:
 * el repertorio compartido (discos) o la pista en la misma posición (pistas).
 * Solo se consulta cuando hay un hermano parecido, que es la minoría.
 */
async function siblingEvidence(
  kind: BulkKind, item: IdentityRow, name: string, parentId: number, siblings: ExistingRef[], sourceId: number,
): Promise<{ repertoire?: Record<number, { shared: number; total: number; core: number }>; samePositionId?: number }> {
  const near = siblings.filter((ref) => nearness(name, ref.name, 1) !== undefined && foldName(ref.name) !== foldName(name));
  if (near.length === 0) return {};
  const pool = getPool();
  if (kind === "track") {
    const { rows } = await pool.query<{ id: string }>(`
      SELECT t.id::text FROM public.tracks t
       WHERE t.album_id = $1 AND t.track_number = (
         SELECT min((c.normalized_value #>> '{}')::int) FROM ingest.claims c
          WHERE c.source_id = $2 AND c.entity_kind = 'track' AND c.field = 'track_number' AND c.identity_key = $3
            AND c.status = 'candidate' AND (c.normalized_value #>> '{}') ~ '^[0-9]+$')`,
    [parentId, sourceId, item.identityKey]);
    return rows.length === 1 ? { samePositionId: Number(rows[0]!.id) } : {};
  }
  if (kind !== "album") return {};
  const { rows: own } = await pool.query<{ title: string }>(`
    SELECT DISTINCT c.normalized_value #>> '{}' AS title FROM ingest.claims c
     WHERE c.source_id = $1 AND c.entity_kind = 'track' AND c.field = 'title' AND c.status <> 'rejected'
       AND c.identity_raw LIKE $2 || '::%'`,
  [sourceId, item.identityRaw]);
  const titles = new Set(own.map((row) => foldName(row.title)).filter(Boolean));
  if (titles.size === 0) return {};
  const repertoire: Record<number, { shared: number; total: number; core: number }> = {};
  for (const ref of near) {
    const { rows } = await pool.query<{ title: string }>("SELECT title FROM public.tracks WHERE album_id = $1", [ref.id]);
    const core = new Set(rows.map((row) => foldName(row.title)));
    repertoire[ref.id] = { shared: [...titles].filter((title) => core.has(title)).length, total: titles.size, core: core.size };
  }
  return { repertoire };
}

/** Partes de la identidad `Artista::Disco::Pista` ya limpias. */
function identityParts(raw: string): string[] {
  return raw.split("::").map((part) => part.trim()).filter(Boolean);
}

/** `identity_key -> id` de lo que ya tiene destino en la fuente (artistas o discos). */
async function loadTargets(sourceId: number, kind: "artist" | "album"): Promise<Map<string, number>> {
  const column = kind === "artist" ? "artist_id" : "album_id";
  const { rows } = await getPool().query<{ identity_key: string; id: string }>(
    `SELECT identity_key, min(${column})::text AS id FROM ingest.claims
      WHERE source_id=$1 AND entity_kind=$2::ingest.claim_entity_kind AND ${column} IS NOT NULL AND identity_key IS NOT NULL
      GROUP BY identity_key HAVING count(DISTINCT ${column}) = 1`, [sourceId, kind]);
  return new Map(rows.map((row) => [row.identity_key, Number(row.id)]));
}

function emptySummary(): KindSummary {
  return { identities: 0, claims: 0, verdicts: {}, applied: 0, unchanged: 0, stillCandidate: 0, dismissed: 0, failed: 0 };
}

/**
 * Corre (o planea) la promoción de una sección. Sin `confirm` calcula el plan
 * completo —incluida la propagación de padres que crearía el propio lote— y no
 * escribe nada.
 */
export async function promoteSection(options: PromotionOptions): Promise<PromotionReport> {
  if (!options.note.trim()) throw new Error("nota de resolución obligatoria");
  const sourceSlug = options.sourceSlug ?? "sincopa";
  const sourceId = await sourceIdFor(sourceSlug);
  const kinds = options.kinds ?? PROMOTION_ORDER;
  const report: PromotionReport = {
    section: options.section, dryRun: !options.confirm, note: options.note, kinds: {}, holds: [], duplicateFlags: [], errors: [],
  };

  let runId: number | undefined;
  if (options.confirm) {
    const [run] = await getDb().insert(scrapeRuns).values({
      kind: "merge_run", status: "running", sourceId,
      params: { action: "bulk-promotion", section: options.section, note: options.note, kinds, limitPerKind: options.limitPerKind ?? null },
    }).returning();
    if (!run) throw new Error("no se pudo abrir el run de la promoción");
    runId = run.id;
    report.runId = run.id;
  }
  const batchNote = runId === undefined ? options.note.trim() : `[lote ${runId}] ${options.note.trim()}`;
  const decidedBy = options.decidedBy ?? "promoción masiva por reglas";

  const body = async (): Promise<void> => {
    // Padres «virtuales» del ensayo: lo que el lote real habría creado.
    let virtual = -1;
    const artistTargets = await loadTargets(sourceId, "artist");
    const albumTargets = await loadTargets(sourceId, "album");

    for (const kind of PROMOTION_ORDER) {
      if (!kinds.includes(kind)) continue;
      const summary = emptySummary();
      report.kinds[kind] = summary;
      const identities = await selectIdentities(sourceId, kind, options.section, options.limitPerKind, options.pageUrls);
      summary.identities = identities.length;
      summary.claims = identities.reduce((sum, item) => sum + item.claims, 0);
      if (identities.length === 0) continue;
      const bump = (rule: string): void => { summary.verdicts[rule] = (summary.verdicts[rule] ?? 0) + 1; };

      if (!ENTITY_KINDS.includes(kind as BulkKind)) {
        // Puentes: sin veredicto propio; se resuelven por el claim graph.
        await runInSnapshot(identities, async (item) => {
          bump("puente");
          if (!options.confirm) return;
          await approveSafely(report, summary, kind, item, batchNote, {});
        });
        continue;
      }

      const entityKind = kind as BulkKind;
      const decisions = await loadDecisions(sourceId, entityKind, identities.map((item) => item.identityKey));
      const index = await CoreIndex.load(entityKind);
      const titleParenthesisOnly = entityKind === "person" ? await loadTitleParenthesisOnly(sourceId, options.section) : new Set<string>();
      const splitPartOnly = entityKind === "person" ? await loadSplitPartOnly(sourceId, options.section) : new Set<string>();
      // Padre de cada candidata (discos → artista, pistas → disco) para compararla solo con sus pares.
      if (CORE_TABLE[entityKind].parent !== undefined) {
        for (const decision of decisions.values()) {
          for (const candidate of decision.candidates) {
            const parent = index.parentFor(candidate.id);
            if (parent !== undefined) candidate.parentId = parent;
          }
        }
      }

      await runInSnapshot(identities, async (item) => {
        const parts = identityParts(item.identityRaw);
        const name = entityKind === "album" || entityKind === "track" ? (parts.at(-1) ?? item.identityRaw) : item.identityRaw;
        let parentId: number | undefined;
        const options2: ApprovalOptions = {};
        if (entityKind === "album" && parts.length >= 2) {
          parentId = artistTargets.get(normalizeEntityName(parts[0]!).primaryKey);
          if (parentId !== undefined) options2.parentArtistId = parentId;
        } else if (entityKind === "track" && parts.length >= 3) {
          parentId = albumTargets.get(normalizeEntityName(`${parts[0]}::${parts[1]}`).primaryKey);
          if (parentId !== undefined) options2.parentAlbumId = parentId;
        }
        const siblings = parentId === undefined ? [] : index.children(parentId);
        const evidence = parentId === undefined ? {} : await siblingEvidence(entityKind, item, name, parentId, siblings, sourceId);
        const verdict: Verdict = decideVerdict({
          kind: entityKind, name, decision: decisions.get(item.identityKey),
          sameName: index.sameName(name, parentId),
          ...(parentId === undefined ? {} : { parentId, siblings }),
          ...evidence,
          ...(titleParenthesisOnly.has(item.identityKey) ? { onlyTitleParenthesis: true } : {}),
          ...(splitPartOnly.has(item.identityKey) ? { onlySplitPart: true } : {}),
        });
        bump(`${verdict.kind}:${verdict.rule}`);
        if (/casi-igual|anterior|sin-decision/u.test(verdict.rule) && verdict.kind !== "hold") {
          (report.evidenceVerdicts ??= []).push({
            kind, identityRaw: item.identityRaw, rule: verdict.rule,
            ...(verdict.kind === "same" ? { targetId: verdict.targetId } : {}),
            detail: [
              verdict.kind === "same" ? siblings.find((ref) => ref.id === verdict.targetId)?.name ?? "" : "",
              evidence.repertoire === undefined ? "" : JSON.stringify(evidence.repertoire),
            ].filter(Boolean).join(" "),
          });
        }

        if (verdict.kind === "hold") {
          report.holds.push({ kind, identityRaw: item.identityRaw, rule: verdict.rule, detail: verdict.detail, claims: item.claims });
          return;
        }
        if (verdict.kind === "dismiss") {
          if (options.confirm) {
            try {
              await dismissEntity(kind, item.identityKey, `${batchNote} · regla «${verdict.rule}»`);
              summary.dismissed += 1;
            } catch (error) {
              summary.failed += 1;
              if (report.errors.length < 200) report.errors.push({ kind, identityRaw: item.identityRaw, error: (error as Error).message });
            }
          }
          return;
        }
        if (verdict.kind === "different" && verdict.flag !== undefined) {
          report.duplicateFlags.push({ kind: entityKind, identityRaw: item.identityRaw, rule: verdict.rule, flag: verdict.flag });
        }

        const reference = `${decidedBy}: regla «${verdict.rule}», sección ${options.section}${runId === undefined ? "" : `, lote ${runId}`}`;
        const resolution: ApprovalOptions = { ...options2 };
        if (verdict.kind === "same") resolution.humanResolution = { verdict: "same", targetId: verdict.targetId, decidedBy, reference };
        else if (verdict.kind === "different") resolution.humanResolution = { verdict: "different", decidedBy, reference };

        if (!options.confirm) {
          // Ensayo: los hijos ven el padre que el lote real dejaría.
          if (verdict.kind === "different" || verdict.kind === "approve") {
            if (entityKind === "artist" && !artistTargets.has(item.identityKey)) artistTargets.set(item.identityKey, virtual--);
            if (entityKind === "album" && !albumTargets.has(item.identityKey)) albumTargets.set(item.identityKey, virtual--);
          } else if (verdict.kind === "same") {
            if (entityKind === "artist") artistTargets.set(item.identityKey, verdict.targetId);
            if (entityKind === "album") albumTargets.set(item.identityKey, verdict.targetId);
          }
          return;
        }

        const result = await approveSafely(report, summary, kind, item, batchNote, resolution);
        if (result?.targetId === undefined) return;
        index.add(result.targetId, name, parentId);
        if (entityKind === "artist") artistTargets.set(item.identityKey, result.targetId);
        if (entityKind === "album") albumTargets.set(item.identityKey, result.targetId);
        if (verdict.kind === "different" && verdict.flag !== undefined) {
          const last = report.duplicateFlags.at(-1);
          if (last !== undefined) last.targetId = result.targetId;
        }
      });
    }
  };

  try {
    if (runId === undefined) await body();
    else await withRunScope(runId, body);
  } catch (error) {
    if (runId !== undefined) await finishRun(runId, "failed", countersOf(report), (error as Error).message);
    throw error;
  }
  if (runId !== undefined) {
    await finishRun(runId, report.errors.length === 0 ? "ok" : "partial", countersOf(report),
      report.errors.length === 0 ? undefined : JSON.stringify(report.errors.slice(0, 50)));
  }
  log.info({ section: options.section, runId, dryRun: report.dryRun, holds: report.holds.length, flags: report.duplicateFlags.length, errors: report.errors.length }, "promoción de sección terminada");
  return report;
}

function countersOf(report: PromotionReport): object {
  const kinds: Record<string, unknown> = {};
  for (const [kind, summary] of Object.entries(report.kinds)) kinds[kind] = summary;
  return { section: report.section, kinds, holds: report.holds.length, duplicateFlags: report.duplicateFlags.length, errors: report.errors.length };
}

/** Lotes de 200 identidades con instantánea del catálogo por si algún puente cae al ER. */
async function runInSnapshot(items: IdentityRow[], fn: (item: IdentityRow) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 200) {
    const slice = items.slice(offset, offset + 200);
    await withCandidateSnapshot(async () => {
      for (const item of slice) await fn(item);
    });
  }
}

async function approveSafely(
  report: PromotionReport, summary: KindSummary, kind: PromotionKind, item: IdentityRow, note: string, options: ApprovalOptions,
): Promise<{ targetId?: number } | undefined> {
  try {
    const outcome = await approveEntity(kind, item.identityKey, note, options);
    summary.applied += outcome.applied;
    summary.unchanged += outcome.unchanged;
    summary.stillCandidate += outcome.stillCandidate + outcome.unsupported;
    return outcome.targetId === undefined ? {} : { targetId: outcome.targetId };
  } catch (error) {
    const message = (error as Error).message;
    // Otro proceso ya promovió esta identidad (personas compartidas entre secciones).
    if (message.startsWith("sin claims candidatos")) return undefined;
    summary.failed += 1;
    if (report.errors.length < 200) report.errors.push({ kind, identityRaw: item.identityRaw, error: message });
    return undefined;
  }
}
