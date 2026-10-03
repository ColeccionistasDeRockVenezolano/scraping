// CRV · Géneros en la base: taxonomía, evidencia, recálculo de filas `rule`,
// avisos en la cola de revisión y proyección de `albums.genre`.
//
// Único punto que escribe `ingest.artist_genres`/`ingest.album_genres` desde
// reglas. Lo que decide una persona (`decision_kind = 'human'`) no lo cambia
// ningún recálculo: solo recibe evidencia nueva que coincide, y lo que la
// contradice se convierte en aviso (PLAN_GENEROS §4).
import type { PoolClient } from "pg";
import { LIVE_GENRE_CLAIM_STATUSES, projectAlbumGenre, type ProjectionResult } from "../merge/genre-projection.js";
import {
  computeRuleAssignments, reconcileWithHuman,
  type AssignmentRole, type AssignmentStatus, type DesiredAssignment, type EvidenceRef, type GenreCase,
  type GenreClaimEvidence, type GenreEntityKind, type HumanAssignment,
} from "./rules.js";
import { buildTaxonomy, type AliasTarget, type GenreLevel, type GenreNode, type Taxonomy } from "./taxonomy.js";

export const GENRE_TABLE: Readonly<Record<GenreEntityKind, string>> = {
  artist: "ingest.artist_genres",
  album: "ingest.album_genres",
};
export const GENRE_COLUMN: Readonly<Record<GenreEntityKind, "artist_id" | "album_id">> = {
  artist: "artist_id",
  album: "album_id",
};
/** Columna de `review_queue` que ancla un aviso de género a su entidad. */
const REVIEW_COLUMN: Readonly<Record<GenreEntityKind, "artist_a_id" | "album_id">> = {
  artist: "artist_a_id",
  album: "album_id",
};
/**
 * Filas que el artista recibe de sus discos (migración 0036): las escribe solo
 * `ingest.crv_derive_artist_genres` y nunca cuentan como género propio.
 */
export const DERIVED_FROM_ALBUMS_SQL = (alias: string) => `(${alias}.source_kind = 'albums' AND ${alias}.decision_kind = 'rule')`;
/** Quién firma las filas que escriben las reglas (no es una persona). */
export const RULE_ACTOR = "sistema:reglas-de-generos";
/** Origen con que una fusión de artistas o álbumes abre su caso de género (primary_disagreement). */
export const MERGE_REVIEW_ORIGIN = "genres-merge";
/** Fuente cuyo texto es edición humana del catálogo, no una fuente externa. */
const EDITORIAL_SOURCES = new Set(["crv-operador"]);
/** Orígenes cuyas filas `rule` escriben (y borran) las reglas de §4. */
const RULE_OWNED_SOURCE_KINDS: ReadonlySet<string> = new Set(["catalog_source", "editorial"]);

export const GENRE_REVIEW_KIND = "genre_unknown";
const CASE_PRIORITY: Readonly<Record<GenreCase["genreCase"], number>> = {
  human_contradiction: 3, source_disagreement: 4, primary_disagreement: 4, compound_value: 5, unknown_value: 5,
};

export interface AssignmentRow {
  id: number;
  entityId: number;
  genreId: number;
  role: AssignmentRole;
  status: AssignmentStatus;
  confidence: string;
  sourceKind: string;
  sourceId: number | null;
  claimIds: number[];
  rawValue: string | null;
  evidence: EvidenceRef[];
  decidedBy: string | null;
  decisionRule: string;
  decisionKind: "rule" | "human";
  supersededById: number | null;
}

// --- Taxonomía -------------------------------------------------------------

export async function loadTaxonomy(client: PoolClient): Promise<Taxonomy> {
  const genres = await client.query<{ id: string; slug: string; name: string; level: GenreLevel; parent_genre_id: string | null; active: boolean; replaced_by_genre_id: string | null }>(
    "SELECT id::text, slug, name, level, parent_genre_id::text, active, replaced_by_genre_id::text FROM ingest.genres ORDER BY id");
  const aliases = await client.query<{ alias_normalized: string; kind: "genre" | "not_a_genre"; genre_id: string | null }>(
    "SELECT alias_normalized, kind, genre_id::text FROM ingest.genre_aliases ORDER BY alias_normalized");
  const nodes: GenreNode[] = genres.rows.map((row) => ({
    id: Number(row.id), slug: row.slug, name: row.name, level: row.level,
    parentId: row.parent_genre_id === null ? null : Number(row.parent_genre_id), active: row.active,
    replacedById: row.replaced_by_genre_id === null ? null : Number(row.replaced_by_genre_id),
  }));
  const targets: Array<[string, AliasTarget]> = aliases.rows.map((row) => [
    row.alias_normalized, row.kind === "genre" ? { kind: "genre", genreId: Number(row.genre_id) } : { kind: "not_a_genre" },
  ]);
  return buildTaxonomy(nodes, targets);
}

// --- Evidencia ------------------------------------------------------------

/** Claims `genre` vigentes por entidad. Un claim de artista nunca alimenta un álbum. */
export async function loadGenreClaims(
  client: PoolClient, kind: GenreEntityKind, entityIds?: number[],
): Promise<Map<number, GenreClaimEvidence[]>> {
  const column = GENRE_COLUMN[kind];
  const { rows } = await client.query<{
    id: string; entity_id: string; source_id: string; slug: string; created_by: string; value: string | null; url: string | null; excerpt: string | null;
  }>(`
    SELECT c.id::text, c.${column}::text AS entity_id, c.source_id::text, s.slug, c.created_by::text,
           c.raw_value #>> '{}' AS value, ev.url, ev.excerpt
      FROM ingest.claims c
      JOIN ingest.sources s ON s.id = c.source_id
      LEFT JOIN LATERAL (
        SELECT e.url, e.excerpt FROM ingest.claim_evidence e WHERE e.claim_id = c.id ORDER BY e.id LIMIT 1
      ) ev ON true
     WHERE c.field = 'genre' AND c.entity_kind = $1::ingest.claim_entity_kind
       AND c.${column} IS NOT NULL AND c.status::text = ANY($2::text[])
       AND ($3::bigint[] IS NULL OR c.${column} = ANY($3::bigint[]))
     ORDER BY c.${column}, c.id`, [kind, [...LIVE_GENRE_CLAIM_STATUSES], entityIds ?? null]);
  const byEntity = new Map<number, GenreClaimEvidence[]>();
  for (const row of rows) {
    if (row.value === null || !row.value.trim()) continue;
    const entityId = Number(row.entity_id);
    const list = byEntity.get(entityId) ?? [];
    list.push({
      claimId: Number(row.id), sourceId: Number(row.source_id), sourceSlug: row.slug,
      sourceKind: EDITORIAL_SOURCES.has(row.slug) || row.created_by === "human" ? "editorial" : "catalog_source",
      rawValue: row.value, url: row.url, excerpt: row.excerpt,
    });
    byEntity.set(entityId, list);
  }
  return byEntity;
}

function toRow(row: Record<string, unknown>, kind: GenreEntityKind): AssignmentRow {
  return {
    id: Number(row["id"]), entityId: Number(row[GENRE_COLUMN[kind]]), genreId: Number(row["genre_id"]),
    role: row["role"] as AssignmentRole, status: row["status"] as AssignmentStatus, confidence: String(row["confidence"]),
    sourceKind: String(row["source_kind"]), sourceId: row["source_id"] === null ? null : Number(row["source_id"]),
    claimIds: ((row["claim_ids"] as Array<string | number> | null) ?? []).map(Number),
    rawValue: (row["raw_value"] as string | null) ?? null, evidence: (row["evidence"] as EvidenceRef[] | null) ?? [],
    decidedBy: (row["decided_by"] as string | null) ?? null, decisionRule: String(row["decision_rule"]),
    decisionKind: row["decision_kind"] as "rule" | "human",
    supersededById: row["superseded_by_id"] === null ? null : Number(row["superseded_by_id"]),
  };
}

export async function loadAssignments(
  client: PoolClient, kind: GenreEntityKind, entityIds?: number[], lock = false,
): Promise<Map<number, AssignmentRow[]>> {
  const column = GENRE_COLUMN[kind];
  const { rows } = await client.query<Record<string, unknown>>(`
    SELECT * FROM ${GENRE_TABLE[kind]}
     WHERE ($1::bigint[] IS NULL OR ${column} = ANY($1::bigint[]))
     ORDER BY ${column}, id${lock ? " FOR UPDATE" : ""}`, [entityIds ?? null]);
  const byEntity = new Map<number, AssignmentRow[]>();
  for (const raw of rows) {
    const row = toRow(raw, kind);
    byEntity.set(row.entityId, [...(byEntity.get(row.entityId) ?? []), row]);
  }
  return byEntity;
}

// --- Escritura de filas `rule` --------------------------------------------

/** JSON con claves ordenadas: jsonb reordena las claves y no debe parecer un cambio. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function differs(row: AssignmentRow, desired: DesiredAssignment, supersededById: number | null): boolean {
  return row.role !== desired.role || row.status !== desired.status || row.confidence !== desired.confidence
    || row.sourceKind !== desired.sourceKind || row.sourceId !== desired.sourceId
    || !sameList(row.claimIds, desired.claimIds) || row.rawValue !== desired.rawValue
    || canonicalJson(row.evidence) !== canonicalJson(desired.evidence)
    || row.decisionRule !== desired.decisionRule || row.supersededById !== supersededById;
}

function mergeEvidence(existing: EvidenceRef[], extra: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set(existing.map((item) => item.claimId));
  return [...existing, ...extra.filter((item) => !seen.has(item.claimId))];
}

interface WriteStats { inserted: number; updated: number; deleted: number; humanEvidence: number }

async function writeRuleRows(
  client: PoolClient, kind: GenreEntityKind, entityId: number, existing: AssignmentRow[], desired: DesiredAssignment[],
  evidenceForHuman: Array<{ humanId: number; claimIds: number[]; evidence: EvidenceRef[] }>,
): Promise<WriteStats> {
  const table = GENRE_TABLE[kind];
  const column = GENRE_COLUMN[kind];
  const stats: WriteStats = { inserted: 0, updated: 0, deleted: 0, humanEvidence: 0 };
  // Las reglas solo mandan sobre lo que sale de los claims del catálogo. Una
  // sugerencia externa o de IA (etapas 4 y 5) es `rule` pero no la escriben las
  // reglas: ni se borra al recalcular ni se toca… salvo que la evidencia del
  // catálogo llegue a afirmar ese mismo género, y entonces la fila pasa a ser
  // de las reglas (la pareja ficha–género es única).
  const rules = existing.filter((row) => row.decisionKind === "rule" && RULE_OWNED_SOURCE_KINDS.has(row.sourceKind));
  const adoptable = new Map(existing
    .filter((row) => row.decisionKind === "rule" && !RULE_OWNED_SOURCE_KINDS.has(row.sourceKind))
    .map((row) => [row.genreId, row]));
  const byGenre = new Map(rules.map((row) => [row.genreId, row]));
  const wanted = new Map(desired.map((item) => [item.genreId, item]));

  // 1. Si el principal cambia de género, se suelta antes (índice único inmediato).
  const oldPrimary = rules.find((row) => row.role === "primary" && row.status === "confirmed");
  const newPrimary = desired.find((item) => item.role === "primary" && item.status === "confirmed");
  if (oldPrimary && oldPrimary.genreId !== newPrimary?.genreId) {
    await client.query(`UPDATE ${table} SET role = 'secondary', updated_at = now() WHERE id = $1`, [oldPrimary.id]);
    oldPrimary.role = "secondary";
  }
  // Un principal que el artista solo tenía por sus discos cede ante el propio
  // (al confirmar, la regla de 0036 lo recalcula como secundario).
  if (kind === "artist" && newPrimary) {
    await client.query(`
      UPDATE ${table} x SET role = 'secondary', updated_at = now()
       WHERE x.${column} = $1 AND x.role = 'primary' AND x.status = 'confirmed' AND x.genre_id <> $2
         AND ${DERIVED_FROM_ALBUMS_SQL("x")}`, [entityId, newPrimary.genreId]);
  }

  // 2. Filas `rule` que ya no tienen evidencia. Quien las citaba como reemplazo
  //    (una familia humana desplazada por un hijo) vuelve a estar confirmada.
  const removed = rules.filter((row) => !wanted.has(row.genreId));
  if (removed.length) {
    const ids = removed.map((row) => row.id);
    await client.query(`
      UPDATE ${table} SET status = 'confirmed', superseded_by_id = NULL, updated_at = now()
       WHERE superseded_by_id = ANY($1::bigint[]) AND decision_kind = 'human'`, [ids]);
    await client.query(`DELETE FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
    stats.deleted += ids.length;
  }

  // 3. Vigentes primero, desplazadas después: estas apuntan a aquellas.
  const idByGenre = new Map(existing.filter((row) => !removed.includes(row)).map((row) => [row.genreId, row.id]));
  const ordered = [...desired].sort((a, b) => Number(a.status === "superseded") - Number(b.status === "superseded") || a.genreId - b.genreId);
  for (const item of ordered) {
    const supersededById = item.supersededByGenreId === undefined ? null : idByGenre.get(item.supersededByGenreId) ?? null;
    if (item.status === "superseded" && supersededById === null) continue;
    const row = byGenre.get(item.genreId) ?? adoptable.get(item.genreId);
    const values = [
      item.role, item.status, item.confidence, item.sourceKind, item.sourceId, item.claimIds, item.rawValue,
      JSON.stringify(item.evidence), item.decisionRule, supersededById,
    ];
    if (row) {
      if (!differs(row, item, supersededById)) continue;
      // Adoptar una sugerencia externa: el catálogo ya afirma ese género, así
      // que la fila pasa a las reglas y suelta su referencia a la fuente externa.
      await client.query(`
        UPDATE ${table} SET role=$2, status=$3, confidence=$4, source_kind=$5, source_id=$6, claim_ids=$7::bigint[],
               raw_value=$8, evidence=$9::jsonb, decision_rule=$10, superseded_by_id=$11,
               decided_by=$12, decided_at=now(), updated_at=now(),
               external_source_id=NULL, external_ref=NULL
         WHERE id=$1`, [row.id, ...values, RULE_ACTOR]);
      stats.updated += 1;
    } else {
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO ${table}(${column}, genre_id, role, status, confidence, source_kind, source_id, claim_ids, raw_value,
                             evidence, decision_rule, superseded_by_id, decided_by, decision_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::bigint[],$9,$10::jsonb,$11,$12,$13,'rule') RETURNING id::text`,
      [entityId, item.genreId, ...values, RULE_ACTOR]);
      idByGenre.set(item.genreId, Number(inserted.rows[0]!.id));
      stats.inserted += 1;
    }
  }

  // 4. Evidencia nueva que coincide con una decisión humana: se añade, nada más.
  for (const extra of evidenceForHuman) {
    const row = existing.find((item) => item.id === extra.humanId);
    if (!row) continue;
    const claimIds = [...new Set([...row.claimIds, ...extra.claimIds])].sort((a, b) => a - b);
    if (sameList(claimIds, row.claimIds)) continue;
    await client.query(`UPDATE ${table} SET claim_ids=$2::bigint[], evidence=$3::jsonb, updated_at=now() WHERE id=$1`,
      [row.id, claimIds, JSON.stringify(mergeEvidence(row.evidence, extra.evidence))]);
    stats.humanEvidence += 1;
  }
  return stats;
}

// --- Cola de revisión -----------------------------------------------------

interface ReviewStats { opened: number; closed: number }

/**
 * Abre los casos nuevos y cierra los que el recálculo ya no produce. Un caso
 * que una persona cerró no se reabre con la misma huella: solo evidencia nueva
 * (otra huella) vuelve a pedir atención.
 */
export async function syncGenreReviews(
  client: PoolClient, kind: GenreEntityKind, entityId: number, cases: GenreCase[], runId?: number,
): Promise<ReviewStats> {
  const column = REVIEW_COLUMN[kind];
  const { rows } = await client.query<{ id: string; status: string; fingerprint: string }>(`
    SELECT id::text, status::text, payload->>'fingerprint' AS fingerprint
      FROM ingest.review_queue
     WHERE kind = $1::ingest.review_kind AND ${column} = $2 AND payload->>'origin' = 'genres'
       AND payload->>'entityKind' = $3`, [GENRE_REVIEW_KIND, entityId, kind]);
  const wanted = new Map(cases.map((item) => [item.fingerprint, item]));
  const stats: ReviewStats = { opened: 0, closed: 0 };
  const stale = rows.filter((row) => (row.status === "open" || row.status === "in_progress") && !wanted.has(row.fingerprint));
  if (stale.length) {
    await client.query(`
      UPDATE ingest.review_queue
         SET status = 'dismissed', resolved_by = 'system', resolved_at = now(), updated_at = now(),
             resolution_note = concat_ws(' · ', resolution_note, $2::text)
       WHERE id = ANY($1::bigint[])`, [stale.map((row) => row.id), `el recálculo de géneros ya no lo produce${runId ? ` (run ${runId})` : ""}`]);
    stats.closed = stale.length;
  }
  const known = new Set(rows.map((row) => row.fingerprint));
  for (const item of cases) {
    if (known.has(item.fingerprint)) continue;
    await client.query(`
      INSERT INTO ingest.review_queue(kind, priority, claim_a_id, ${column}, payload, notes)
      VALUES($1::ingest.review_kind, $2, $3, $4, $5::jsonb, $6)`, [
      GENRE_REVIEW_KIND, CASE_PRIORITY[item.genreCase], item.claimIds[0] ?? null, entityId,
      JSON.stringify({ origin: "genres", entityKind: kind, entityId, genreCase: item.genreCase, fingerprint: item.fingerprint, claimIds: item.claimIds, ...item.detail }),
      `género: ${item.genreCase}`,
    ]);
    stats.opened += 1;
  }
  return stats;
}

// --- Recálculo ------------------------------------------------------------

export interface RecomputeResult {
  kind: GenreEntityKind;
  entityId: number;
  write: WriteStats;
  reviews: ReviewStats;
  primaryPending: boolean;
  projection?: ProjectionResult;
}

export interface RecomputeOptions {
  runId?: number | undefined;
  /** Evidencia ya cargada (backfill): evita una consulta por entidad. */
  claims?: GenreClaimEvidence[];
  assignments?: AssignmentRow[];
  /** false: no tocar `albums.genre` (lo hace quien llama, p. ej. tras una fusión). */
  project?: boolean;
}

/** Recalcula las filas `rule` de una entidad a partir de su evidencia actual. */
export async function recomputeEntityGenres(
  client: PoolClient, taxonomy: Taxonomy, kind: GenreEntityKind, entityId: number, options: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const claims = options.claims ?? (await loadGenreClaims(client, kind, [entityId])).get(entityId) ?? [];
  const existing = options.assignments ?? (await loadAssignments(client, kind, [entityId], true)).get(entityId) ?? [];
  const human: HumanAssignment[] = existing.filter((row) => row.decisionKind === "human").map((row) => ({
    id: row.id, genreId: row.genreId, role: row.role, status: row.status, decidedBy: row.decidedBy ?? "",
  }));
  const outcome = computeRuleAssignments(taxonomy, claims);
  const reconciled = reconcileWithHuman(taxonomy, outcome, human);
  const write = await writeRuleRows(client, kind, entityId, existing, reconciled.assignments, reconciled.evidenceForHuman);
  const reviews = await syncGenreReviews(client, kind, entityId, reconciled.cases, options.runId);
  const result: RecomputeResult = { kind, entityId, write, reviews, primaryPending: outcome.primaryPending };
  if (kind === "album" && options.project !== false) {
    result.projection = await projectAlbumGenre(client, entityId, { runId: options.runId });
  }
  return result;
}

/** Recálculo de una entidad cargando la taxonomía (para el motor de fusión y las fusiones). */
export async function syncEntityGenres(
  client: PoolClient, kind: GenreEntityKind, entityId: number, options: { runId?: number | undefined; project?: boolean } = {},
): Promise<RecomputeResult> {
  const taxonomy = await loadTaxonomy(client);
  return recomputeEntityGenres(client, taxonomy, kind, entityId, options);
}

/** Lock de toda escritura automática de géneros: backfill, taxonomía y recálculos. */
export async function lockGenres(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('genres:sync'))");
}
