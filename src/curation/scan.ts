// CRV · Análisis persistido del detector de conflictos.
//
// Un análisis carga la foto del catálogo, corre los detectores y reconcilia
// con lo guardado: inserta lo nuevo, refresca lo que sigue, resuelve lo que
// ya no aparece y reabre lo resuelto que volvió. Lo ignorado por una persona
// se respeta siempre.
//
// VERIFICACIÓN DE CORRECCIONES. Cada escritura del catálogo dispara un
// análisis (API: `notifyCatalogWrite`; fuera de la API: el vigilante). Un
// hallazgo que NACE en el mismo análisis en que se resolvió otro sobre la
// misma ficha —o sobre una ficha relacionada— queda marcado con
// `evidence.triggeredBy`: «apareció al corregir esto». Así una corrección que
// desencadena errores nuevos se ve en el acto, no semanas después.
//
// Un solo análisis a la vez por proceso; las peticiones que llegan mientras
// corre se agrupan en uno solo posterior.
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { RULES_VERSION, analyzeCatalog, storableText } from "./analyze.js";
import { loadCatalogSnapshot } from "./snapshot.js";
import type { EntityRef, Finding } from "./types.js";

const log = moduleLogger("curation:scan");

const CHUNK = 1000;

export interface ScanRequest {
  /** inicio | manual | correccion | cambio_en_catalogo | cli */
  trigger: string;
  requestedBy?: string | null;
  /** Qué escritura lo pidió (método y ruta), para leer el historial. */
  detail?: string | null;
  dryRun?: boolean;
}

export interface ResolvedRef { id: number; title: string; entityKind: string; entityId: number | null; }

export interface ScanSummary {
  scanId: number | null;
  status: "ok" | "failed";
  trigger: string;
  dryRun: boolean;
  durationMs: number;
  catalogSignature: string;
  total: number;
  inserted: number;
  reopened: number;
  resolved: number;
  /** Hallazgos nuevos que nacieron sobre fichas donde se acababa de resolver otro. */
  chained: number;
  byCategory: Record<string, number>;
  failures: Array<{ detector: string; error: string }>;
  error?: string;
}

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Huella barata de «¿cambió algo?»: contadores de filas insertadas,
 * actualizadas y borradas en el core y en las tablas de la ingesta que el
 * detector lee. No incluye `curation_*`, así que analizar no se dispara solo.
 */
export async function catalogSignature(db: Queryable = getPool()): Promise<string> {
  const { rows } = await db.query<{ signature: string | null }>(`
    SELECT string_agg(schemaname || '.' || relname || ':' || n_tup_ins || ':' || n_tup_upd || ':' || n_tup_del, ',' ORDER BY schemaname, relname) AS signature
      FROM pg_stat_user_tables
     WHERE schemaname = 'public'
        OR (schemaname = 'ingest' AND relname IN ('conflicts', 'review_queue', 'claims', 'entity_redirects'))`);
  return rows[0]?.signature ?? "";
}

function refKey(kind: string, id: number | null): string {
  return `${kind}:${id ?? ""}`;
}

function rowOf(finding: Finding & { fingerprint: string }) {
  return {
    fingerprint: finding.fingerprint,
    category: finding.category,
    detector: finding.detector,
    signature: finding.signature,
    severity: finding.severity,
    entity_kind: finding.entity.kind,
    entity_id: finding.entity.id,
    entity_label: finding.entity.label,
    field: finding.field ?? null,
    value: finding.value ?? null,
    title: finding.title,
    suggestion: finding.suggestion ?? null,
    suggested_value: finding.suggestedValue ?? null,
    related: finding.related,
    evidence: { ...finding.evidence, ...(finding.signatureLabel ? { signatureLabel: finding.signatureLabel } : {}) },
  };
}

const RECORD_COLUMNS = `fingerprint text, category text, detector text, signature text, severity text, entity_kind text, entity_id bigint,
  entity_label text, field text, value text, title text, suggestion text, suggested_value text, related jsonb, evidence jsonb`;

async function persist(client: PoolClient, scanId: number, findings: Array<Finding & { fingerprint: string }>) {
  let inserted = 0; let reopened = 0;
  // Lo que aparece en este análisis: nuevo o reabierto (se había resuelto y volvió).
  const appearedFingerprints = new Set<string>();
  for (let offset = 0; offset < findings.length; offset += CHUNK) {
    const chunk = findings.slice(offset, offset + CHUNK);
    const payload = JSON.stringify(chunk.map(rowOf));
    const wasResolved = await client.query<{ fingerprint: string }>(`
      SELECT fingerprint FROM ingest.curation_findings
       WHERE status = 'resolved' AND fingerprint = ANY($1::text[])`, [chunk.map((finding) => finding.fingerprint)]);
    reopened += wasResolved.rows.length;
    for (const row of wasResolved.rows) appearedFingerprints.add(row.fingerprint);
    const saved = await client.query<{ fingerprint: string; inserted: boolean }>(`
      INSERT INTO ingest.curation_findings AS f
        (fingerprint, category, detector, signature, severity, entity_kind, entity_id, entity_label, field, value, title, suggestion,
         suggested_value, related, evidence, first_seen_scan_id, last_seen_scan_id)
      SELECT fingerprint, category, detector, signature, severity, entity_kind, entity_id, entity_label, field, value, title, suggestion,
             suggested_value, related, evidence, $2, $2
        FROM jsonb_to_recordset($1::jsonb) AS x(${RECORD_COLUMNS})
      ON CONFLICT (fingerprint) DO UPDATE SET
        category = EXCLUDED.category, detector = EXCLUDED.detector, signature = EXCLUDED.signature, severity = EXCLUDED.severity,
        entity_label = EXCLUDED.entity_label, title = EXCLUDED.title, suggestion = EXCLUDED.suggestion,
        suggested_value = EXCLUDED.suggested_value,
        related = EXCLUDED.related,
        -- La marca «apareció al corregir» es historia del hallazgo: no se pierde al
        -- refrescar. Un hallazgo que vuelve tras resolverse es una aparición nueva:
        -- empieza sin marca y cuenta como visto por primera vez en este análisis.
        evidence = CASE WHEN f.status = 'resolved' THEN EXCLUDED.evidence
                        ELSE EXCLUDED.evidence || jsonb_strip_nulls(jsonb_build_object('triggeredBy', f.evidence->'triggeredBy', 'triggeredInScan', f.evidence->'triggeredInScan')) END,
        first_seen_scan_id = CASE WHEN f.status = 'resolved' THEN EXCLUDED.first_seen_scan_id ELSE f.first_seen_scan_id END,
        first_seen_at = CASE WHEN f.status = 'resolved' THEN now() ELSE f.first_seen_at END,
        last_seen_scan_id = EXCLUDED.last_seen_scan_id, last_seen_at = now(),
        status = CASE WHEN f.status = 'resolved' THEN 'open' ELSE f.status END,
        resolved_at = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.resolved_at END
      RETURNING fingerprint, (xmax = 0) AS inserted`, [payload, scanId]);
    for (const row of saved.rows) {
      if (row.inserted) { inserted += 1; appearedFingerprints.add(row.fingerprint); }
    }
  }

  const resolvedRows = await client.query<{ id: string; title: string; entity_kind: string; entity_id: string | null; related: EntityRef[] }>(`
    UPDATE ingest.curation_findings SET status = 'resolved', resolved_at = now()
     WHERE status = 'open' AND last_seen_scan_id IS DISTINCT FROM $1
     RETURNING id::text, title, entity_kind, entity_id::text, related`, [scanId]);

  // Encadenamiento: lo nuevo que nace donde algo se acaba de resolver.
  const resolvedByEntity = new Map<string, ResolvedRef[]>();
  for (const row of resolvedRows.rows) {
    const ref: ResolvedRef = { id: Number(row.id), title: row.title, entityKind: row.entity_kind, entityId: row.entity_id === null ? null : Number(row.entity_id) };
    for (const key of [refKey(row.entity_kind, ref.entityId), ...(row.related ?? []).map((item) => refKey(item.kind, item.id))]) {
      if (key.endsWith(":")) continue;
      resolvedByEntity.set(key, [...(resolvedByEntity.get(key) ?? []), ref]);
    }
  }
  const chained: Array<{ fingerprint: string; triggered_by: ResolvedRef[] }> = [];
  if (resolvedByEntity.size && appearedFingerprints.size) {
    for (const finding of findings) {
      if (!appearedFingerprints.has(finding.fingerprint)) continue;
      const keys = [refKey(finding.entity.kind, finding.entity.id), ...finding.related.map((item) => refKey(item.kind, item.id))];
      const causes = [...new Map(keys.flatMap((key) => resolvedByEntity.get(key) ?? []).map((ref) => [ref.id, ref])).values()].slice(0, 10);
      if (causes.length) chained.push({ fingerprint: finding.fingerprint, triggered_by: causes.map((ref) => ({ ...ref, title: storableText(ref.title) })) });
    }
    for (let offset = 0; offset < chained.length; offset += CHUNK) {
      await client.query(`
        UPDATE ingest.curation_findings f
           SET evidence = f.evidence || jsonb_build_object('triggeredBy', x.triggered_by, 'triggeredInScan', $2::bigint)
          FROM jsonb_to_recordset($1::jsonb) AS x(fingerprint text, triggered_by jsonb)
         WHERE f.fingerprint = x.fingerprint`, [JSON.stringify(chained.slice(offset, offset + CHUNK)), scanId]);
    }
  }
  return { inserted, reopened, resolved: resolvedRows.rowCount ?? 0, chained: chained.length };
}

async function executeScan(request: ScanRequest): Promise<ScanSummary> {
  const pool = getPool();
  const started = Date.now();
  const dryRun = request.dryRun ?? false;
  const signature = await catalogSignature(pool);
  let scanId: number | null = null;
  if (!dryRun) {
    const created = await pool.query<{ id: string }>(`
      INSERT INTO ingest.curation_scans(trigger, requested_by, catalog_signature, counters)
      VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text`,
    [request.trigger.slice(0, 40), request.requestedBy ?? null, signature, JSON.stringify({ rulesVersion: RULES_VERSION, detail: request.detail ?? null })]);
    scanId = Number(created.rows[0]!.id);
  }
  const base = { scanId, trigger: request.trigger, dryRun, catalogSignature: signature };
  try {
    const snapshot = await loadCatalogSnapshot(pool);
    const analysis = analyzeCatalog(snapshot);
    const byCategory: Record<string, number> = {};
    for (const finding of analysis.findings) byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    let counts = { inserted: 0, reopened: 0, resolved: 0, chained: 0 };
    if (!dryRun && scanId !== null) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        counts = await persist(client, scanId, analysis.findings);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const summary: ScanSummary = {
      ...base, status: "ok", durationMs: Date.now() - started, total: analysis.findings.length, ...counts, byCategory, failures: analysis.failures,
    };
    if (scanId !== null) {
      await pool.query(`UPDATE ingest.curation_scans SET status = 'ok', finished_at = now(), counters = counters || $2::jsonb WHERE id = $1`, [scanId, JSON.stringify({
        total: summary.total, inserted: summary.inserted, reopened: summary.reopened, resolved: summary.resolved, chained: summary.chained,
        byCategory, failures: analysis.failures, durationMs: summary.durationMs, lexicon: analysis.lexicon,
      })]);
    }
    log.info({ scanId, trigger: request.trigger, total: summary.total, inserted: summary.inserted, resolved: summary.resolved, chained: summary.chained, ms: summary.durationMs }, "análisis de curaduría");
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (scanId !== null) {
      await pool.query("UPDATE ingest.curation_scans SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [scanId, message.slice(0, 2000)]).catch(() => undefined);
    }
    log.error({ err: error, scanId, trigger: request.trigger }, "falló el análisis de curaduría");
    return { ...base, status: "failed", durationMs: Date.now() - started, total: 0, inserted: 0, reopened: 0, resolved: 0, chained: 0, byCategory: {}, failures: [], error: message };
  }
}

let running: Promise<ScanSummary> | null = null;
let queued: { request: ScanRequest; promise: Promise<ScanSummary> } | null = null;

/** Corre un análisis; si ya hay uno en curso, agrupa esta petición en el siguiente. */
export function runCurationScan(request: ScanRequest): Promise<ScanSummary> {
  if (request.dryRun) return executeScan(request);
  if (!running) {
    running = executeScan(request).finally(() => { running = null; });
    return running;
  }
  if (queued) {
    // Se conserva la petición más informativa: una corrección pesa más que un sondeo.
    if (request.trigger === "correccion" || request.trigger === "manual") queued.request = request;
    return queued.promise;
  }
  const slot: { request: ScanRequest; promise: Promise<ScanSummary> } = { request, promise: Promise.resolve(null as unknown as ScanSummary) };
  slot.promise = running.catch(() => undefined).then(() => {
    queued = null;
    return runCurationScan(slot.request);
  });
  queued = slot;
  return slot.promise;
}

/** Espera a que terminen el análisis en curso y el agrupado (cierre ordenado y tests). */
export async function waitForCurationScans(): Promise<void> {
  while (running || queued) {
    await (queued?.promise ?? running)?.catch(() => undefined);
  }
}

export function isCurationScanRunning(): boolean {
  return running !== null;
}
