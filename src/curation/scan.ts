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
// VERIFICACIÓN DIRIGIDA (PLAN_CURADURIA E4.6, E9.1): tras aplicar un lote de
// correcciones —o tras una escritura de la API que nombra una ficha— un
// análisis con `focus` mira SOLO la vecindad de esas fichas y solo con los
// detectores LOCALES (`scope = 'dirigido'`). Guarda y resuelve únicamente los
// hallazgos de las fichas que miró (`covered`). Lo global —duplicados, cola,
// «Otros»— y lo que quede fuera del foco los recoge el análisis completo
// diferido. Un análisis dirigido no cuenta como «último análisis» ni como
// firma vista por el vigilante. Un hallazgo con un ítem de lote aplicado se
// resuelve como `fixed_by_curation` con el run de ese ítem, aunque la
// corrección haya retirado su ficha (una fusión).
//
// RENDIMIENTO (PLAN_CURADURIA E9): el análisis completo ya no se dispara con
// cada escritura (A9). Se escribe solo la diferencia —altas, reaperturas y
// cambios—, el vocabulario se reutiliza mientras el catálogo no se mueva y cada
// análisis deja en sus contadores dónde se fue el tiempo (`timings`).
//
// Dentro del proceso, un solo análisis a la vez: las peticiones que llegan
// mientras corre se agrupan en uno solo posterior. Las verificaciones
// dirigidas no se agrupan (cada una tiene su foco): hacen cola detrás.
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { summarizeActions } from "./actions/registry.js";
import type { ActionFinding, ActionLevel } from "./actions/types.js";
import {
  DETECTOR_DEFINITIONS, LOCAL_DETECTORS, RULES_VERSION, analyzeCatalog, contentHashOf, storableText, type AnalysisResult,
} from "./analyze.js";
import { buildLexicon, collectNames } from "./lexicon.js";
import { cachedLexicon, rememberLexicon, type LexiconSource } from "./lexicon-cache.js";
import { catalogState, classifyResolution, type AppliedFix, type Resolution, type ValueChange } from "./resolution.js";
import { loadCatalogSnapshot, loadFocusedSnapshot, type FocusRef } from "./snapshot.js";
import type { CatalogSnapshot, EntityRef, Finding } from "./types.js";

const log = moduleLogger("curation:scan");

const CHUNK = 1000;

/** Clave del candado entre procesos: la misma en la API, la CLI, los scripts y la poda. */
export const CURATION_SCAN_LOCK = "crv:curation:scan";

/** Una verificación dirigida la pidió alguien que acaba de corregir: espera su turno un rato antes de omitirse. */
const DIRECTED_LOCK_ATTEMPTS = 20;
const DIRECTED_LOCK_RETRY_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const KNOWN_DETECTORS = DETECTOR_DEFINITIONS.map((detector) => detector.key);
const KNOWN_DETECTOR_SET: ReadonlySet<string> = new Set(KNOWN_DETECTORS);

export interface ScanRequest {
  /** inicio | manual | correccion | cambio_en_catalogo | cli */
  trigger: string;
  requestedBy?: string | null;
  /** Qué escritura lo pidió (método y ruta), para leer el historial. */
  detail?: string | null;
  dryRun?: boolean;
  /** Verificación dirigida: solo se guarda y resuelve lo que toca a estas fichas (la suya o una relacionada). */
  focus?: Focus;
}

type Focus = ReadonlyArray<FocusRef>;

export interface ResolvedRef { id: number; title: string; entityKind: string; entityId: number | null; }

/** Qué cambió en una verificación dirigida, hallazgo por hallazgo (se adjunta al lote). */
export interface ScanDetails {
  resolved: Array<ResolvedRef & { resolution: Resolution }>;
  /** Nuevos o reabiertos en las fichas del foco. */
  appeared: ResolvedRef[];
  /** De los aparecidos, los que nacieron donde otro se acababa de resolver. */
  triggered: ResolvedRef[];
}

export type ScanScope = "completo" | "dirigido";

/**
 * ok = todos los detectores miraron · partial = alguno falló (sus hallazgos no
 * se tocaron) · skipped = otro proceso estaba analizando · failed = no se pudo.
 */
export type ScanStatus = "ok" | "partial" | "skipped" | "failed";

export interface ScanSummary {
  scanId: number | null;
  status: ScanStatus;
  scope: ScanScope;
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
  /** Acciones recomendadas por nivel; también se calcula en `--dry-run` sin escribir nada. */
  actionLevels: RecommendedActionLevels;
  failures: Array<{ detector: string; error: string }>;
  error?: string;
  /** Solo en una verificación dirigida. */
  details?: ScanDetails;
  /** Dónde se fue el tiempo (PLAN_CURADURIA E9.5): queda en los contadores del análisis. */
  timings: ScanTimings;
}

export interface ScanTimings {
  /** Cargar la foto del catálogo (completa o dirigida). */
  snapshotMs: number;
  /** Aprender el vocabulario, o 0 si se reutilizó el de la caché. */
  lexiconMs: number;
  /** Correr los detectores. */
  detectMs: number;
  /** Guardar altas, cambios y resoluciones. */
  persistMs: number;
  /** De dónde salió el vocabulario: del catálogo, de la caché o de una huella anterior. */
  lexicon: LexiconSource;
  /** Fichas efectivamente miradas en un análisis dirigido. */
  covered?: number;
}

export interface ActionLevelCounts {
  level0: number;
  level1: number;
  level2: number;
  /** Sin acción disponible: requiere edición o una etapa posterior del plan. */
  manual: number;
}

export interface RecommendedActionLevels extends ActionLevelCounts {
  byCategory: Record<string, ActionLevelCounts>;
}

function emptyActionCounts(): ActionLevelCounts {
  return { level0: 0, level1: 0, level2: 0, manual: 0 };
}

function emptyTimings(): ScanTimings {
  return { snapshotMs: 0, lexiconMs: 0, detectMs: 0, persistMs: 0, lexicon: "catalogo" };
}

function actionFinding(finding: Finding): ActionFinding {
  return {
    // Antes de persistir no existe aún id ni estado. Las acciones solo usan
    // esos dos datos al planificar contra la base; para contar la recomendada
    // basta la misma forma que se guardará en `curation_findings`.
    id: 0,
    status: "open",
    detector: finding.detector,
    signature: finding.signature,
    entity: finding.entity,
    field: finding.field ?? null,
    value: finding.value ?? null,
    suggestedValue: finding.suggestedValue ?? null,
    related: finding.related,
    evidence: finding.evidence,
    title: finding.title,
  };
}

function bumpActionCount(counts: ActionLevelCounts, level: ActionLevel | undefined): void {
  if (level === 0) counts.level0 += 1;
  else if (level === 1) counts.level1 += 1;
  else if (level === 2) counts.level2 += 1;
  else counts.manual += 1;
}

/**
 * Cuenta la primera acción que la UI recomendaría por cada hallazgo. Es pura:
 * sirve para que el escaneo seco informe cobertura sin consultar ni mutar
 * `ingest.curation_findings`.
 */
export function recommendedActionLevels(findings: readonly Finding[]): RecommendedActionLevels {
  const total = emptyActionCounts();
  const byCategory: Record<string, ActionLevelCounts> = {};
  for (const finding of findings) {
    const category = byCategory[finding.category] ?? (byCategory[finding.category] = emptyActionCounts());
    const level = summarizeActions(actionFinding(finding))[0]?.level;
    bumpActionCount(total, level);
    bumpActionCount(category, level);
  }
  return { ...total, byCategory };
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
        OR (schemaname = 'ingest' AND relname IN (
          'conflicts', 'review_queue', 'claims', 'entity_redirects',
          'artist_aliases', 'person_aliases', 'organization_aliases', 'album_aliases', 'track_aliases'
        ))
        OR (schemaname = 'media' AND relname = 'media_links')`);
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
    content_hash: contentHashOf(finding),
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

const RECORD_COLUMNS = `fingerprint text, content_hash text, category text, detector text, signature text, severity text, entity_kind text, entity_id bigint,
  entity_label text, field text, value text, title text, suggestion text, suggested_value text, related jsonb, evidence jsonb`;

/**
 * Guarda el resultado del análisis ESCRIBIENDO SOLO LA DIFERENCIA
 * (PLAN_CURADURIA E9.4). Antes, cada vuelta reescribía las ~5.400 filas
 * abiertas aunque nada hubiera cambiado: una versión nueva de cada tupla, sus
 * índices y su WAL, más el autovacuum detrás.
 *
 * Ahora se lee primero el estado guardado de las huellas que este análisis
 * emitió —id, estado y huella de contenido— y se reparte:
 *   * alta: la huella no existía;
 *   * reapertura: existía resuelta y el detector la volvió a ver;
 *   * cambio: existe abierta o ignorada, pero el contenido es otro (gravedad,
 *     título, valor, evidencia…);
 *   * igual: no se toca más que «visto por última vez», en un solo UPDATE
 *     estrecho por lote.
 * Solo las tres primeras pasan por el UPSERT completo.
 */
async function persist(client: PoolClient, scanId: number, analysis: AnalysisResult, snapshot: CatalogSnapshot, covered: Focus | null) {
  const { findings } = analysis;
  let inserted = 0; let reopened = 0; let unchanged = 0;
  // Lo que aparece en este análisis: nuevo o reabierto (se había resuelto y volvió).
  const appearedFingerprints = new Set<string>();
  const idByFingerprint = new Map<string, number>();
  const rows = findings.map(rowOf);
  const stored = await storedState(client, rows.map((row) => row.fingerprint));
  const pending: Array<ReturnType<typeof rowOf>> = [];
  for (const row of rows) {
    const previous = stored.get(row.fingerprint);
    if (previous && previous.status !== "resolved" && previous.content_hash === row.content_hash) {
      unchanged += 1;
      idByFingerprint.set(row.fingerprint, Number(previous.id));
      continue;
    }
    if (previous?.status === "resolved") { reopened += 1; appearedFingerprints.add(row.fingerprint); }
    pending.push(row);
  }

  for (let offset = 0; offset < pending.length; offset += CHUNK) {
    const payload = JSON.stringify(pending.slice(offset, offset + CHUNK));
    const saved = await client.query<{ id: string; fingerprint: string; inserted: boolean }>(`
      INSERT INTO ingest.curation_findings AS f
        (fingerprint, content_hash, category, detector, signature, severity, entity_kind, entity_id, entity_label, field, value, title, suggestion,
         suggested_value, related, evidence, first_seen_scan_id, last_seen_scan_id)
      SELECT fingerprint, content_hash, category, detector, signature, severity, entity_kind, entity_id, entity_label, field, value, title, suggestion,
             suggested_value, related, evidence, $2, $2
        FROM jsonb_to_recordset($1::jsonb) AS x(${RECORD_COLUMNS})
      ON CONFLICT (fingerprint) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
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
      RETURNING id::text, fingerprint, (xmax = 0) AS inserted`, [payload, scanId]);
    for (const row of saved.rows) {
      idByFingerprint.set(row.fingerprint, Number(row.id));
      if (row.inserted) { inserted += 1; appearedFingerprints.add(row.fingerprint); }
    }
  }

  // LO QUE NO CAMBIÓ NO SE ESCRIBE (PLAN_CURADURIA E9.4). Ni siquiera para
  // sellar «lo he vuelto a ver»: con 22.500 hallazgos abiertos eso era un
  // segundo y cuarto de escrituras por análisis para no decir nada nuevo. Que
  // un hallazgo siga abierto ya significa que el último análisis que miró su
  // detector lo volvió a encontrar, porque si no lo hubiera resuelto; y qué se
  // ha mirado en ESTE análisis se lo dice a `resolveStale` la lista de huellas
  // encontradas, no la marca en la fila. `last_seen_scan_id` queda con su
  // sentido exacto: el último análisis que escribió algo de este hallazgo,
  // que es también el que fija con qué versión de las reglas se escribió.
  const resolvedRows = await resolveStale(client, analysis, snapshot, covered);
  const resolutions: Partial<Record<Resolution, number>> = {};
  for (const row of resolvedRows) resolutions[row.resolution] = (resolutions[row.resolution] ?? 0) + 1;

  // Encadenamiento: lo nuevo que nace donde algo se acaba de resolver. Un
  // cambio de reglas no es una corrección: lo que las reglas nuevas encuentran
  // no «apareció al corregir» nada.
  const resolvedByEntity = new Map<string, ResolvedRef[]>();
  // El MISMO problema con otro nombre no es un problema nuevo. La huella de un
  // hallazgo de nombre incluye el valor, así que al corregir un nombre todo lo
  // que ese nombre tenía abierto se resuelve y vuelve a entrar con huella nueva:
  // «Ficha sin vínculos» sobre el mismo artista no apareció al corregir, seguía
  // ahí. Contarlo como desencadenado engañaba a quien revisa y, peor, hacía
  // saltar el interruptor de emergencia de la autocorrección (E10.3) cada vez
  // que la ficha corregida tenía algún otro hallazgo de nombre.
  const continued = new Set<string>();
  for (const row of resolvedRows) {
    if (row.resolution === "rules_changed") continue;
    const ref: ResolvedRef = { id: Number(row.id), title: row.title, entityKind: row.entity_kind, entityId: row.entity_id === null ? null : Number(row.entity_id) };
    continued.add(`${row.detector}\u241f${row.signature}\u241f${refKey(row.entity_kind, ref.entityId)}`);
    for (const key of [refKey(row.entity_kind, ref.entityId), ...(row.related ?? []).map((item) => refKey(item.kind, item.id))]) {
      if (key.endsWith(":")) continue;
      resolvedByEntity.set(key, [...(resolvedByEntity.get(key) ?? []), ref]);
    }
  }
  const chained: Array<{ fingerprint: string; triggered_by: ResolvedRef[] }> = [];
  if (resolvedByEntity.size && appearedFingerprints.size) {
    for (const finding of findings) {
      if (!appearedFingerprints.has(finding.fingerprint)) continue;
      if (continued.has(`${finding.detector}\u241f${finding.signature}\u241f${refKey(finding.entity.kind, finding.entity.id)}`)) continue;
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

  let details: ScanDetails | undefined;
  if (covered) {
    const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
    const refsOf = (fingerprints: Iterable<string>): ResolvedRef[] => [...fingerprints].flatMap((fingerprint) => {
      const finding = byFingerprint.get(fingerprint);
      const id = idByFingerprint.get(fingerprint);
      return finding && id !== undefined
        ? [{ id, title: storableText(finding.title), entityKind: finding.entity.kind, entityId: finding.entity.id }]
        : [];
    });
    details = {
      resolved: resolvedRows.map((row) => ({
        id: Number(row.id), title: row.title, entityKind: row.entity_kind, entityId: row.entity_id === null ? null : Number(row.entity_id), resolution: row.resolution,
      })),
      appeared: refsOf(appearedFingerprints),
      triggered: refsOf(chained.map((item) => item.fingerprint)),
    };
  }
  return { inserted, reopened, unchanged, resolved: resolvedRows.length, chained: chained.length, resolutions, details };
}

/** Estado guardado de las huellas que este análisis emitió: lo justo para repartir. */
async function storedState(client: PoolClient, fingerprints: readonly string[]): Promise<Map<string, { id: string; status: string; content_hash: string | null }>> {
  const stored = new Map<string, { id: string; status: string; content_hash: string | null }>();
  for (let offset = 0; offset < fingerprints.length; offset += CHUNK) {
    const { rows } = await client.query<{ id: string; fingerprint: string; status: string; content_hash: string | null }>(`
      SELECT id::text, fingerprint, status, content_hash FROM ingest.curation_findings WHERE fingerprint = ANY($1::text[])`,
    [fingerprints.slice(offset, offset + CHUNK)]);
    for (const row of rows) stored.set(row.fingerprint, { id: row.id, status: row.status, content_hash: row.content_hash });
  }
  return stored;
}

type StaleRow = {
  id: string; detector: string; entity_kind: string; entity_id: string | null; field: string | null; value: string | null;
  rules_version: string | null; seen_since: Date | null; pair: unknown;
};
type ResolvedRow = {
  id: string; detector: string; signature: string; title: string; entity_kind: string; entity_id: string | null;
  related: EntityRef[]; resolution: Resolution;
};

/**
 * Resuelve lo abierto —y lo ignorado— que este análisis no volvió a ver, pero
 * SOLO de los detectores que miraron el catálogo entero (`analysis.completed`)
 * o de detectores que las reglas actuales ya no tienen. Cada uno con su motivo.
 */
async function resolveStale(
  client: PoolClient, analysis: AnalysisResult, snapshot: CatalogSnapshot, covered: Focus | null,
): Promise<ResolvedRow[]> {
  // SOLO SE RESUELVE LO QUE SE MIRÓ. En un análisis dirigido, «lo mirado» son
  // las fichas de la foto dirigida y las que se pidieron y ya no están
  // (`covered`, snapshot.ts): de cada una se miró su vecindad entera, así que
  // un hallazgo suyo que no reaparece es un hallazgo resuelto. Un hallazgo de
  // otra ficha no se toca aunque nombre a una del foco: no se volvió a mirar.
  // El JOIN contra la lista cubierta usa el índice (entity_kind, entity_id):
  // recorrer lo abierto entero por cada verificación costaría más que el
  // análisis. En un análisis completo no hay lista y se mira todo.
  const scoped = covered !== null;
  // Lo que este análisis encontró. No se pregunta por la marca de la fila
  // —que ya no se refresca cuando nada cambió (E9.4)— sino por la huella:
  // «abierto y no está entre lo que acabo de encontrar» es exactamente lo que
  // hay que dar por resuelto, y se dice en una comparación que PostgreSQL
  // resuelve con una tabla hash.
  const seen = analysis.findings.map((finding) => finding.fingerprint);
  // Con foco, el filtro por detector no va en SQL: la lista cubierta ya acota
  // las filas y el reparto fino se hace abajo, con la foto delante.
  const found = await client.query<StaleRow>(`
    SELECT f.id::text, f.detector, f.entity_kind, f.entity_id::text, f.field, f.value,
           seen.counters->>'rulesVersion' AS rules_version, born.started_at AS seen_since, f.evidence->'pair' AS pair
      FROM ingest.curation_findings f
      ${scoped ? "JOIN unnest($2::text[], $3::bigint[]) AS covered(kind, id) ON covered.kind = f.entity_kind AND covered.id = f.entity_id" : ""}
      LEFT JOIN ingest.curation_scans seen ON seen.id = f.last_seen_scan_id
      LEFT JOIN ingest.curation_scans born ON born.id = f.first_seen_scan_id
     WHERE f.status IN ('open', 'ignored') AND NOT (f.fingerprint = ANY($1::text[]))
       ${scoped ? "" : "AND (f.detector = ANY($2::text[]) OR NOT (f.detector = ANY($3::text[])))"}`,
  scoped
    ? [seen, covered.map((ref) => ref.kind), covered.map((ref) => ref.id)]
    : [seen, analysis.completed, KNOWN_DETECTORS]);
  const state = catalogState(snapshot);
  // Qué se puede dar por resuelto: lo que miró un detector de este análisis, lo
  // de una regla que ya no existe y —solo con foco— lo de una ficha que la foto
  // pidió y ya no está. Que una ficha se haya retirado o fusionado se ve sin
  // correr su detector, así que una fusión cierra su hallazgo de duplicados
  // aunque los duplicados sean un detector global que el dirigido no corre.
  const looked = new Set(analysis.completed);
  const stale = { rows: found.rows.filter((row) => {
    if (!KNOWN_DETECTOR_SET.has(row.detector) || looked.has(row.detector)) return true;
    return row.entity_id !== null && state.exists(row.entity_kind, Number(row.entity_id)) === false;
  }) };
  if (!stale.rows.length) return [];

  const changes = await valueChanges(client, stale.rows);
  const fixes = await appliedFixes(client, stale.rows);
  const rules = { version: RULES_VERSION, detectors: KNOWN_DETECTOR_SET };
  const verdicts = stale.rows.map((row) => {
    const verdict = classifyResolution({
      detector: row.detector, entityKind: row.entity_kind, entityId: row.entity_id === null ? null : Number(row.entity_id),
      field: row.field, value: row.value, rulesVersion: row.rules_version, pair: pairOf(row.pair),
    }, changes.get(row.id), state, rules, fixes.get(row.id));
    return { id: row.id, resolution: verdict.resolution, run_id: verdict.runId };
  });

  const resolved: ResolvedRow[] = [];
  for (let offset = 0; offset < verdicts.length; offset += CHUNK) {
    const saved = await client.query<ResolvedRow>(`
      UPDATE ingest.curation_findings f
         SET status = 'resolved', resolved_at = now(), resolution = x.resolution, resolved_by_run_id = x.run_id
        FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, resolution text, run_id bigint)
       WHERE f.id = x.id AND f.status IN ('open', 'ignored')
      RETURNING f.id::text, f.detector, f.signature, f.title, f.entity_kind, f.entity_id::text, f.related, f.resolution`,
    [JSON.stringify(verdicts.slice(offset, offset + CHUNK))]);
    resolved.push(...saved.rows);
  }
  return resolved;
}

function pairOf(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every((item) => Number.isSafeInteger(item)) ? [value[0] as number, value[1] as number] : null;
}

/**
 * El ítem de lote aplicado más reciente sobre cada hallazgo desde que apareció
 * (M1): su run es la corrección, también cuando fue una fusión que retiró la
 * ficha o una limpieza cubierta por otra del mismo lote. Un ítem deshecho no
 * cuenta, ni el de un lote de deshacer: deshacer no corrige nada.
 */
async function appliedFixes(client: PoolClient, rows: StaleRow[]): Promise<Map<string, AppliedFix>> {
  const fixes = new Map<string, AppliedFix>();
  const ids = rows.map((row) => row.id);
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const found = await client.query<{ id: string; run_id: string }>(`
      SELECT DISTINCT ON (i.finding_id) i.finding_id::text AS id, i.run_id::text
        FROM ingest.curation_fix_items i
        JOIN ingest.curation_fix_batches b ON b.id = i.batch_id AND b.mode <> 'undo'
        JOIN ingest.curation_findings f ON f.id = i.finding_id
       WHERE i.finding_id = ANY($1::bigint[]) AND i.status = 'applied' AND i.run_id IS NOT NULL
         AND i.applied_at >= f.first_seen_at
       ORDER BY i.finding_id, i.applied_at DESC, i.id DESC`, [ids.slice(offset, offset + CHUNK)]);
    for (const row of found.rows) fixes.set(row.id, { runId: Number(row.run_id) });
  }
  return fixes;
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

interface AnalysisRun {
  snapshot: CatalogSnapshot;
  analysis: AnalysisResult;
  /** Fichas miradas en un análisis dirigido; `null` en uno completo (se miró todo). */
  covered: Focus | null;
}

/**
 * Análisis COMPLETO: la foto entera, el vocabulario aprendido de ella (o el de
 * la caché si el catálogo no se ha movido) y todos los detectores.
 */
async function analyzeEverything(client: PoolClient, summary: ScanSummary): Promise<AnalysisRun> {
  const loading = Date.now();
  const snapshot = await loadCatalogSnapshot(client);
  summary.timings.snapshotMs = Date.now() - loading;

  const learning = Date.now();
  // Un análisis completo aprende SIEMPRE del catálogo que acaba de cargar y
  // deja la caché al día para las verificaciones dirigidas. Reutilizar el
  // vocabulario cuando la huella no ha cambiado sería fiarse de
  // `pg_stat_user_tables`, que llega tarde: el análisis que manda no puede
  // juzgar el catálogo de ahora con el vocabulario de antes.
  const lexicon = buildLexicon(snapshot, collectNames(snapshot));
  rememberLexicon(summary.catalogSignature, lexicon);
  summary.timings.lexicon = "catalogo";
  summary.timings.lexiconMs = Date.now() - learning;

  const detecting = Date.now();
  const analysis = analyzeCatalog(snapshot, { lexicon });
  summary.timings.detectMs = Date.now() - detecting;
  return { snapshot, analysis, covered: null };
}

/**
 * Análisis DIRIGIDO (PLAN_CURADURIA E9.1): la vecindad de las fichas tocadas y
 * solo los detectores locales. Los globales —duplicados, cola y «Otros»— no
 * corren ni se dan por mirados: los recoge el completo diferido.
 *
 * El vocabulario sale de la caché aunque la huella haya cambiado: la escritura
 * que se está verificando es justo la que la cambió. Con la caché fría se
 * aprende del catálogo entero una vez; a partir de ahí, cada verificación
 * cuesta lo que cuesta leer cuatro fichas.
 */
async function analyzeFocus(client: PoolClient, focus: Focus, summary: ScanSummary): Promise<AnalysisRun> {
  const loading = Date.now();
  const focused = await loadFocusedSnapshot(client, focus);
  summary.timings.snapshotMs = Date.now() - loading;
  summary.timings.covered = focused.covered.length;

  const learning = Date.now();
  const reused = cachedLexicon(summary.catalogSignature);
  let lexicon = reused?.lexicon;
  if (!lexicon) {
    const whole = await loadCatalogSnapshot(client);
    lexicon = buildLexicon(whole, collectNames(whole));
    rememberLexicon(summary.catalogSignature, lexicon);
  }
  summary.timings.lexicon = reused?.source ?? "catalogo";
  summary.timings.lexiconMs = reused ? 0 : Date.now() - learning;

  const detecting = Date.now();
  const analysis = analyzeCatalog(focused.snapshot, { detectors: LOCAL_DETECTORS, lexicon, anomalies: false });
  summary.timings.detectMs = Date.now() - detecting;
  return { snapshot: focused.snapshot, analysis, covered: focused.covered };
}

async function executeScan(request: ScanRequest): Promise<ScanSummary> {
  const started = Date.now();
  const dryRun = request.dryRun ?? false;
  const focus = request.focus ?? null;
  const summary: ScanSummary = {
    scanId: null, status: "failed", scope: focus ? "dirigido" : "completo", trigger: request.trigger, dryRun, durationMs: 0, catalogSignature: "",
    total: 0, inserted: 0, reopened: 0, resolved: 0, chained: 0, byCategory: {}, actionLevels: { ...emptyActionCounts(), byCategory: {} }, failures: [],
    timings: emptyTimings(),
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
      const attempts = focus ? DIRECTED_LOCK_ATTEMPTS : 1;
      for (let attempt = 1; ; attempt += 1) {
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [CURATION_SCAN_LOCK]);
        locked = lock.rows[0]?.locked === true;
        if (locked || attempt >= attempts) break;
        await sleep(DIRECTED_LOCK_RETRY_MS);
      }
      if (!locked) return await recordSkipped(client, request, summary, started);
    }
    summary.catalogSignature = await catalogSignature(client);
    if (!dryRun) {
      const created = await client.query<{ id: string }>(`
        INSERT INTO ingest.curation_scans(trigger, requested_by, catalog_signature, counters, scope)
        VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id::text`,
      [request.trigger.slice(0, 40), request.requestedBy ?? null, summary.catalogSignature, JSON.stringify({
        rulesVersion: RULES_VERSION, detail: request.detail ?? null, ...(focus ? { focus: focus.length } : {}),
      }), summary.scope]);
      summary.scanId = Number(created.rows[0]!.id);
    }
    const { snapshot, analysis, covered } = focus
      ? await analyzeFocus(client, focus, summary)
      : await analyzeEverything(client, summary);
    for (const finding of analysis.findings) summary.byCategory[finding.category] = (summary.byCategory[finding.category] ?? 0) + 1;
    summary.total = analysis.findings.length;
    summary.actionLevels = recommendedActionLevels(analysis.findings);
    summary.failures = analysis.failures;
    let resolutions: Partial<Record<Resolution, number>> = {};
    let unchanged = 0;
    if (summary.scanId !== null) {
      const persisting = Date.now();
      await client.query("BEGIN");
      try {
        const counts = await persist(client, summary.scanId, analysis, snapshot, covered);
        await client.query("COMMIT");
        ({ resolutions, unchanged } = counts);
        Object.assign(summary, { inserted: counts.inserted, reopened: counts.reopened, resolved: counts.resolved, chained: counts.chained });
        if (counts.details) summary.details = counts.details;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      summary.timings.persistMs = Date.now() - persisting;
    }
    summary.status = analysis.failures.length ? "partial" : "ok";
    summary.durationMs = Date.now() - started;
    if (summary.scanId !== null) {
      await client.query(`UPDATE ingest.curation_scans SET status = $3, finished_at = now(), counters = counters || $2::jsonb WHERE id = $1`, [summary.scanId, JSON.stringify({
        total: summary.total, inserted: summary.inserted, reopened: summary.reopened, unchanged, resolved: summary.resolved, chained: summary.chained,
        resolutions, byCategory: summary.byCategory, actionLevels: summary.actionLevels, failures: analysis.failures, durationMs: summary.durationMs,
        lexicon: analysis.lexicon, timings: summary.timings,
      }), summary.status]);
    }
    const fields = { scanId: summary.scanId, scope: summary.scope, trigger: request.trigger, total: summary.total, inserted: summary.inserted, resolved: summary.resolved, chained: summary.chained, ms: summary.durationMs };
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
      total: 0, inserted: 0, reopened: 0, resolved: 0, chained: 0, byCategory: {}, actionLevels: { ...emptyActionCounts(), byCategory: {} }, failures: [],
      timings: summary.timings, error: message,
    };
  } finally {
    if (client) await releaseScanClient(client, locked, healthy);
  }
}

/** Otro proceso tiene el candado: queda constancia y se reintenta en la siguiente vuelta. */
async function recordSkipped(client: PoolClient, request: ScanRequest, summary: ScanSummary, started: number): Promise<ScanSummary> {
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.curation_scans(status, trigger, requested_by, counters, finished_at, scope)
    VALUES ('skipped', $1, $2, $3::jsonb, now(), $4) RETURNING id::text`,
  [request.trigger.slice(0, 40), request.requestedBy ?? null, JSON.stringify({
    rulesVersion: RULES_VERSION, detail: request.detail ?? null, reason: "otro proceso estaba analizando el catálogo",
  }), summary.scope]);
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
/** Verificaciones dirigidas: una detrás de otra, y cada una detrás del análisis en curso y del agrupado. */
let directedTail: Promise<unknown> = Promise.resolve();
let directedPending = 0;
/** Trabajo que termina en un análisis (la verificación de un lote): lo esperan el cierre ordenado y las pruebas. */
const background = new Set<Promise<unknown>>();

/**
 * Lo que corre DESPUÉS de un análisis completo guardado: hoy, la
 * autocorrección (PLAN_CURADURIA E10). Se instala desde fuera
 * (`src/curation/autofix.ts` ← la API y la CLI) para que el motor de análisis
 * no dependa del marco de acciones, que a su vez depende de él.
 *
 * Corre fuera del análisis, no dentro: mientras `executeScan` vive tiene el
 * candado entre procesos, y la verificación dirigida de la autocorrección lo
 * necesita libre.
 */
export type AfterFullScan = (summary: ScanSummary) => Promise<unknown>;

let afterFullScan: AfterFullScan | null = null;

export function setAfterFullScan(hook: AfterFullScan | null): void {
  afterFullScan = hook;
}

function runAfterFullScan(summary: ScanSummary): void {
  if (!afterFullScan || summary.dryRun || summary.scope !== "completo") return;
  if (summary.status !== "ok" && summary.status !== "partial") return;
  void trackCurationWork(afterFullScan(summary).catch((error: unknown) => {
    log.error({ err: error, scanId: summary.scanId }, "falló el trabajo posterior al análisis de curaduría");
  }));
}

/** Corre un análisis; si ya hay uno en curso, agrupa esta petición en el siguiente. */
export function runCurationScan(request: ScanRequest): Promise<ScanSummary> {
  if (request.dryRun) return executeScan(request);
  if (request.focus) return runDirectedScan(request);
  if (!running) {
    const current = executeScan(request).finally(() => { running = null; });
    running = current;
    // El gancho va detrás del `finally`: cuando corre, el análisis ya soltó su turno.
    void current.then(runAfterFullScan, () => undefined);
    return current;
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

function runDirectedScan(request: ScanRequest): Promise<ScanSummary> {
  directedPending += 1;
  const task = directedTail.then(async () => {
    // Solo espera al análisis en curso y al agrupado: esperar al trabajo en
    // segundo plano podría ser esperarse a sí misma (la verificación de un lote).
    while (running || queued) await (queued?.promise ?? running)?.catch(() => undefined);
    const current: Promise<ScanSummary> = executeScan(request).finally(() => { if (running === current) running = null; });
    // Mientras corre, un análisis completo que llegue se agrupa detrás, no choca con el candado.
    running = current;
    return current;
  }).finally(() => { directedPending -= 1; });
  directedTail = task.catch(() => undefined);
  return task;
}

/** Registra trabajo en segundo plano que termina en un análisis, para que el cierre ordenado y las pruebas lo esperen. */
export function trackCurationWork<T>(work: Promise<T>): Promise<T> {
  background.add(work);
  const done = () => { background.delete(work); };
  void work.then(done, done);
  return work;
}

/** Espera a que terminen el análisis en curso, el agrupado, las verificaciones dirigidas y el trabajo en segundo plano (cierre ordenado y tests). */
export async function waitForCurationScans(): Promise<void> {
  while (running || queued || directedPending > 0 || background.size > 0) {
    await Promise.allSettled([running, queued?.promise, directedTail, ...background].filter((item) => item !== null && item !== undefined));
  }
}

export function isCurationScanRunning(): boolean {
  return running !== null;
}
