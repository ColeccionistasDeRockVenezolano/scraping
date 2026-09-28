// CRV · Curaduría editorial de géneros (PLAN_GENEROS etapa 3).
//
// Lo que la Mesa de Cotejo necesita para resolver géneros: la cola priorizada,
// la ficha con toda su evidencia, el vocabulario, las métricas y las acciones.
//
//  * CADA ACCIÓN ES UN RUN. Se abre con `withOperatorRun`, así que todo lo que
//    cambia (asignaciones, `albums.genre`, la cola) queda en el diario ligado a
//    ese run y se puede deshacer desde el historial de cambios.
//  * EL ACTOR LO PONE EL SERVIDOR. Las funciones reciben `actor` ya resuelto
//    desde la sesión de herra (`herra:<usuario>`); nunca del navegador.
//  * EL LOTE SE VERIFICA. Solo se aplica en bloque lo que comparte una regla
//    comprobable (el mismo texto de fuente, normalizado) y solo si la lista que
//    vio la persona es exactamente la que el servidor calcula en ese momento.
//  * EL GÉNERO DEL ARTISTA ES CONTEXTO. La ficha de un álbum lo muestra aparte,
//    marcado «del artista, no del disco»; ninguna acción lo usa como evidencia.
import type { PoolClient } from "pg";
import { withOperatorRun } from "../merge/operator.js";
import {
  confirmGenre, EDITORIAL_REVIEW_ORIGIN, markInsufficientEvidence, rejectGenre, reopenEntity, requestNewTerm,
  revertGenreDecision, type HumanDecisionInput,
} from "./human.js";
import { EXTERNAL_REVIEW_ORIGIN } from "./external/store.js";
import { normalizeGenreText } from "./normalize.js";
import type { GenreEntityKind } from "./rules.js";
import { GENRE_REVIEW_KIND, MERGE_REVIEW_ORIGIN, loadTaxonomy, lockGenres, type RecomputeResult } from "./store.js";
import { familyOf, resolveGenreValue } from "./taxonomy.js";

/** Canal oficial cuya discografía alimenta la Radio CRV (scripts/export-radio-catalog.ts). */
export const RADIO_CHANNEL_ID = "UCtYlrz6GyvRahlhHjocWQYQ";

export const GENRE_ACTIONS = [
  "confirm_primary", "add_secondary", "reject", "revert", "insufficient_evidence", "reopen", "request_new_term",
] as const;
export type GenreAction = typeof GENRE_ACTIONS[number];

export const QUEUE_CATEGORIES = [
  "unclassified", "genre_unknown", "compound", "disagreement", "contradiction", "new_term", "external_suggestion", "ai_suggestion",
] as const;
export type QueueCategory = typeof QUEUE_CATEGORIES[number];

/**
 * Orígenes de los casos de género en la cola: los que abren las reglas, los
 * que abre una persona (etapa 3), los que abre la importación externa
 * (etapa 4) y los que abre una fusión (primary_disagreement). Todos se
 * resuelven en la misma Mesa.
 */
export const GENRE_REVIEW_ORIGINS = ["genres", EDITORIAL_REVIEW_ORIGIN, EXTERNAL_REVIEW_ORIGIN, MERGE_REVIEW_ORIGIN] as const;

export class GenreCurationError extends Error {
  constructor(public readonly code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
  }
}

// --- Acciones ---------------------------------------------------------------

export interface GenreDecisionRequest {
  action: GenreAction;
  kind: GenreEntityKind;
  entityId: number;
  genreSlug?: string | undefined;
  actor: string;
  reason: string;
  /** Casos de la cola que motivaron la decisión. */
  reviewIds?: number[] | undefined;
  /** Cerrar esos casos. Por omisión: sí al confirmar el principal, marcar evidencia insuficiente o pedir un término. */
  closeCases?: boolean | undefined;
  proposedName?: string | undefined;
  familySlug?: string | undefined;
  rawValue?: string | undefined;
}

export interface GenreDecisionResult {
  runId: number;
  action: GenreAction;
  kind: GenreEntityKind;
  entityId: number;
  closedReviewIds: number[];
  newReviewId?: number;
  albumGenre?: { before: string | null; after: string | null; changed: boolean };
}

const CLOSES_BY_DEFAULT: ReadonlySet<GenreAction> = new Set(["confirm_primary", "insufficient_evidence", "request_new_term"]);

function requireSlug(request: GenreDecisionRequest): string {
  const slug = request.genreSlug?.trim();
  if (!slug) throw new GenreCurationError("invalid", `la acción ${request.action} necesita un género`);
  return slug;
}

/** Traduce los errores de dominio de human.ts a errores de la API. */
function domainError(error: unknown): never {
  if (error instanceof GenreCurationError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/inexistente/u.test(message)) throw new GenreCurationError("not_found", message);
  if (/inactivo|familia de un género|no hay decisión humana|no está marcado|exige actor|falta el nombre/u.test(message)) {
    throw new GenreCurationError("conflict", message);
  }
  throw error;
}

/** Cierra, a nombre de la persona, los casos de género de ESA entidad que motivaron la decisión. */
async function closeCases(
  client: PoolClient, request: GenreDecisionRequest, verdict: "approved" | "dismissed",
): Promise<number[]> {
  const ids = [...new Set(request.reviewIds ?? [])];
  if (!ids.length) return [];
  // El recálculo de esta misma transacción pudo cerrarlos ya como `system`
  // (la decisión los resolvió): se reatribuyen a quien decidió.
  const { rows } = await client.query<{ id: string }>(`
    UPDATE ingest.review_queue
       SET status = $2::ingest.review_status, resolved_by = 'human', resolved_at = now(), updated_at = now(),
           resolution_note = $3
     WHERE id = ANY($1::bigint[]) AND kind = $4::ingest.review_kind
       AND payload->>'origin' = ANY($5::text[]) AND payload->>'entityKind' = $6 AND (payload->>'entityId')::bigint = $7
       AND (status IN ('open','in_progress') OR (resolved_by = 'system' AND resolved_at = now()))
     RETURNING id::text`, [
    ids, verdict, `${request.actor} · ${request.action} · ${request.reason}`.slice(0, 1000),
    GENRE_REVIEW_KIND, GENRE_REVIEW_ORIGINS, request.kind, request.entityId,
  ]);
  return rows.map((row) => Number(row.id));
}

async function applyDecision(client: PoolClient, request: GenreDecisionRequest, runId: number): Promise<Omit<GenreDecisionResult, "runId">> {
  const base: HumanDecisionInput = {
    kind: request.kind, entityId: request.entityId, genreSlug: request.genreSlug ?? "", actor: request.actor, reason: request.reason, runId,
  };
  const note = { kind: request.kind, entityId: request.entityId, actor: request.actor, reason: request.reason, runId };
  let recompute: RecomputeResult | undefined;
  let newReviewId: number | undefined;
  try {
    switch (request.action) {
      case "confirm_primary":
        recompute = await confirmGenre(client, { ...base, genreSlug: requireSlug(request), role: "primary" });
        break;
      case "add_secondary":
        recompute = await confirmGenre(client, { ...base, genreSlug: requireSlug(request), role: "secondary" });
        break;
      case "reject":
        recompute = await rejectGenre(client, { ...base, genreSlug: requireSlug(request) });
        break;
      case "revert":
        recompute = await revertGenreDecision(client, { ...base, genreSlug: requireSlug(request) });
        break;
      case "insufficient_evidence":
        await markInsufficientEvidence(client, note);
        break;
      case "reopen":
        await reopenEntity(client, note);
        break;
      case "request_new_term":
        if (!request.proposedName?.trim()) throw new GenreCurationError("invalid", "falta el nombre del término propuesto");
        newReviewId = await requestNewTerm(client, {
          ...note, proposedName: request.proposedName, familySlug: request.familySlug?.trim() || undefined, rawValue: request.rawValue,
        });
        break;
    }
  } catch (error) {
    domainError(error);
  }
  const shouldClose = request.closeCases ?? CLOSES_BY_DEFAULT.has(request.action);
  const verdict = request.action === "confirm_primary" || request.action === "add_secondary" ? "approved" : "dismissed";
  const closedReviewIds = shouldClose ? await closeCases(client, request, verdict) : [];
  const projection = recompute?.projection;
  return {
    action: request.action, kind: request.kind, entityId: request.entityId, closedReviewIds,
    ...(newReviewId === undefined ? {} : { newReviewId }),
    ...(projection ? { albumGenre: { before: projection.before, after: projection.after, changed: projection.changed } } : {}),
  };
}

function validateRequest(request: GenreDecisionRequest): void {
  if (!GENRE_ACTIONS.includes(request.action)) throw new GenreCurationError("invalid", `acción desconocida: ${request.action}`);
  if (request.kind !== "album" && request.kind !== "artist") throw new GenreCurationError("invalid", "kind debe ser album o artist");
  if (!Number.isSafeInteger(request.entityId) || request.entityId <= 0) throw new GenreCurationError("invalid", "entityId inválido");
  if (!request.actor.trim()) throw new GenreCurationError("invalid", "falta quién decide");
  if (!request.reason.trim()) throw new GenreCurationError("invalid", "toda decisión de género necesita un motivo");
}

/** Una decisión humana, en su propio run. */
export async function decideGenre(request: GenreDecisionRequest): Promise<GenreDecisionResult> {
  validateRequest(request);
  const { runId, result } = await withOperatorRun({
    name: "genre_decision", operator: request.actor, note: request.reason,
    params: { genreAction: request.action, entityKind: request.kind, entityId: request.entityId, genreSlug: request.genreSlug ?? null },
  }, async ({ client, runId: run }) => {
    await lockGenres(client);
    return applyDecision(client, request, run);
  });
  return { runId, ...result };
}

// --- Lotes ------------------------------------------------------------------

/** Acciones que admiten lote: todas comparten el mismo género sobre el mismo texto de fuente. */
export const BATCH_ACTIONS = ["confirm_primary", "add_secondary", "insufficient_evidence"] as const;
export type BatchAction = typeof BATCH_ACTIONS[number];
export const MAX_BATCH = 200;

export interface BatchMember { reviewId: number; entityId: number; title: string; artistName: string | null; rawValue: string; sourceSlug: string }

/**
 * La regla verificable de un lote: casos abiertos de valor desconocido o
 * compuesto, del mismo nivel, cuyo texto de fuente normaliza igual.
 */
export async function batchMembers(client: PoolClient, kind: GenreEntityKind, rawValue: string): Promise<BatchMember[]> {
  const key = normalizeGenreText(rawValue);
  if (!key) return [];
  const { rows } = await client.query<{ review_id: string; entity_id: string; raw_value: string; source_slug: string; title: string | null; artist_name: string | null }>(`
    SELECT q.id::text AS review_id, (q.payload->>'entityId') AS entity_id, q.payload->>'rawValue' AS raw_value,
           q.payload->>'sourceSlug' AS source_slug,
           CASE WHEN $1 = 'album' THEN al.title ELSE ar.name END AS title,
           CASE WHEN $1 = 'album' THEN alar.name END AS artist_name
      FROM ingest.review_queue q
      LEFT JOIN public.albums al ON $1 = 'album' AND al.id = (q.payload->>'entityId')::bigint
      LEFT JOIN public.artists alar ON alar.id = al.artist_id
      LEFT JOIN public.artists ar ON $1 = 'artist' AND ar.id = (q.payload->>'entityId')::bigint
     WHERE q.kind = $2::ingest.review_kind AND q.status IN ('open','in_progress') AND q.payload->>'origin' = 'genres'
       AND q.payload->>'entityKind' = $1 AND q.payload->>'genreCase' IN ('unknown_value','compound_value')
     ORDER BY q.id`, [kind, GENRE_REVIEW_KIND]);
  return rows.filter((row) => normalizeGenreText(row.raw_value ?? "") === key).map((row) => ({
    reviewId: Number(row.review_id), entityId: Number(row.entity_id), title: row.title ?? "(ficha retirada)",
    artistName: row.artist_name, rawValue: row.raw_value, sourceSlug: row.source_slug,
  }));
}

export interface BatchGroup { kind: GenreEntityKind; rawValue: string; normalized: string; cases: number; entities: number }

/** Textos de fuente repetidos en varios casos abiertos: los candidatos a lote. */
export async function listBatchGroups(client: PoolClient): Promise<BatchGroup[]> {
  const { rows } = await client.query<{ kind: GenreEntityKind; raw_value: string; entity_id: string }>(`
    SELECT q.payload->>'entityKind' AS kind, q.payload->>'rawValue' AS raw_value, q.payload->>'entityId' AS entity_id
      FROM ingest.review_queue q
     WHERE q.kind = $1::ingest.review_kind AND q.status IN ('open','in_progress') AND q.payload->>'origin' = 'genres'
       AND q.payload->>'genreCase' IN ('unknown_value','compound_value')`, [GENRE_REVIEW_KIND]);
  const groups = new Map<string, { kind: GenreEntityKind; rawValue: string; normalized: string; cases: number; entities: Set<string> }>();
  for (const row of rows) {
    const normalized = normalizeGenreText(row.raw_value ?? "");
    if (!normalized) continue;
    const key = `${row.kind}:${normalized}`;
    const group = groups.get(key) ?? { kind: row.kind, rawValue: row.raw_value, normalized, cases: 0, entities: new Set<string>() };
    group.cases += 1;
    group.entities.add(row.entity_id);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.entities.size > 1)
    .map((group) => ({ kind: group.kind, rawValue: group.rawValue, normalized: group.normalized, cases: group.cases, entities: group.entities.size }))
    .sort((a, b) => b.entities - a.entities || a.normalized.localeCompare(b.normalized));
}

export interface BatchRequest {
  action: BatchAction;
  kind: GenreEntityKind;
  rawValue: string;
  genreSlug?: string | undefined;
  /** La lista completa que vio la persona: debe coincidir con la del servidor. */
  expectedReviewIds: number[];
  actor: string;
  reason: string;
}

export interface BatchResult { runId: number; applied: number; entities: number[]; closedReviewIds: number[] }

export async function applyGenreBatch(request: BatchRequest): Promise<BatchResult> {
  if (!BATCH_ACTIONS.includes(request.action)) throw new GenreCurationError("invalid", `acción sin lote: ${request.action}`);
  if (request.action !== "insufficient_evidence" && !request.genreSlug?.trim()) throw new GenreCurationError("invalid", "el lote necesita un género");
  const expected = [...new Set(request.expectedReviewIds)].sort((a, b) => a - b);
  if (!expected.length) throw new GenreCurationError("invalid", "el lote está vacío");
  if (expected.length > MAX_BATCH) throw new GenreCurationError("invalid", `un lote admite hasta ${MAX_BATCH} casos`);
  validateRequest({ action: request.action, kind: request.kind, entityId: 1, actor: request.actor, reason: request.reason });
  const { runId, result } = await withOperatorRun({
    name: "genre_batch", operator: request.actor, note: request.reason,
    params: { genreAction: request.action, entityKind: request.kind, rawValue: request.rawValue, genreSlug: request.genreSlug ?? null, cases: expected.length },
  }, async ({ client, runId: run }) => {
    await lockGenres(client);
    const members = await batchMembers(client, request.kind, request.rawValue);
    const current = members.map((member) => member.reviewId).sort((a, b) => a - b);
    if (current.length !== expected.length || current.some((id, index) => id !== expected[index])) {
      throw new GenreCurationError("conflict", "la lista del lote cambió desde que la viste; vuelve a cargarla y revísala entera");
    }
    const byEntity = new Map<number, number[]>();
    for (const member of members) byEntity.set(member.entityId, [...(byEntity.get(member.entityId) ?? []), member.reviewId]);
    const closed: number[] = [];
    for (const [entityId, reviewIds] of byEntity) {
      const outcome = await applyDecision(client, {
        action: request.action, kind: request.kind, entityId, genreSlug: request.genreSlug, actor: request.actor,
        reason: `${request.reason} (lote «${request.rawValue}»)`, reviewIds, closeCases: true,
      }, run);
      closed.push(...outcome.closedReviewIds);
    }
    return { applied: byEntity.size, entities: [...byEntity.keys()], closedReviewIds: closed };
  });
  return { runId, ...result };
}

// --- Lectura: cola ------------------------------------------------------------

export interface QueueItem {
  kind: GenreEntityKind;
  entityId: number;
  title: string;
  artistName: string | null;
  year: number | null;
  coverUrl: string | null;
  visibleGenre: string | null;
  categories: QueueCategory[];
  reviewIds: number[];
  rawValues: string[];
  tier: number;
  radio: boolean;
  trackCount: number;
}

export interface QueuePage { items: QueueItem[]; total: number; counts: Record<QueueCategory, number>; byKind: Record<GenreEntityKind, number> }

/**
 * Cola priorizada (etapa 3, punto 6): 1 álbumes con canciones de la radio,
 * 2 artistas con canciones de la radio, 3 conflictos, 4 álbumes con pistas
 * (más pistas primero), 5 el resto.
 */
const QUEUE_SQL = `
  WITH radio_albums AS (
    SELECT DISTINCT va.album_id FROM media.video_albums va JOIN media.youtube_videos v ON v.id = va.video_id
     WHERE v.channel_id = $1 AND v.publication_status = 'published'
       AND COALESCE((v.metadata->'status'->>'embeddable')::boolean, false)
       AND (SELECT count(*) FROM media.youtube_tracklist_entries t WHERE t.video_id = v.id) >= 2
  ), radio_artists AS (
    SELECT DISTINCT al.artist_id FROM public.albums al JOIN radio_albums r ON r.album_id = al.id
  ), cases AS (
    SELECT q.payload->>'entityKind' AS kind, (q.payload->>'entityId')::bigint AS entity_id, q.id AS review_id,
           CASE q.payload->>'genreCase'
             WHEN 'unknown_value' THEN 'genre_unknown' WHEN 'compound_value' THEN 'compound'
             WHEN 'source_disagreement' THEN 'disagreement' WHEN 'primary_disagreement' THEN 'disagreement'
             WHEN 'human_contradiction' THEN 'contradiction' WHEN 'new_term' THEN 'new_term'
             WHEN 'external_disagreement' THEN 'disagreement'
             WHEN 'external_ambiguous_identity' THEN 'external_suggestion'
             WHEN 'external_unmapped_term' THEN 'external_suggestion'
             WHEN 'external_too_generic' THEN 'external_suggestion' ELSE 'genre_unknown' END AS category,
           COALESCE(q.payload->>'rawValue', q.payload->>'proposedName') AS raw_value
      FROM ingest.review_queue q
     WHERE q.kind = 'genre_unknown' AND q.status IN ('open','in_progress')
       AND q.payload->>'origin' IN ('genres', 'genres-editorial', 'genres-external') AND q.payload ? 'entityId'
  ), suggestions AS (
    SELECT 'album' AS kind, album_id AS entity_id, NULL::bigint AS review_id,
           CASE source_kind WHEN 'ai' THEN 'ai_suggestion' ELSE 'external_suggestion' END AS category, raw_value
      FROM ingest.album_genres WHERE status = 'suggested' AND source_kind IN ('external','ai')
    UNION ALL
    SELECT 'artist', artist_id, NULL, CASE source_kind WHEN 'ai' THEN 'ai_suggestion' ELSE 'external_suggestion' END, raw_value
      FROM ingest.artist_genres WHERE status = 'suggested' AND source_kind IN ('external','ai')
  ), flagged AS (
    SELECT kind, entity_id, array_agg(DISTINCT category) AS categories,
           COALESCE(array_agg(review_id ORDER BY review_id) FILTER (WHERE review_id IS NOT NULL), '{}') AS review_ids,
           COALESCE(array_agg(DISTINCT raw_value) FILTER (WHERE raw_value IS NOT NULL), '{}') AS raw_values
      FROM (SELECT * FROM cases UNION ALL SELECT * FROM suggestions) x GROUP BY kind, entity_id
  ), set_aside AS (
    SELECT DISTINCT ON (entity_kind, entity_id) entity_kind AS kind, entity_id, action
      FROM ingest.genre_assignment_log WHERE action IN ('insufficient_evidence','reopen')
     ORDER BY entity_kind, entity_id, id DESC
  ), unclassified AS (
    SELECT 'album' AS kind, a.id AS entity_id, ARRAY['unclassified'] AS categories, '{}'::bigint[] AS review_ids, '{}'::text[] AS raw_values
      FROM public.albums a
     WHERE NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = a.id AND g.status IN ('confirmed','suggested'))
    UNION ALL
    SELECT 'artist', a.id, ARRAY['unclassified'], '{}'::bigint[], '{}'::text[]
      FROM public.artists a
     WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.status IN ('confirmed','suggested'))
  ), items AS (
    SELECT * FROM flagged
    UNION ALL
    SELECT u.* FROM unclassified u
     WHERE NOT EXISTS (SELECT 1 FROM flagged f WHERE f.kind = u.kind AND f.entity_id = u.entity_id)
       AND NOT EXISTS (SELECT 1 FROM set_aside s WHERE s.kind = u.kind AND s.entity_id = u.entity_id AND s.action = 'insufficient_evidence')
  ), enriched AS (
    SELECT i.*,
           CASE WHEN i.kind = 'album' THEN al.title ELSE ar.name END AS title,
           CASE WHEN i.kind = 'album' THEN alar.name END AS artist_name,
           al.release_year AS year, al.cover_url, al.genre AS visible_genre,
           CASE WHEN i.kind = 'album' THEN (SELECT count(*) FROM public.tracks t WHERE t.album_id = i.entity_id)
                ELSE (SELECT count(*) FROM public.tracks t JOIN public.albums x ON x.id = t.album_id WHERE x.artist_id = i.entity_id) END::int AS track_count,
           CASE WHEN i.kind = 'album' THEN EXISTS (SELECT 1 FROM radio_albums r WHERE r.album_id = i.entity_id)
                ELSE EXISTS (SELECT 1 FROM radio_artists r WHERE r.artist_id = i.entity_id) END AS radio
      FROM items i
      LEFT JOIN public.albums al ON i.kind = 'album' AND al.id = i.entity_id
      LEFT JOIN public.artists alar ON alar.id = al.artist_id
      LEFT JOIN public.artists ar ON i.kind = 'artist' AND ar.id = i.entity_id
     WHERE (i.kind = 'album' AND al.id IS NOT NULL) OR (i.kind = 'artist' AND ar.id IS NOT NULL)
  ), ranked AS (
    SELECT e.*, CASE
             WHEN e.kind = 'album' AND e.radio THEN 1
             WHEN e.kind = 'artist' AND e.radio THEN 2
             WHEN e.categories && ARRAY['disagreement','contradiction'] THEN 3
             WHEN e.kind = 'album' AND e.track_count > 0 THEN 4
             ELSE 5 END AS tier
      FROM enriched e
  )`;

export interface QueueQuery { category?: QueueCategory | undefined; kind?: GenreEntityKind | undefined; search?: string | undefined; limit?: number; offset?: number }

export async function listGenreQueue(client: PoolClient, query: QueueQuery = {}): Promise<QueuePage> {
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const offset = Math.max(0, query.offset ?? 0);
  const search = query.search?.trim() ? `%${query.search.trim().toLowerCase()}%` : null;
  const filters = `WHERE ($2::text IS NULL OR $2 = ANY(categories)) AND ($3::text IS NULL OR kind = $3)
                     AND ($4::text IS NULL OR lower(title) LIKE $4 OR lower(COALESCE(artist_name,'')) LIKE $4)`;
  // Secuencial: un mismo cliente de pg no admite consultas en paralelo.
  const page = await client.query<Record<string, unknown>>(`${QUEUE_SQL}
      SELECT *, count(*) OVER () AS total FROM ranked ${filters}
       ORDER BY tier, track_count DESC, kind, entity_id LIMIT $5 OFFSET $6`,
    [RADIO_CHANNEL_ID, query.category ?? null, query.kind ?? null, search, limit, offset]);
  const counts = await client.query<{ category: QueueCategory | null; kind: GenreEntityKind | null; n: number }>(`${QUEUE_SQL}
      SELECT c.category, NULL::text AS kind, count(*)::int AS n FROM ranked, unnest(categories) AS c(category) GROUP BY c.category
      UNION ALL SELECT NULL, kind, count(*)::int FROM ranked GROUP BY kind`, [RADIO_CHANNEL_ID]);
  const categoryCounts = Object.fromEntries(QUEUE_CATEGORIES.map((category) => [category, 0])) as Record<QueueCategory, number>;
  const byKind: Record<GenreEntityKind, number> = { album: 0, artist: 0 };
  for (const row of counts.rows) {
    if (row.category) categoryCounts[row.category] = row.n;
    else if (row.kind) byKind[row.kind] = row.n;
  }
  return {
    total: Number(page.rows[0]?.["total"] ?? 0),
    counts: categoryCounts,
    byKind,
    items: page.rows.map((row) => ({
      kind: row["kind"] as GenreEntityKind, entityId: Number(row["entity_id"]), title: String(row["title"] ?? ""),
      artistName: (row["artist_name"] as string | null) ?? null, year: (row["year"] as number | null) ?? null,
      coverUrl: (row["cover_url"] as string | null) ?? null, visibleGenre: (row["visible_genre"] as string | null) ?? null,
      categories: row["categories"] as QueueCategory[], reviewIds: (row["review_ids"] as string[]).map(Number),
      rawValues: row["raw_values"] as string[], tier: Number(row["tier"]), radio: row["radio"] === true,
      trackCount: Number(row["track_count"]),
    })),
  };
}

// --- Lectura: ficha -----------------------------------------------------------

export interface GenreRef { id: number; slug: string; name: string; level: "family" | "genre"; family: string | null; active: boolean }

async function genreRefs(client: PoolClient): Promise<Map<number, GenreRef>> {
  const taxonomy = await loadTaxonomy(client);
  const refs = new Map<number, GenreRef>();
  for (const genre of taxonomy.genres.values()) {
    refs.set(genre.id, { id: genre.id, slug: genre.slug, name: genre.name, level: genre.level, family: familyOf(taxonomy, genre.id)?.slug ?? null, active: genre.active });
  }
  return refs;
}

export async function genreEntityDetail(client: PoolClient, kind: GenreEntityKind, entityId: number): Promise<Record<string, unknown> | null> {
  const taxonomy = await loadTaxonomy(client);
  const refs = await genreRefs(client);
  const ref = (id: number | null) => (id === null ? null : refs.get(id) ?? null);
  const column = kind === "album" ? "album_id" : "artist_id";

  let entity: Record<string, unknown>;
  let artistId: number | null = null;
  if (kind === "album") {
    const { rows } = await client.query<Record<string, unknown>>(`
      SELECT al.id, al.title, al.release_year, al.album_type, al.cover_url, al.genre, ar.id AS artist_id, ar.name AS artist_name,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('discNumber', t.disc_number, 'trackNumber', t.track_number, 'title', t.title,
                                                           'durationSeconds', t.duration_seconds) ORDER BY t.disc_number, t.track_number)
                         FROM public.tracks t WHERE t.album_id = al.id), '[]'::jsonb) AS tracks
        FROM public.albums al JOIN public.artists ar ON ar.id = al.artist_id WHERE al.id = $1`, [entityId]);
    const row = rows[0];
    if (!row) return null;
    artistId = Number(row["artist_id"]);
    entity = {
      kind, id: entityId, title: row["title"], year: row["release_year"], albumType: row["album_type"], coverUrl: row["cover_url"],
      visibleGenre: row["genre"], artist: { id: artistId, name: row["artist_name"] }, tracks: row["tracks"],
    };
  } else {
    const { rows } = await client.query<Record<string, unknown>>(`
      SELECT ar.id, ar.name,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('id', al.id, 'title', al.title, 'year', al.release_year, 'genre', al.genre,
                                                           'coverUrl', al.cover_url) ORDER BY al.release_year NULLS LAST, al.title)
                         FROM public.albums al WHERE al.artist_id = ar.id), '[]'::jsonb) AS albums
        FROM public.artists ar WHERE ar.id = $1`, [entityId]);
    const row = rows[0];
    if (!row) return null;
    const albums = row["albums"] as Array<Record<string, unknown>>;
    entity = { kind, id: entityId, title: row["name"], albums, coverUrl: albums.find((album) => album["coverUrl"])?.["coverUrl"] ?? null };
  }

  const claims = await client.query<Record<string, unknown>>(`
    SELECT c.id, c.status::text AS status, c.raw_value #>> '{}' AS raw_value, c.created_at, s.slug AS source_slug, s.name AS source_name,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('url', e.url, 'excerpt', e.excerpt, 'selector', e.selector, 'capturedAt', e.captured_at) ORDER BY e.id)
                       FROM ingest.claim_evidence e WHERE e.claim_id = c.id), '[]'::jsonb) AS evidence
      FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
     WHERE c.field = 'genre' AND c.entity_kind = $1::ingest.claim_entity_kind AND c.${column} = $2
     ORDER BY s.slug, c.id`, [kind, entityId]);
  const sources = claims.rows.map((row) => {
    const raw = String(row["raw_value"] ?? "");
    const resolution = resolveGenreValue(taxonomy, raw);
    return {
      claimId: Number(row["id"]), level: kind, status: row["status"], rawValue: raw, sourceSlug: row["source_slug"], sourceName: row["source_name"],
      capturedAt: row["created_at"], evidence: row["evidence"],
      resolution: {
        isList: resolution.isList, hyphenCompound: resolution.hyphenCompound, notAGenre: resolution.notAGenre,
        items: resolution.items.map((item) => (item.kind === "genre"
          ? { kind: "genre", fragment: item.fragment, via: item.via, genre: ref(item.genreId) }
          : { kind: "unresolved", fragment: item.fragment })),
      },
    };
  });

  const assignments = await client.query<Record<string, unknown>>(`
    SELECT * FROM ingest.${kind}_genres WHERE ${column} = $1 ORDER BY (role = 'primary') DESC, status, genre_id`, [entityId]);
  const assignmentRows = assignments.rows.map((row) => ({
    id: Number(row["id"]), genre: ref(Number(row["genre_id"])), role: row["role"], status: row["status"], confidence: row["confidence"],
    sourceKind: row["source_kind"], rawValue: row["raw_value"], evidence: row["evidence"], decidedBy: row["decided_by"],
    decidedAt: row["decided_at"], decisionRule: row["decision_rule"], decisionKind: row["decision_kind"], decisionNote: row["decision_note"],
    supersededById: row["superseded_by_id"] === null ? null : Number(row["superseded_by_id"]),
  }));

  const cases = await client.query<Record<string, unknown>>(`
    SELECT id, status::text AS status, payload, created_at, resolved_at, resolution_note FROM ingest.review_queue
     WHERE kind = 'genre_unknown' AND payload->>'origin' LIKE 'genres%'
       AND payload->>'entityKind' = $1 AND (payload->>'entityId')::bigint = $2
     ORDER BY (status IN ('open','in_progress')) DESC, id DESC LIMIT 50`, [kind, entityId]);

  const history = await client.query<Record<string, unknown>>(`
    SELECT l.id, l.action, l.genre_id, l.before, l.after, l.actor, l.reason, l.run_id, l.created_at
      FROM ingest.genre_assignment_log l WHERE l.entity_kind = $1 AND l.entity_id = $2 ORDER BY l.id DESC LIMIT 100`, [kind, entityId]);

  // Contexto informativo: el género del ARTISTA cuando se revisa un disco.
  let artistContext: Record<string, unknown> | null = null;
  if (kind === "album" && artistId !== null) {
    const artistGenres = await client.query<{ genre_id: string; role: string; status: string }>(`
      SELECT genre_id::text, role, status FROM ingest.artist_genres WHERE artist_id = $1 AND status IN ('confirmed','suggested')
       ORDER BY (role = 'primary') DESC, genre_id`, [artistId]);
    const artistClaims = await client.query<{ raw_value: string; slug: string }>(`
      SELECT c.raw_value #>> '{}' AS raw_value, s.slug FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.field = 'genre' AND c.entity_kind = 'artist' AND c.artist_id = $1 ORDER BY c.id`, [artistId]);
    artistContext = {
      label: "del artista, no del disco",
      genres: artistGenres.rows.map((row) => ({ genre: ref(Number(row.genre_id)), role: row.role, status: row.status })),
      sourceValues: artistClaims.rows.map((row) => ({ sourceSlug: row.slug, rawValue: row.raw_value })),
    };
  }

  // Fuentes externas (etapa 4): con qué identificador se corresponde la ficha
  // en cada fuente autorizada y con qué señales se decidió. Es contexto para
  // juzgar una sugerencia externa, nunca una clasificación por sí mismo.
  const external = await client.query<Record<string, unknown>>(`
    SELECT i.external_id, i.external_name, i.external_url, i.score, i.signals, i.status, i.decided_by,
           i.decision_kind, i.reason, i.updated_at, s.slug AS source_slug, s.name AS source_name, s.attribution
      FROM ingest.genre_external_identities i JOIN ingest.genre_external_sources s ON s.id = i.source_id
     WHERE i.entity_kind = $1 AND i.entity_id = $2
     ORDER BY (i.status = 'matched') DESC, s.slug`, [kind, entityId]);

  const primary = assignmentRows.find((row) => row.role === "primary" && row.status === "confirmed");
  return {
    entity,
    externalIdentities: external.rows.map((row) => ({
      sourceSlug: row["source_slug"], sourceName: row["source_name"], attribution: row["attribution"],
      externalId: row["external_id"], externalName: row["external_name"], externalUrl: row["external_url"],
      score: Number(row["score"]), signals: row["signals"], status: row["status"],
      decidedBy: row["decided_by"], decisionKind: row["decision_kind"], reason: row["reason"], at: row["updated_at"],
    })),
    status: primary ? "confirmed" : sources.length ? "pending" : "unclassified",
    sources,
    assignments: assignmentRows,
    cases: cases.rows.map((row) => ({
      id: Number(row["id"]), status: row["status"], payload: row["payload"], createdAt: row["created_at"],
      resolvedAt: row["resolved_at"], resolutionNote: row["resolution_note"],
    })),
    history: history.rows.map((row) => ({
      id: Number(row["id"]), action: row["action"], genre: ref(row["genre_id"] === null ? null : Number(row["genre_id"])),
      before: row["before"], after: row["after"], actor: row["actor"], reason: row["reason"],
      runId: row["run_id"] === null ? null : Number(row["run_id"]), at: row["created_at"],
    })),
    artistContext,
  };
}

// --- Lectura: vocabulario -----------------------------------------------------

export async function genreVocabulary(client: PoolClient): Promise<Array<GenreRef & { description: string | null; children: GenreRef[]; aliases: number }>> {
  const { rows } = await client.query<{ id: string; description: string | null; aliases: number }>(`
    SELECT g.id::text, g.description, (SELECT count(*)::int FROM ingest.genre_aliases a WHERE a.genre_id = g.id) AS aliases
      FROM ingest.genres g`);
  const extra = new Map(rows.map((row) => [Number(row.id), row]));
  const refs = [...(await genreRefs(client)).values()];
  const withExtra = (genre: GenreRef) => ({ ...genre, description: extra.get(genre.id)?.description ?? null, aliases: extra.get(genre.id)?.aliases ?? 0 });
  return refs.filter((genre) => genre.level === "family").sort((a, b) => a.name.localeCompare(b.name, "es")).map((family) => ({
    ...withExtra(family),
    children: refs.filter((genre) => genre.level === "genre" && genre.family === family.slug)
      .sort((a, b) => a.name.localeCompare(b.name, "es")).map(withExtra),
  }));
}

// --- Lectura: métricas --------------------------------------------------------

export async function genreMetrics(client: PoolClient): Promise<Record<string, unknown>> {
  const run = async <T extends Record<string, unknown>>(sql: string) => (await client.query<T>(sql)).rows;
  const levels = await run(`
      SELECT 'album' AS level, count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = a.id AND g.role = 'primary' AND g.status = 'confirmed'))::int AS confirmed,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = a.id AND g.status = 'confirmed'))::int AS with_any_confirmed,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = a.id AND g.role = 'primary' AND g.status = 'confirmed')
                                AND a.genre IS NOT NULL)::int AS pending,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = a.id AND g.status IN ('confirmed','suggested'))
                                AND a.genre IS NULL)::int AS unclassified
        FROM public.albums a
      UNION ALL
      SELECT 'artist', count(*)::int,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.role = 'primary' AND g.status = 'confirmed'))::int,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.status = 'confirmed'))::int,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.role = 'primary' AND g.status = 'confirmed')
                                AND EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.status IN ('confirmed','suggested')))::int,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.status IN ('confirmed','suggested')))::int
        FROM public.artists a`);
  const decisions = await run(`
      SELECT level, decision_kind, status, count(*)::int AS n FROM (
        SELECT 'album' AS level, decision_kind, status FROM ingest.album_genres
        UNION ALL SELECT 'artist', decision_kind, status FROM ingest.artist_genres) x
       GROUP BY 1,2,3 ORDER BY 1,2,3`);
  const resolution = await run(`
      SELECT count(*)::int AS resolved,
             COALESCE(round(extract(epoch FROM avg(resolved_at - created_at)) / 3600, 1), 0)::float AS avg_hours
        FROM ingest.review_queue
       WHERE kind = 'genre_unknown' AND payload->>'origin' LIKE 'genres%' AND resolved_by = 'human' AND resolved_at IS NOT NULL`);
  const bySource = await run(`
      SELECT s.slug AS source, c.entity_kind::text AS level, count(DISTINCT COALESCE(c.album_id, c.artist_id))::int AS entities,
             count(DISTINCT COALESCE(c.album_id, c.artist_id)) FILTER (WHERE
               (c.entity_kind = 'album' AND EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = c.album_id AND g.role = 'primary' AND g.status = 'confirmed'))
               OR (c.entity_kind = 'artist' AND EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = c.artist_id AND g.role = 'primary' AND g.status = 'confirmed')))::int AS confirmed
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.field = 'genre' AND c.entity_kind IN ('album','artist')
       GROUP BY 1,2 ORDER BY 3 DESC`);
  const byDecade = await run(`
      SELECT CASE WHEN release_year IS NULL THEN NULL ELSE (release_year / 10) * 10 END AS decade, count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id = a.id AND g.role = 'primary' AND g.status = 'confirmed'))::int AS confirmed,
             count(*) FILTER (WHERE a.genre IS NULL)::int AS unclassified
        FROM public.albums a GROUP BY 1 ORDER BY 1 NULLS LAST`);
  const byFamily = await run(`
      SELECT f.slug, f.name,
             count(DISTINCT ag.album_id)::int AS albums, count(DISTINCT rg.artist_id)::int AS artists
        FROM ingest.genres f
        LEFT JOIN ingest.genres g ON g.id = f.id OR g.parent_genre_id = f.id
        LEFT JOIN ingest.album_genres ag ON ag.genre_id = g.id AND ag.status = 'confirmed'
        LEFT JOIN ingest.artist_genres rg ON rg.genre_id = g.id AND rg.status = 'confirmed'
       WHERE f.level = 'family' GROUP BY f.slug, f.name ORDER BY 3 DESC, 1`);
  const queue = await run(`
      SELECT CASE payload->>'genreCase'
               WHEN 'unknown_value' THEN 'genre_unknown' WHEN 'compound_value' THEN 'compound'
               WHEN 'source_disagreement' THEN 'disagreement' WHEN 'primary_disagreement' THEN 'disagreement'
               WHEN 'human_contradiction' THEN 'contradiction' ELSE payload->>'genreCase' END AS category, count(*)::int AS n
        FROM ingest.review_queue WHERE kind = 'genre_unknown' AND status IN ('open','in_progress')
         AND payload->>'origin' LIKE 'genres%' GROUP BY 1 ORDER BY 2 DESC`);
  const rejected = decisions.filter((row) => row["status"] === "rejected").reduce((sum, row) => sum + Number(row["n"]), 0);
  return {
    levels,
    assignments: decisions,
    // `superseded` no es un rechazo (PLAN §4): no entra en esta cifra.
    rejected,
    pendingCases: queue,
    resolution: resolution[0],
    bySource,
    byDecade,
    byFamily,
  };
}
