// E10 · Aplicación de las decisiones del resolutor. Es la única puerta al core
// que abre esta etapa, y la abre una persona:
//
//  * Sin `--confirm` solo muestra el plan.
//  * En lote solo entran decisiones de reglas deterministas. Una decisión de
//    árbitro de IA se aplica únicamente si la persona nombra su revisión
//    (`--review=<id>`): la IA nunca escribe sola.
//  * Solo MATCH_HIGH_CONFIDENCE cambia datos; KEEP_SEPARATE solo cierra.
//    CONFLICT y NEEDS_HUMAN no se aplican nunca.
//  * Antes de escribir se comprueba que las fichas siguen como se vieron; si
//    no, se salta y pide volver a resolver. Cada decisión, su transacción.
//  * Las fusiones reutilizan `mergeInto` (reapunta toda FK, conserva alias,
//    audita) y los enlaces de video quedan en merge_audit.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { finishRun } from "../ingest/runs.js";
import { mergeInto } from "../review/duplicates.js";
import { mergeEquivalentCredits } from "../review/person-corrections.js";
import { normalizeEntityName } from "../normalization/entity-name.js";
import { describeTarget } from "./report.js";
import { trackTitlesEquivalent } from "./text.js";
import type { AmbiguityDecision, ApplyTarget } from "./types.js";

export interface ApplyItem {
  resolutionId: number; reviewId: number; questionKey: string; question: string;
  decision: AmbiguityDecision; decidedBy: "deterministic" | "ai"; arbiter: string | null; target: ApplyTarget | null;
}
export interface ApplyResult {
  confirmed: boolean; runId?: number;
  planned: ApplyItem[];
  /** Decisiones de árbitro que el lote no aplica porque su revisión no se nombró. */
  heldForExplicitReview: ApplyItem[];
  applied: Array<ApplyItem & { detail: string }>;
  skipped: Array<ApplyItem & { reason: string }>;
  failed: Array<ApplyItem & { error: string }>;
  reviewsClosed: Array<{ reviewId: number; status: "approved" | "dismissed" }>;
}

class StaleTarget extends Error {}

/** Tope de fallos que caben en el `error_log` del run. No trunca evidencia. */
const MAX_FAILURES_IN_LOG = 50;

export function describeApply(item: ApplyItem): string {
  return item.target ? describeTarget(item.target) : "mantener separados y cerrar la pregunta (sin cambios en el catálogo)";
}

async function planItems(reviewIds?: number[]): Promise<{ planned: ApplyItem[]; held: ApplyItem[] }> {
  const { rows } = await getPool().query<{ id: string; review_id: string; question_key: string; question: string; decision: AmbiguityDecision; decided_by: "deterministic" | "ai"; arbiter: string | null; target: ApplyTarget | null }>(`
    SELECT r.id::text, r.review_id::text, r.question_key, r.question, r.decision, r.decided_by, r.arbiter, r.target
      FROM ingest.ambiguity_resolutions r JOIN ingest.review_queue q ON q.id=r.review_id
     WHERE r.status='proposed' AND r.decision IN ('MATCH_HIGH_CONFIDENCE','KEEP_SEPARATE') AND q.status IN ('open','in_progress')
       AND ($1::bigint[] IS NULL OR r.review_id = ANY($1::bigint[]))
     ORDER BY r.review_id, r.question_key`, [reviewIds?.length ? reviewIds : null]);
  const items = rows.map((row): ApplyItem => ({
    resolutionId: Number(row.id), reviewId: Number(row.review_id), questionKey: row.question_key, question: row.question,
    decision: row.decision, decidedBy: row.decided_by, arbiter: row.arbiter, target: row.target,
  }));
  const explicit = Boolean(reviewIds?.length);
  return { planned: items.filter((item) => item.decidedBy === "deterministic" || explicit), held: items.filter((item) => item.decidedBy === "ai" && !explicit) };
}

async function expectRows(client: PoolClient, sql: string, ids: number[], expected: (row: Record<string, unknown>) => boolean, what: string): Promise<void> {
  const { rows } = await client.query<Record<string, unknown>>(sql, [ids]);
  if (rows.length !== ids.length || !rows.every(expected)) throw new StaleTarget(`${what} ya no está como se vio al resolver; ejecute de nuevo crv ambiguity:resolve`);
}

/**
 * Toda auditoría enlaza su evidencia (doctor: merge_audit.coverage): los claims
 * de la fila y los que ya respaldan sus auditorías anteriores.
 */
async function linkAuditClaims(client: PoolClient, auditId: number, column: "album_id" | "track_id", id: number): Promise<void> {
  await client.query(`
    INSERT INTO ingest.merge_audit_claims(merge_audit_id, claim_id)
    SELECT $1, claim_id FROM (
      SELECT c.id AS claim_id FROM ingest.claims c WHERE c.${column}=$2
      UNION
      SELECT mac.claim_id FROM ingest.merge_audit ma JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE ma.${column}=$2 AND ma.id<>$1
    ) evidence ORDER BY claim_id LIMIT 50
    ON CONFLICT DO NOTHING`, [auditId, id]);
}

async function auditMedia(client: PoolClient, runId: number, column: "album_id" | "track_id", kind: "album" | "track", id: number, field: string, value: object, note: string): Promise<void> {
  const audit = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id, entity_kind, ${column}, field, old_value, new_value, reason, confidence, performed_by)
    VALUES ($1, $2::ingest.claim_entity_kind, $3, $4, NULL, $5::jsonb, $6, 'high', 'human') RETURNING id::text`, [runId, kind, id, field, JSON.stringify(value), note]);
  await linkAuditClaims(client, Number(audit.rows[0]!.id), column, id);
}

/**
 * `mergeInto` se niega a unir dos pistas de la misma posición con títulos
 * distintos. El resolutor ya las juzgó la misma grabación («Todo Está Bien
 * (Radio Cut)» / «(Radio version)»): se alinea el título del duplicado con el
 * que queda, el suyo pasa a alias de la pista y el cambio se audita. Si ya no
 * son equivalentes, la ficha cambió desde que se resolvió.
 */
async function alignEquivalentTracks(client: PoolClient, keepId: number, dropId: number, reason: string, runId: number): Promise<number> {
  const { rows } = await client.query<{ keep: string; drop: string; keep_title: string; drop_title: string }>(`
    SELECT k.id::text AS keep, d.id::text AS drop, k.title AS keep_title, d.title AS drop_title
      FROM public.tracks d JOIN public.tracks k ON k.album_id=$1 AND k.disc_number=d.disc_number AND k.track_number=d.track_number
     WHERE d.album_id=$2 ORDER BY d.disc_number, d.track_number`, [keepId, dropId]);
  let aligned = 0;
  for (const row of rows) {
    if (normalizeEntityName(row.keep_title).secondaryKey === normalizeEntityName(row.drop_title).secondaryKey) continue;
    if (!trackTitlesEquivalent(row.keep_title, row.drop_title)) throw new StaleTarget(`la posición de «${row.keep_title}» / «${row.drop_title}» ya no es la misma pista; ejecute de nuevo crv ambiguity:resolve`);
    await client.query(`
      INSERT INTO ingest.track_aliases(track_id, alias, alias_type, normalized_alias, is_primary, confidence, notes)
      VALUES ($1, $2, 'alternate_title', $3, false, 'high', 'Título de un duplicado fusionado') ON CONFLICT DO NOTHING`,
    [Number(row.keep), row.drop_title, normalizeEntityName(row.drop_title).primaryKey]);
    await client.query("UPDATE public.tracks SET title=$2 WHERE id=$1", [Number(row.drop), row.keep_title]);
    const audit = await client.query<{ id: string }>(`
      INSERT INTO ingest.merge_audit(run_id, entity_kind, track_id, field, old_value, new_value, reason, confidence, performed_by)
      VALUES ($1, 'track', $2, 'title', $3::jsonb, $4::jsonb, $5, 'high', 'human') RETURNING id::text`,
    [runId, Number(row.drop), JSON.stringify(row.drop_title), JSON.stringify(row.keep_title), `${reason}: título alineado antes de fusionar la pista`]);
    await linkAuditClaims(client, Number(audit.rows[0]!.id), "track_id", Number(row.drop));
    aligned += 1;
  }
  return aligned;
}

async function applyTarget(client: PoolClient, item: ApplyItem, note: string, runId: number, apiSource: number): Promise<string> {
  const target = item.target;
  const reason = `${note} — ambiguity:${item.resolutionId} (revisión #${item.reviewId})`;
  if (!target) return "sin cambios en el catálogo";
  switch (target.action) {
    case "merge_albums": {
      await expectRows(client, "SELECT id::text, title FROM public.albums WHERE id = ANY($1::bigint[]) FOR UPDATE", [target.keepId, target.dropId],
        (row) => (Number(row["id"]) === target.keepId && row["title"] === target.keepTitle) || (Number(row["id"]) === target.dropId && row["title"] === target.dropTitle), "uno de los discos");
      const aligned = await alignEquivalentTracks(client, target.keepId, target.dropId, reason, runId);
      const outcome = await mergeInto(client, "album", target.keepId, target.dropId, reason, runId);
      return `${outcome.moved} referencias movidas, ${outcome.tracksMerged} pistas unidas${aligned ? ` (${aligned} títulos alineados, el anterior como alias)` : ""}`;
    }
    case "merge_persons": {
      await expectRows(client, "SELECT id::text, name FROM public.persons WHERE id = ANY($1::bigint[]) FOR UPDATE", [target.keepId, target.dropId],
        (row) => (Number(row["id"]) === target.keepId && row["name"] === target.keepName) || (Number(row["id"]) === target.dropId && row["name"] === target.dropName), "una de las personas");
      // Una revisión que empareja a las dos fichas —la propia de este par, al
      // menos— no puede quedar nombrando dos veces a la misma persona
      // (review_queue_distinct_persons_chk). El payload conserva ambos ids.
      await client.query("UPDATE ingest.review_queue SET person_b_id=NULL, updated_at=now() WHERE person_a_id=$1 AND person_b_id=$2", [target.keepId, target.dropId]);
      await client.query("UPDATE ingest.review_queue SET person_a_id=NULL, updated_at=now() WHERE person_a_id=$2 AND person_b_id=$1", [target.keepId, target.dropId]);
      const outcome = await mergeInto(client, "person", target.keepId, target.dropId, reason, runId, { alias: true });
      const credits = await mergeEquivalentCredits(client, { column: "person_id", id: target.keepId }, reason, runId);
      return `${outcome.moved} referencias movidas, ${credits} créditos equivalentes unidos`;
    }
    case "link_video_track": {
      await expectRows(client, "SELECT id::text FROM public.tracks WHERE id = ANY($1::bigint[])", [target.trackId], () => true, "la pista");
      const inserted = await client.query(`
        INSERT INTO media.video_tracks(video_id, track_id, start_seconds, end_seconds, confidence, source_id, notes)
        SELECT v.id, $2, $3, $4, 'high', $5, $6 FROM media.youtube_videos v WHERE v.id=$1
        ON CONFLICT (video_id, track_id, start_seconds) DO NOTHING`,
      [target.videoDbId, target.trackId, target.startSeconds, target.endSeconds, apiSource, `ambiguity:${item.resolutionId}`]);
      await auditMedia(client, runId, "track_id", "track", target.trackId, "youtube_video_occurrence", { videoId: target.videoId, startSeconds: target.startSeconds, endSeconds: target.endSeconds }, reason);
      return inserted.rowCount ? "ocurrencia de video enlazada" : "la ocurrencia ya existía";
    }
    case "link_video_album": {
      await expectRows(client, "SELECT id::text FROM public.albums WHERE id = ANY($1::bigint[])", [target.albumId], () => true, "el disco");
      await client.query(`
        INSERT INTO media.video_albums(video_id, album_id, album_kind, is_primary_link, confidence, source_id)
        SELECT v.id, $2, 'live_concert', false, 'high', $3 FROM media.youtube_videos v WHERE v.id=$1
        ON CONFLICT (video_id, album_id) DO NOTHING`, [target.videoDbId, target.albumId, apiSource]);
      let occurrences = 0;
      for (const occurrence of target.occurrences) {
        const inserted = await client.query(`
          INSERT INTO media.video_tracks(video_id, track_id, start_seconds, end_seconds, confidence, source_id, notes)
          SELECT v.id, t.id, $3, $4, 'high', $5, $6 FROM media.youtube_videos v JOIN public.tracks t ON t.id=$2 WHERE v.id=$1
          ON CONFLICT (video_id, track_id, start_seconds) DO NOTHING`,
        [target.videoDbId, occurrence.trackId, occurrence.startSeconds, occurrence.endSeconds, apiSource, `ambiguity:${item.resolutionId}`]);
        occurrences += inserted.rowCount ?? 0;
      }
      await auditMedia(client, runId, "album_id", "album", target.albumId, "youtube_live_concert_link", { videoId: target.videoId, occurrences: target.occurrences.length }, reason);
      return `concierto enlazado como live_concert con ${occurrences} ocurrencias nuevas`;
    }
  }
}

/** Una revisión se cierra cuando todas sus preguntas vivas están aplicadas. */
async function closeReviewIfDone(client: PoolClient, reviewId: number, note: string, runId: number): Promise<"approved" | "dismissed" | null> {
  const { rows } = await client.query<{ pending: string; matches: string }>(`
    SELECT count(*) FILTER (WHERE status <> 'applied')::text AS pending,
           count(*) FILTER (WHERE status = 'applied' AND decision = 'MATCH_HIGH_CONFIDENCE')::text AS matches
      FROM ingest.ambiguity_resolutions WHERE review_id=$1 AND status IN ('proposed','applied')`, [reviewId]);
  if (Number(rows[0]!.pending) > 0) return null;
  const status = Number(rows[0]!.matches) > 0 ? "approved" : "dismissed";
  const updated = await client.query(`
    UPDATE ingest.review_queue SET status=$2, resolved_by='human', resolution_note=$3, resolved_at=now(), updated_at=now()
     WHERE id=$1 AND status IN ('open','in_progress')`, [reviewId, status, `${note} (crv ambiguity:apply, run ${runId})`]);
  return updated.rowCount ? status : null;
}

export async function applyAmbiguityResolutions(options: { reviewIds?: number[]; note?: string; confirm?: boolean } = {}): Promise<ApplyResult> {
  const { planned, held } = await planItems(options.reviewIds);
  const result: ApplyResult = { confirmed: false, planned, heldForExplicitReview: held, applied: [], skipped: [], failed: [], reviewsClosed: [] };
  const note = options.note?.trim();
  if (!options.confirm || !note) return result;
  result.confirmed = true;

  const pool = getPool();
  const source = await pool.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='youtube-data-api'");
  const apiSource = Number(source.rows[0]?.id ?? 0);
  const opened = await pool.query<{ id: string }>(`
    INSERT INTO ingest.scrape_runs(kind, status, params) VALUES ('merge_run', 'running', $1::jsonb) RETURNING id::text`,
  [JSON.stringify({ action: "ambiguity_apply", note, reviewIds: options.reviewIds ?? null, planned: planned.length })]);
  const runId = Number(opened.rows[0]!.id);
  result.runId = runId;

  for (const item of planned) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
      const current = await client.query<{ status: string }>("SELECT status FROM ingest.ambiguity_resolutions WHERE id=$1 FOR UPDATE", [item.resolutionId]);
      if (current.rows[0]?.status !== "proposed") throw new StaleTarget("la decisión ya no está pendiente");
      if (item.target && (item.target.action === "link_video_track" || item.target.action === "link_video_album") && !apiSource) throw new Error("falta la fuente youtube-data-api");
      const detail = await applyTarget(client, item, note, runId, apiSource);
      await client.query(`
        UPDATE ingest.ambiguity_resolutions SET status='applied', applied_at=now(), applied_run_id=$2, applied_note=$3 WHERE id=$1`,
      [item.resolutionId, runId, note]);
      const closed = await closeReviewIfDone(client, item.reviewId, note, runId);
      await client.query("COMMIT");
      result.applied.push({ ...item, detail });
      if (closed) result.reviewsClosed.push({ reviewId: item.reviewId, status: closed });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof StaleTarget) result.skipped.push({ ...item, reason: error.message });
      else result.failed.push({ ...item, error: error instanceof Error ? error.message : String(error) });
    } finally {
      client.release();
    }
  }
  await finishRun(runId, result.failed.length ? "partial" : "ok", {
    planned: planned.length, applied: result.applied.length, skipped: result.skipped.length, failed: result.failed.length, reviewsClosed: result.reviewsClosed.length,
  }, result.failed.length ? JSON.stringify(result.failed.slice(0, MAX_FAILURES_IN_LOG).map((item) => ({ resolutionId: item.resolutionId, error: item.error }))) : undefined);
  return result;
}
