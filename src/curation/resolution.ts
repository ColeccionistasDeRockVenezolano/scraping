// CRV · Por qué se resolvió un hallazgo (PLAN_CURADURIA E1, M1).
//
// Un hallazgo abierto que un detector sano deja de emitir se resuelve. Antes
// solo quedaba `resolved`, y no se distinguía una corrección de un cambio de
// reglas. Ahora cada resolución lleva su motivo y, cuando `merge_audit` lo
// registra, el run de escritura que cambió el valor detectado:
//
//  - fixed_by_curation: un run de Curaduría (`api:curation:*`) cambió el valor;
//  - changed_elsewhere: lo cambió otra escritura (edición, fusión, ingesta,
//    SQL sin auditoría) o cambió el contexto (fichas relacionadas, la cola);
//  - entity_removed: la ficha ya no está en el catálogo (retirada o fusionada);
//  - rules_changed: el detector ya no existe, o las reglas cambiaron de versión
//    y el detector dejó de emitirlo sobre un valor que no cambió;
//  - declared_distinct: el hallazgo era sobre un par de fichas que una persona
//    declaró distintas (`ingest.curation_distinct_pairs`, PLAN_CURADURIA E2).
//
// Lo ignorado también se resuelve cuando el detector deja de verlo (E2, A5):
// «no es un problema» caduca con el problema, con el mismo motivo.
//
// Puro sobre la foto del catálogo: scan.ts lee los candidatos y el rastro de
// `merge_audit`, y escribe el veredicto.
import { storableText } from "./analyze.js";
import type { CatalogSnapshot } from "./types.js";

export type Resolution = "fixed_by_curation" | "changed_elsewhere" | "entity_removed" | "rules_changed" | "declared_distinct";

/** Nombre de los runs que escribe Curaduría (`withOperatorRun({ name })`). */
export const CURATION_RUN_PREFIX = "api:curation:";

export interface StaleFinding {
  detector: string;
  entityKind: string;
  entityId: number | null;
  field: string | null;
  value: string | null;
  /** Versión de reglas del último análisis que lo vio; null si ese análisis ya se podó. */
  rulesVersion: string | null;
  /** Ids del par si es un hallazgo de par (duplicados). */
  pair?: [number, number] | null;
}

/** La escritura auditada que cambió el valor detectado (merge_audit con `old_value` = valor). */
export interface ValueChange {
  runId: number | null;
  /** `params.action` del run: dice si fue Curaduría. */
  action: string | null;
}

export interface ResolutionVerdict {
  resolution: Resolution;
  runId: number | null;
}

export interface CatalogState {
  /** `undefined` = la foto no sabe (revisiones y conflictos solo traen los vivos). */
  exists(kind: string, id: number): boolean | undefined;
  /** Valor actual del campo; `undefined` si la foto no lo tiene. */
  currentValue(kind: string, id: number, field: string): string | undefined;
  /** ¿Una persona declaró distinto este par? */
  isDistinctPair(kind: string, a: number, b: number): boolean;
}

export function catalogState(snapshot: CatalogSnapshot): CatalogState {
  const names: Record<string, { field: string; values: Map<number, string> }> = {
    artist: { field: "name", values: new Map(snapshot.artists.map((item) => [item.id, item.name])) },
    person: { field: "name", values: new Map(snapshot.persons.map((item) => [item.id, item.name])) },
    organization: { field: "name", values: new Map(snapshot.organizations.map((item) => [item.id, item.name])) },
    album: { field: "title", values: new Map(snapshot.albums.map((item) => [item.id, item.title])) },
    track: { field: "title", values: new Map(snapshot.tracks.map((item) => [item.id, item.title])) },
  };
  return {
    exists: (kind, id) => names[kind]?.values.has(id),
    currentValue: (kind, id, field) => (names[kind]?.field === field ? names[kind].values.get(id) : undefined),
    isDistinctPair: (kind, a, b) => snapshot.distinctPairs.has(`${kind}:${Math.min(a, b)}-${Math.max(a, b)}`),
  };
}

export function classifyResolution(
  finding: StaleFinding,
  change: ValueChange | undefined,
  state: CatalogState,
  rules: { version: string; detectors: ReadonlySet<string> },
): ResolutionVerdict {
  if (finding.entityId !== null && state.exists(finding.entityKind, finding.entityId) === false) {
    return { resolution: "entity_removed", runId: null };
  }
  if (finding.pair && state.isDistinctPair(finding.entityKind, finding.pair[0], finding.pair[1])) {
    return { resolution: "declared_distinct", runId: null };
  }
  if (change) {
    return { resolution: change.action?.startsWith(CURATION_RUN_PREFIX) ? "fixed_by_curation" : "changed_elsewhere", runId: change.runId };
  }
  if (!rules.detectors.has(finding.detector)) return { resolution: "rules_changed", runId: null };
  if (finding.rulesVersion !== null && finding.rulesVersion !== rules.version) {
    const current = finding.entityId !== null && finding.field ? state.currentValue(finding.entityKind, finding.entityId, finding.field) : undefined;
    // Sin forma de comparar (duplicados, cola, campos que la foto no trae), un
    // hallazgo que desaparece justo al cambiar las reglas se atribuye a ellas.
    const valueChanged = current !== undefined && finding.value !== null && storableText(current) !== finding.value;
    if (!valueChanged) return { resolution: "rules_changed", runId: null };
  }
  return { resolution: "changed_elsewhere", runId: null };
}
