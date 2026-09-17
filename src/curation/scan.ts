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
// DETECTAR SIN MENTIR (PLAN_CURADURIA E1):
//  - Solo se resuelve lo que se miró: los hallazgos de un detector que falló
//    quedan intactos y el análisis queda `partial`. Antes se resolvían todos y
//    el siguiente análisis los «reabría» como nuevos, sin su historia.
//  - Nada lanza: una base caída termina en `failed`. Las escrituras de la API
//    disparan análisis sin esperarlos; una promesa rechazada tumbaba el proceso.
//  - Un proceso a la vez: candado de sesión `pg_try_advisory_lock` sobre la
//    conexión del análisis. Si otro proceso (la CLI, otra API) lo tiene, el
//    análisis queda `skipped` y se reintenta en la siguiente vuelta; sin esto,
//    la resolución de uno cerraba lo que el otro acababa de insertar.
//  - Cada hallazgo resuelto dice por qué y con qué run (resolution.ts).
//
// DECISIONES DURADERAS (PLAN_CURADURIA E2):
//  - Lo ignorado se respeta mientras el detector lo siga viendo; si deja de
//    verlo, pasa a `resolved` con su motivo (antes quedaba ignorado para
//    siempre). Si el mismo hallazgo vuelve, la decisión ya caducó: vuelve
//    abierto.
//  - Un refresco que cambia gravedad, título o subgrupo deja constancia en
//    `evidence.history` (los últimos 5 cambios), en vez de cambiarlo en silencio.
//
// Dentro del proceso, un solo análisis a la vez: las peticiones que llegan
// mientras corre se agrupan en uno solo posterior.
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { DETECTOR_DEFINITIONS, RULES_VERSION, analyzeCatalog, storableText, type AnalysisResult } from "./analyze.js";
import { catalogState, classifyResolution, type Resolution, type ValueChange } from "./resolution.js";
import { loadCatalogSnapshot } from "./snapshot.js";
import type { CatalogSnapshot, EntityRef, Finding } from "./types.js";

const log = moduleLogger("curation:scan");

const CHUNK = 1000;

/** Clave del candado entre procesos: la misma en la API, la CLI, los scripts y la poda. */
export const CURATION_SCAN_LOCK = "crv:curation:scan";

const KNOWN_DETECTORS = DETECTOR_DEFINITIONS.map((detector) => detector.key);
const KNOWN_DETECTOR_SET: ReadonlySet<string> = new Set(KNOWN_DETECTORS);

export interface ScanRequest {
  /** inicio | manual | correccion | cambio_en_catalogo | cli */
  trigger: string;
  requestedBy?: string | null;
  /** Qué escritura lo pidió (método y ruta), para leer el historial. */
  detail?: string | null;
  dryRun?: boolean;
}

export interface ResolvedRef { id: number; title: string; entityKind: string; entityId: number | null; }

/**
 * ok = todos los detectores miraron · partial = alguno falló (sus hallazgos no
 * se tocaron) · skipped = otro proceso estaba analizando · failed = no se pudo.
 */
export type ScanStatus = "ok" | "partial" | "skipped" | "failed";

export interface ScanSummary {
  scanId: number | null;
  status: ScanStatus;
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

/** Cambios de gravedad, título o subgrupo que se guardan por hallazgo. */
const HISTORY_LIMIT = 5;

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
    evidence: {
      ...finding.evidence,
      ...(finding.signatureLabel ? { signatureLabel: finding.signatureLabel } : {}),
      // El par queda guardado: la resolución necesita saber si fue declarado distinto.
      ...(finding.pair ? { pair: finding.pair } : {}),
    },
  };
}

/**
 * `evidence.history` tras el refresco: si cambió la gravedad, el título o el
 * subgrupo, el cambio entra primero y se conservan los últimos HISTORY_LIMIT.
 */
const HISTORY_SQL = `CASE WHEN f.severity IS DISTINCT FROM EXCLUDED.severity OR f.title IS DISTINCT FROM EXCLUDED.title OR f.signature IS DISTINCT FROM EXCLUDED.signature
  THEN (SELECT jsonb_agg(h.item ORDER BY h.n) FROM jsonb_array_elements(
          jsonb_build_array(jsonb_build_object('scanId', $2::bigint, 'at', now(),
            'from', jsonb_build_object('severity', f.severity, 'title', f.title, 'signature', f.signature),
            'to', jsonb_build_object('severity', EXCLUDED.severity, 'title', EXCLUDED.title, 'signature', EXCLUDED.signature)))
          || CASE WHEN jsonb_typeof(f.evidence->'history') = 'array' THEN f.evidence->'history' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS h(item, n) WHERE h.n <= ${HISTORY_LIMIT})
  ELSE f.evidence->'history' END`;

const RECORD_COLUMNS = `fingerprint text, category text, detector text, signature text, severity text, entity_kind text, entity_id bigint,
  entity_label text, field text, value text, title text, suggestion text, suggested_value text, related jsonb, evidence jsonb`;

async function persist(client: PoolClient, scanId: number, analysis: AnalysisResult, snapshot: CatalogSnapshot) {
  const { findings } = analysis;
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
        -- La huella de un par no incluye el valor: si una de las fichas se renombró,
        -- el hallazgo sigue siendo el mismo y muestra el nombre actual.
        field = EXCLUDED.field, value = EXCLUDED.value,
        related = EXCLUDED.related,
        -- La marca «apareció al corregir» es historia del hallazgo: no se pierde al
        -- refrescar. Un hallazgo que vuelve tras resolverse es una aparición nueva:
        -- empieza sin marca y cuenta como visto por primera vez en este análisis.
        -- El historial de cambios de gravedad/título/subgrupo se conserva siempre.
        evidence = CASE WHEN f.status = 'resolved' THEN EXCLUDED.evidence || jsonb_strip_nulls(jsonb_build_object('history', ${HISTORY_SQL}))
                        ELSE EXCLUDED.evidence || jsonb_strip_nulls(jsonb_build_object('triggeredBy', f.evidence->'triggeredBy', 'triggeredInScan', f.evidence->'triggeredInScan', 'history', ${HISTORY_SQL})) END,
        first_seen_scan_id = CASE WHEN f.status = 'resolved' THEN EXCLUDED.first_seen_scan_id ELSE f.first_seen_scan_id END,
        first_seen_at = CASE WHEN f.status = 'resolved' THEN now() ELSE f.first_seen_at END,
        last_seen_scan_id = EXCLUDED.last_seen_scan_id, last_seen_at = now(),
        status = CASE WHEN f.status = 'resolved' THEN 'open' ELSE f.status END,
        resolved_at = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.resolved_at END,
        resolution = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.resolution END,
        resolved_by_run_id = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.resolved_by_run_id END,
        -- Un ignorado que caducó (se resolvió) y vuelve, vuelve abierto y sin la decisión vieja.
        ignored_at = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.ignored_at END,
        ignored_by = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.ignored_by END,
        ignore_note = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.ignore_note END,
        ignore_reason = CASE WHEN f.status = 'resolved' THEN NULL ELSE f.ignore_reason END
      RETURNING fingerprint, (xmax = 0) AS inserted`, [payload, scanId]);
    for (const row of saved.rows) {
      if (row.inserted) { inserted += 1; appearedFingerprints.add(row.fingerprint); }
    }
  }

  const resolvedRows = await resolveStale(client, scanId, analysis, snapshot);
  const resolutions: Partial<Record<Resolution, number>> = {};
  for (const row of resolvedRows) resolutions[row.resolution] = (resolutions[row.resolution] ?? 0) + 1;

  // Encadenamiento: lo nuevo que nace donde algo se acaba de resolver. Un
  // cambio de reglas no es una corrección: lo que las reglas nuevas encuentran
  // no «apareció al corregir» nada.
  const resolvedByEntity = new Map<string, ResolvedRef[]>();
  for (const row of resolvedRows) {
    if (row.resolution === "rules_changed") continue;
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
  return { inserted, reopened, resolved: resolvedRows.length, chained: chained.length, resolutions };
}

type StaleRow = {
  id: string; detector: string; entity_kind: string; entity_id: string | null; field: string | null; value: string | null;
  rules_version: string | null; seen_since: Date | null; pair: unknown;
};
type ResolvedRow = { id: string; title: string; entity_kind: string; entity_id: string | null; related: EntityRef[]; resolution: Resolution };

/**
 * Resuelve lo abierto —y lo ignorado— que este análisis no volvió a ver, pero
 * SOLO de los detectores que miraron el catálogo entero (`analysis.completed`)
 * o de detectores que las reglas actuales ya no tienen. Cada uno con su motivo.
 */
async function resolveStale(client: PoolClient, scanId: number, analysis: AnalysisResult, snapshot: CatalogSnapshot): Promise<ResolvedRow[]> {
  const stale = await client.query<StaleRow>(`
    SELECT f.id::text, f.detector, f.entity_kind, f.entity_id::text, f.field, f.value,
           seen.counters->>'rulesVersion' AS rules_version, born.started_at AS seen_since, f.evidence->'pair' AS pair
      FROM ingest.curation_findings f
      LEFT JOIN ingest.curation_scans seen ON seen.id = f.last_seen_scan_id
      LEFT JOIN ingest.curation_scans born ON born.id = f.first_seen_scan_id
     WHERE f.status IN ('open', 'ignored') AND f.last_seen_scan_id IS DISTINCT FROM $1
       AND (f.detector = ANY($2::text[]) OR NOT (f.detector = ANY($3::text[])))`,
  [scanId, analysis.completed, KNOWN_DETECTORS]);
  if (!stale.rows.length) return [];

  const changes = await valueChanges(client, stale.rows);
  const state = catalogState(snapshot);
  const rules = { version: RULES_VERSION, detectors: KNOWN_DETECTOR_SET };
  const verdicts = stale.rows.map((row) => {
    const verdict = classifyResolution({
      detector: row.detector, entityKind: row.entity_kind, entityId: row.entity_id === null ? null : Number(row.entity_id),
      field: row.field, value: row.value, rulesVersion: row.rules_version, pair: pairOf(row.pair),
    }, changes.get(row.id), state, rules);
    return { id: row.id, resolution: verdict.resolution, run_id: verdict.runId };
  });

  const resolved: ResolvedRow[] = [];
  for (let offset = 0; offset < verdicts.length; offset += CHUNK) {
    const saved = await client.query<ResolvedRow>(`
      UPDATE ingest.curation_findings f
         SET status = 'resolved', resolved_at = now(), resolution = x.resolution, resolved_by_run_id = x.run_id
        FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, resolution text, run_id bigint)
       WHERE f.id = x.id AND f.status IN ('open', 'ignored')
      RETURNING f.id::text, f.title, f.entity_kind, f.entity_id::text, f.related, f.resolution`,
    [JSON.stringify(verdicts.slice(offset, offset + CHUNK))]);
    resolved.push(...saved.rows);
  }
  return resolved;
}

function pairOf(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every((item) => Number.isSafeInteger(item)) ? [value[0] as number, value[1] as number] : null;
}

/** Columna de `merge_audit` que apunta a cada tipo de ficha (nombres fijos, no vienen del usuario). */
const AUDIT_TARGET_COLUMN: Readonly<Record<string, string>> = {
  artist: "artist_id", person: "person_id", organization: "organization_id", album: "album_id", track: "track_id",
};

/**
 * La última escritura auditada que cambió el valor detectado desde que el
 * hallazgo apareció: `merge_audit` con el mismo campo y `old_value` = valor.
 * Su run dice quién y desde dónde (Curaduría u otra parte).
 */
async function valueChanges(client: PoolClient, rows: StaleRow[]): Promise<Map<string, ValueChange>> {
  const changes = new Map<string, ValueChange>();
  for (const [kind, column] of Object.entries(AUDIT_TARGET_COLUMN)) {
    const items = rows
      .filter((row) => row.entity_kind === kind && row.entity_id !== null && row.field && row.value !== null)
      .map((row) => ({ id: row.id, entity_id: row.entity_id, field: row.field, value: row.value, seen_since: row.seen_since }));
    for (let offset = 0; offset < items.length; offset += CHUNK) {
      const found = await client.query<{ id: string; run_id: string | null; action: string | null }>(`
        SELECT DISTINCT ON (x.id) x.id::text, a.run_id::text, r.params->>'action' AS action
          FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, entity_id bigint, field text, value text, seen_since timestamptz)
          JOIN ingest.merge_audit a
            ON a.${column} = x.entity_id AND a.field = x.field AND a.old_value = to_jsonb(x.value)
           AND (x.seen_since IS NULL OR a.at >= x.seen_since)
          LEFT JOIN ingest.scrape_runs r ON r.id = a.run_id
         ORDER BY x.id, a.id DESC`, [JSON.stringify(items.slice(offset, offset + CHUNK))]);
      for (const row of found.rows) changes.set(row.id, { runId: row.run_id === null ? null : Number(row.run_id), action: row.action });
    }
  }
  return changes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeScan(request: ScanRequest): Promise<ScanSummary> {
  const started = Date.now();
  const dryRun = request.dryRun ?? false;
  const summary: ScanSummary = {
    scanId: null, status: "failed", trigger: request.trigger, dryRun, durationMs: 0, catalogSignature: "",
    total: 0, inserted: 0, reopened: 0, resolved: 0, chained: 0, byCategory: {}, failures: [],
  };
  let client: PoolClient | null = null;
  let locked = false;
  let healthy = true;
  // Todo lo que toca la base va dentro del `try`: este análisis lo disparan
  // escrituras de la API sin esperarlo, y nada de aquí puede rechazar.
  try {
    client = await getPool().connect();
    // Un análisis que no guarda no necesita excluir a nadie.
    if (!dryRun) {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [CURATION_SCAN_LOCK]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) return await recordSkipped(client, request, summary, started);
    }
    summary.catalogSignature = await catalogSignature(client);
    if (!dryRun) {
      const created = await client.query<{ id: string }>(`
        INSERT INTO ingest.curation_scans(trigger, requested_by, catalog_signature, counters)
        VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text`,
      [request.trigger.slice(0, 40), request.requestedBy ?? null, summary.catalogSignature, JSON.stringify({ rulesVersion: RULES_VERSION, detail: request.detail ?? null })]);
      summary.scanId = Number(created.rows[0]!.id);
    }
    const snapshot = await loadCatalogSnapshot(client);
    const analysis = analyzeCatalog(snapshot);
    for (const finding of analysis.findings) summary.byCategory[finding.category] = (summary.byCategory[finding.category] ?? 0) + 1;
    summary.total = analysis.findings.length;
    summary.failures = analysis.failures;
    let resolutions: Partial<Record<Resolution, number>> = {};
    if (summary.scanId !== null) {
      await client.query("BEGIN");
      try {
        const counts = await persist(client, summary.scanId, analysis, snapshot);
        await client.query("COMMIT");
        ({ resolutions } = counts);
        Object.assign(summary, { inserted: counts.inserted, reopened: counts.reopened, resolved: counts.resolved, chained: counts.chained });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    summary.status = analysis.failures.length ? "partial" : "ok";
    summary.durationMs = Date.now() - started;
    if (summary.scanId !== null) {
      await client.query(`UPDATE ingest.curation_scans SET status = $3, finished_at = now(), counters = counters || $2::jsonb WHERE id = $1`, [summary.scanId, JSON.stringify({
        total: summary.total, inserted: summary.inserted, reopened: summary.reopened, resolved: summary.resolved, chained: summary.chained,
        resolutions, byCategory: summary.byCategory, failures: analysis.failures, durationMs: summary.durationMs, lexicon: analysis.lexicon,
      }), summary.status]);
    }
    const fields = { scanId: summary.scanId, trigger: request.trigger, total: summary.total, inserted: summary.inserted, resolved: summary.resolved, chained: summary.chained, ms: summary.durationMs };
    if (summary.status === "partial") log.warn({ ...fields, failures: analysis.failures }, "análisis de curaduría parcial: hay detectores que fallaron");
    else log.info(fields, "análisis de curaduría");
    return summary;
  } catch (error) {
    healthy = false;
    const message = errorMessage(error);
    if (summary.scanId !== null) {
      await getPool().query("UPDATE ingest.curation_scans SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [summary.scanId, message.slice(0, 2000)]).catch(() => undefined);
    }
    log.error({ err: error, scanId: summary.scanId, trigger: request.trigger }, "falló el análisis de curaduría");
    return {
      ...summary, status: "failed", durationMs: Date.now() - started,
      total: 0, inserted: 0, reopened: 0, resolved: 0, chained: 0, byCategory: {}, failures: [], error: message,
    };
  } finally {
    if (client) await releaseScanClient(client, locked, healthy);
  }
}

/** Otro proceso tiene el candado: queda constancia y se reintenta en la siguiente vuelta. */
async function recordSkipped(client: PoolClient, request: ScanRequest, summary: ScanSummary, started: number): Promise<ScanSummary> {
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.curation_scans(status, trigger, requested_by, counters, finished_at)
    VALUES ('skipped', $1, $2, $3::jsonb, now()) RETURNING id::text`,
  [request.trigger.slice(0, 40), request.requestedBy ?? null, JSON.stringify({
    rulesVersion: RULES_VERSION, detail: request.detail ?? null, reason: "otro proceso estaba analizando el catálogo",
  })]);
  const scanId = Number(saved.rows[0]!.id);
  log.info({ scanId, trigger: request.trigger }, "análisis de curaduría omitido: otro proceso está analizando");
  return { ...summary, scanId, status: "skipped", durationMs: Date.now() - started };
}

async function releaseScanClient(client: PoolClient, locked: boolean, healthy: boolean): Promise<void> {
  let reusable = healthy;
  if (locked) {
    // Si la conexión murió, PostgreSQL ya soltó el candado al cerrar la sesión.
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [CURATION_SCAN_LOCK]).catch(() => { reusable = false; });
  }
  // Tras un error la conexión puede quedar a mitad de transacción: se descarta.
  client.release(!reusable);
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
