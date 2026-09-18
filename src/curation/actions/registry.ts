// CRV · Registro de acciones de corrección de Curaduría (PLAN_CURADURIA E4.1).
//
// Una acción se ofrece sobre un hallazgo si su detector la declara para el
// subgrupo (`DetectorDefinition.actions`) Y la propia acción dice que aplica
// (`appliesTo`: p. ej. `limpiar_texto` necesita un valor sugerido). La primera
// condición es la del plan —el detector sabe qué corrige—; la segunda, la de la
// acción —sabe qué necesita—. Pedir a mano una acción no declarada solo vale si
// la acción lo acepta (`acceptsExplicit`): así la vista previa de un renombrado
// que choca puede proponer `fusionar`.
import { DETECTOR_DEFINITIONS } from "../analyze.js";
import { mergeAction } from "./merge.js";
import { STRUCTURAL_ACTIONS } from "./structural.js";
import { cleanTextAction } from "./text.js";
import { TEXTUAL_ACTIONS } from "./textual.js";
import type { ActionFinding, ActionLevel, AnyFixAction, FixActionDefinition } from "./types.js";

/** Cada acción valida sus propios parámetros con su esquema: el registro es heterogéneo a propósito. */
const erase = <P extends Record<string, unknown>>(action: FixActionDefinition<P>): AnyFixAction => action as unknown as AnyFixAction;

export const FIX_ACTIONS: readonly AnyFixAction[] = [
  erase(cleanTextAction),
  ...TEXTUAL_ACTIONS.map(erase),
  ...STRUCTURAL_ACTIONS.map(erase),
  erase(mergeAction),
];

const BY_KEY = new Map(FIX_ACTIONS.map((action) => [action.key, action]));
const DETECTORS = new Map(DETECTOR_DEFINITIONS.map((detector) => [detector.key, detector]));

export function getFixAction(key: string): AnyFixAction | undefined {
  return BY_KEY.get(key);
}

/** Claves que el detector declara para ese subgrupo (las del subgrupo y las de `*`, sin repetir). */
export function declaredActions(detector: string, signature: string): string[] {
  const actions = DETECTORS.get(detector)?.actions;
  if (!actions) return [];
  return [...new Set([...(actions[signature] ?? []), ...(actions["*"] ?? [])])];
}

/** Acciones que se ofrecen sobre el hallazgo, en el orden en que el detector las declara: la primera es la recomendada. */
export function applicableActions(finding: ActionFinding): AnyFixAction[] {
  return declaredActions(finding.detector, finding.signature)
    .map((key) => BY_KEY.get(key))
    .filter((action): action is AnyFixAction => action !== undefined && action.appliesTo(finding));
}

export interface ActionSummary {
  key: string;
  label: string;
  /** Nivel para este hallazgo con los parámetros por defecto (sin leer la base). */
  level: ActionLevel;
}

/** Lo que el listado muestra por hallazgo: síncrono, sin consultas (los parámetros exactos los da `GET …/actions`). */
export function summarizeActions(finding: ActionFinding): ActionSummary[] {
  return applicableActions(finding).map((action) => ({ key: action.key, label: action.label, level: action.levelFor(finding, null) }));
}

/** La acción que se aplica si nadie elige otra: la primera que aplica. */
export function recommendedAction(finding: ActionFinding): AnyFixAction | undefined {
  return applicableActions(finding)[0];
}
