// CRV · Detector de conflictos de Curaduría — orquestación pura.
//
// catálogo (snapshot) → vocabulario aprendido → detectores específicos →
// anomalías sin explicar («Otros») → hallazgos con huella estable.
// Sin base de datos: scan.ts carga la foto y persiste el resultado.
import { createHash } from "node:crypto";
import { buildLexicon, collectNames } from "./lexicon.js";
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
import { TEXT_FORM_CATEGORIES, catalogAnomalies, detectAnomalies } from "./detectors/anomalies.js";

export const DETECTORS: readonly Detector[] = [
  ...TEXT_HYGIENE_DETECTORS,
  ...SEGMENTATION_DETECTORS,
  ...MISTYPED_DETECTORS,
  ...DUPLICATE_DETECTORS,
  ...COHERENCE_DETECTORS,
  ...QUEUE_DETECTORS,
  ...ORPHAN_DETECTORS,
];

/** Definiciones públicas (sin `run`) de todos los detectores, «Otros» incluido. */
export const DETECTOR_DEFINITIONS: readonly DetectorDefinition[] = [...DETECTORS, catalogAnomalies]
  .map(({ key, category, label, description, actions }) => ({ key, category, label, description, ...(actions ? { actions } : {}) }));

/**
 * Cambia cuando cambian las reglas: queda registrado en cada análisis, y lo que
 * deja de emitirse sobre un valor que no cambió se resuelve como `rules_changed`.
 * v2 (PLAN_CURADURIA E2): precisión de A6, pares estables, «Otros» por clase.
 */
export const RULES_VERSION = "curation-rules.v2";

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

export function buildContext(snapshot: CatalogSnapshot): AnalysisContext {
  const names = collectNames(snapshot);
  const tracksByAlbum = new Map<number, SnapshotTrack[]>();
  for (const track of snapshot.tracks) {
    const list = tracksByAlbum.get(track.albumId);
    if (list) list.push(track); else tracksByAlbum.set(track.albumId, [track]);
  }
  return {
    snapshot,
    lexicon: buildLexicon(snapshot, names),
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

export function analyzeCatalog(snapshot: CatalogSnapshot, detectors: readonly Detector[] = DETECTORS): AnalysisResult {
  const context = buildContext(snapshot);
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
  if (brokenForm.length) {
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
