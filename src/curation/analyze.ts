// CRV · Detector de conflictos de Curaduría — orquestación pura.
//
// catálogo (snapshot) → vocabulario aprendido → detectores específicos →
// anomalías sin explicar («Otros») → hallazgos con huella estable.
// Sin base de datos: scan.ts carga la foto y persiste el resultado.
import { createHash } from "node:crypto";
import { buildLexicon, collectNames, type Lexicon } from "./lexicon.js";
import { OTHER_CATEGORY, effectiveCategory } from "./taxonomy.js";
import type { CatalogSnapshot, DetectorDefinition, EntityRef, Finding, SnapshotTrack } from "./types.js";
import type { AnalysisContext, Detector } from "./detectors/shared.js";
import { TEXT_HYGIENE_DETECTORS } from "./detectors/text-hygiene.js";
import { SEGMENTATION_DETECTORS } from "./detectors/segmentation.js";
import { MISTYPED_DETECTORS } from "./detectors/mistyped.js";
import { DUPLICATE_DETECTORS } from "./detectors/duplicates.js";
import { COHERENCE_DETECTORS } from "./detectors/coherence.js";
import { QUEUE_DETECTORS } from "./detectors/queue.js";
import { ORPHAN_DETECTORS } from "./detectors/orphans.js";
import { E11_DETECTORS } from "./detectors/advanced.js";
import { TEXT_FORM_CATEGORIES, catalogAnomalies, detectAnomalies } from "./detectors/anomalies.js";

export const DETECTORS: readonly Detector[] = [
  ...TEXT_HYGIENE_DETECTORS,
  ...SEGMENTATION_DETECTORS,
  ...MISTYPED_DETECTORS,
  ...DUPLICATE_DETECTORS,
  ...COHERENCE_DETECTORS,
  ...QUEUE_DETECTORS,
  ...ORPHAN_DETECTORS,
  ...E11_DETECTORS,
];

/**
 * LOCALES Y GLOBALES (PLAN_CURADURIA E9.1).
 *
 * Un detector LOCAL mira una ficha y su vecindad inmediata —su disco, sus
 * pistas, su artista— más el vocabulario que el catálogo ya aprendió. Puede
 * correr sobre un trozo del catálogo y dar exactamente el mismo resultado que
 * sobre el catálogo entero: es lo que se corre al verificar una corrección.
 *
 * Un detector GLOBAL necesita verlo todo para decir algo: los duplicados
 * comparan cada ficha contra todas las demás, la cola vive en `review_queue` y
 * en `conflicts` (que no cuelgan de la ficha tocada), y «Otros» necesita el
 * perfil de todo el campo para saber qué es raro. Esos corren en el análisis
 * completo diferido.
 *
 * La regla que lo sostiene: solo se resuelve lo que se miró. Un análisis
 * dirigido no toca los hallazgos de los detectores globales.
 */
const GLOBAL_DETECTOR_KEYS: ReadonlySet<string> = new Set([
  ...DUPLICATE_DETECTORS.map((detector) => detector.key),
  ...QUEUE_DETECTORS.map((detector) => detector.key),
  ...E11_DETECTORS.map((detector) => detector.key),
]);

export const LOCAL_DETECTORS: readonly Detector[] = DETECTORS.filter((detector) => !GLOBAL_DETECTOR_KEYS.has(detector.key));
export const GLOBAL_DETECTORS: readonly Detector[] = DETECTORS.filter((detector) => GLOBAL_DETECTOR_KEYS.has(detector.key));

/** «Otros» es global: su perfil por campo sale del catálogo entero. */
export const ANOMALY_DETECTOR_KEY = catalogAnomalies.key;

export function isLocalDetector(key: string): boolean {
  return key !== ANOMALY_DETECTOR_KEY && !GLOBAL_DETECTOR_KEYS.has(key);
}

/** Definiciones públicas (sin `run`) de todos los detectores, «Otros» incluido. */
export const DETECTOR_DEFINITIONS: readonly DetectorDefinition[] = [...DETECTORS, catalogAnomalies]
  .map(({ key, category, label, description, actions }) => ({ key, category, label, description, ...(actions ? { actions } : {}) }));

/**
 * Cambia cuando cambian las reglas: queda registrado en cada análisis, y lo que
 * deja de emitirse sobre un valor que no cambió se resuelve como `rules_changed`.
 * v3 (PLAN_CURADURIA E2 cierre 20/20): además de v2, elimina los falsos
 * positivos etiquetados que todavía dejaban detectores por debajo de 90 %.
 */
export const RULES_VERSION = "curation-rules.v4";

export interface DetectorFailure { detector: string; error: string; }

export interface AnalysisResult {
  findings: Array<Finding & { fingerprint: string }>;
  failures: DetectorFailure[];
  /**
   * Detectores que miraron el catálogo entero. Solo sus hallazgos pueden darse
   * por resueltos cuando no reaparecen: lo que no se pudo mirar no se resuelve.
   */
  completed: string[];
  lexicon: { places: number; roleTokens: number; organizationMarkers: string[]; albumTypeWords: number; vocabulary: number };
}

/**
 * Contexto del análisis. `lexicon` permite inyectar el vocabulario ya
 * construido: en un análisis dirigido sale de la caché (E9.3) y describe el
 * catálogo entero, no el trozo que se está mirando.
 */
export function buildContext(snapshot: CatalogSnapshot, lexicon?: Lexicon): AnalysisContext {
  const names = collectNames(snapshot);
  const tracksByAlbum = new Map<number, SnapshotTrack[]>();
  for (const track of snapshot.tracks) {
    const list = tracksByAlbum.get(track.albumId);
    if (list) list.push(track); else tracksByAlbum.set(track.albumId, [track]);
  }
  return {
    snapshot,
    lexicon: lexicon ?? buildLexicon(snapshot, names),
    names,
    artists: new Map(snapshot.artists.map((artist) => [artist.id, artist])),
    persons: new Map(snapshot.persons.map((person) => [person.id, person])),
    organizations: new Map(snapshot.organizations.map((org) => [org.id, org])),
    albums: new Map(snapshot.albums.map((album) => [album.id, album])),
    tracks: new Map(snapshot.tracks.map((track) => [track.id, track])),
    tracksByAlbum,
    currentYear: snapshot.takenAt.getFullYear(),
  };
}

/** PostgreSQL no guarda NUL en texto ni surrogates sueltos en jsonb. */
export function storableText(value: string): string {
  // eslint-disable-next-line no-control-regex -- quitar NUL es justo lo que se busca
  return value.replace(/\u0000/gu, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "\uFFFD");
}

function storable(value: unknown): unknown {
  if (typeof value === "string") return storableText(value);
  if (Array.isArray(value)) return value.map(storable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storable(item)]));
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refKey(ref: EntityRef): string {
  return `${ref.kind}:${ref.id ?? ""}`;
}

/**
 * Huella estable: detector + subgrupo + ficha + campo + valor + fichas
 * relacionadas. Si el valor cambia, es otro hallazgo (el anterior se resuelve);
 * si nada cambia, el mismo hallazgo sobrevive entre análisis con su historia.
 *
 * Un hallazgo de PAR (duplicados) es el par y nada más: detector + tipo + ids
 * menor y mayor. Ni el valor, ni el subgrupo, ni el resto del grupo: renombrar
 * una de las fichas o que aparezca una tercera no borra lo decidido sobre él.
 */
export function fingerprintOf(finding: Finding): string {
  const material = finding.pair
    ? [finding.detector, "par", finding.entity.kind, Math.min(...finding.pair), Math.max(...finding.pair)].join("␟")
    : [finding.detector, finding.signature, refKey(finding.entity), finding.field ?? "", finding.value ?? "", finding.related.map(refKey).sort().join(",")].join("␟");
  return `${finding.detector}:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export interface AnalyzeOptions {
  /** Detectores que corren; por defecto, todos. */
  detectors?: readonly Detector[];
  /** Vocabulario ya construido (caché E9.3). Sin él se aprende de esta foto. */
  lexicon?: Lexicon;
  /** ¿Corre «Otros»? Un análisis dirigido no: es global (E9.1). */
  anomalies?: boolean;
}

/**
 * Huella del CONTENIDO del hallazgo: todo lo que el detector emitió, sin su
 * historia (cuándo apareció, quién lo ignoró, qué lo desencadenó). El análisis
 * incremental (PLAN_CURADURIA E9.4) la compara con la guardada y no escribe la
 * fila si no cambió.
 *
 * Incluye la ficha y el campo aunque la huella del hallazgo ya los tenga: la de
 * un PAR de duplicados es solo el par, y el nombre que muestra sí puede cambiar.
 *
 * Y incluye la VERSIÓN DE LAS REGLAS, que no es algo que el detector emita: una
 * fila guardada es lo que dijeron unas reglas concretas sobre una ficha, así que
 * al cambiar las reglas está desfasada aunque el texto coincida. Se reescribe
 * una vez tras cada cambio de reglas, y con ella su `last_seen_scan_id`, que es
 * lo que luego permite distinguir un hallazgo que desapareció porque cambiaron
 * las reglas de uno que desapareció porque alguien arregló la ficha.
 */
export function contentHashOf(finding: Finding): string {
  const material = canonical([
    RULES_VERSION,
    finding.category, finding.signature, finding.signatureLabel ?? null, finding.severity,
    [finding.entity.kind, finding.entity.id, finding.entity.label],
    finding.field ?? null, finding.value ?? null, finding.title, finding.suggestion ?? null, finding.suggestedValue ?? null,
    finding.related, finding.evidence, finding.pair ?? null,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** JSON con las claves ordenadas: el mismo contenido da siempre el mismo texto. */
function canonical(value: unknown): string {
  if (value === undefined || value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function analyzeCatalog(snapshot: CatalogSnapshot, options: AnalyzeOptions = {}): AnalysisResult {
  const detectors = options.detectors ?? DETECTORS;
  const context = buildContext(snapshot, options.lexicon);
  const failures: DetectorFailure[] = [];
  const completed: string[] = [];
  const raw: Finding[] = [];
  for (const detector of detectors) {
    try {
      raw.push(...detector.run(context));
      completed.push(detector.key);
    } catch (error) {
      // Un detector roto no apaga a los demás: el fallo queda en el análisis.
      failures.push({ detector: detector.key, error: errorMessage(error) });
    }
  }
  // «Otros» solo muestra lo que ningún detector de forma explica. Si uno de
  // ellos falló, «Otros» se llenaría con lo que ese detector habría explicado:
  // tampoco cuenta como mirado, y sus hallazgos guardados quedan como estaban.
  const brokenForm = detectors.filter((detector) => TEXT_FORM_CATEGORIES.has(detector.category) && !completed.includes(detector.key));
  if (options.anomalies === false) {
    // Nada que decir: un análisis dirigido no mira «Otros» y sus hallazgos
    // quedan intactos (no entra en `completed`, así que no se resuelve ninguno).
  } else if (brokenForm.length) {
    failures.push({ detector: catalogAnomalies.key, error: `omitido: falló ${brokenForm.map((detector) => detector.key).join(", ")}` });
  } else {
    try {
      const explained = new Set(raw.filter((finding) => TEXT_FORM_CATEGORIES.has(finding.category)).map((finding) => refKey(finding.entity)));
      raw.push(...detectAnomalies(catalogAnomalies, context, explained));
      completed.push(catalogAnomalies.key);
    } catch (error) {
      failures.push({ detector: catalogAnomalies.key, error: errorMessage(error) });
    }
  }

  const byFingerprint = new Map<string, Finding & { fingerprint: string }>();
  for (const finding of raw) {
    const category = effectiveCategory(finding.category);
    const normalized = storable({
      ...finding,
      category,
      // Una categoría desconocida conserva de dónde venía para que se entienda en «Otros».
      ...(category === OTHER_CATEGORY && finding.category !== OTHER_CATEGORY ? { evidence: { ...finding.evidence, declaredCategory: finding.category } } : {}),
    }) as Finding;
    const fingerprint = fingerprintOf(normalized);
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, { ...normalized, fingerprint });
  }

  return {
    findings: [...byFingerprint.values()],
    failures,
    completed,
    lexicon: {
      places: context.lexicon.places.size,
      roleTokens: context.lexicon.roleTokens.size,
      organizationMarkers: [...context.lexicon.organizationMarkers].sort(),
      albumTypeWords: context.lexicon.albumTypeWords.size,
      vocabulary: context.lexicon.vocabulary.size,
    },
  };
}
