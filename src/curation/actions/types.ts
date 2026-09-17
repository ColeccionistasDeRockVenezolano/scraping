// CRV · Marco de acciones de corrección de Curaduría — tipos (PLAN_CURADURIA E4).
//
// Toda corrección es una ACCIÓN TIPADA, no un texto: el detector declara qué
// acciones propone por subgrupo, y cada acción sabe calcular sus parámetros por
// defecto, comprobar sus precondiciones, mostrar el antes → después con las
// fichas que toca y sus colisiones, aplicarse dentro de un run del operador y
// cómo se deshace. Lo mismo sirve para uno, para una selección y para un grupo:
// plan → vista previa → aplicar → verificar → deshacer.
//
// Niveles (§2.1.5 del plan): 0 seguro (determinista y reversible, único
// candidato a autocorrección), 1 sugerido (se aplica con confirmación, también
// por grupo), 2 asistido (varias salidas: ficha por ficha), 3 manual.
import type { PoolClient } from "pg";
import type { z } from "zod";
import type { OperatorContext } from "../../merge/operator.js";
import type { ResolvableClaimKind } from "../../merge/specs.js";
import type { EntityRef } from "../types.js";

export type ActionLevel = 0 | 1 | 2 | 3;

/** Cómo se deshace lo que la acción escribió (src/curation/actions/batches.ts elige la pieza del motor). */
export type ActionInverse = "field_restore" | "merge_undo" | "relation_delete" | "entity_restore";

/** individual | selected | group los pide una persona; auto queda para la autocorrección (E10). */
export type FixMode = "individual" | "selected" | "group" | "auto";

/** Lo que una acción necesita saber de un hallazgo (un `FindingRow` lo cumple). */
export interface ActionFinding {
  id: number;
  detector: string;
  signature: string;
  status: "open" | "ignored" | "resolved";
  entity: EntityRef;
  field: string | null;
  value: string | null;
  suggestedValue: string | null;
  related: EntityRef[];
  evidence: Record<string, unknown>;
  title: string;
}

export interface EntityKey {
  kind: ResolvableClaimKind;
  id: number;
}

/** Otra ficha del mismo tipo con el mismo nombre (sin tildes ni mayúsculas); `exact` = idéntico. */
export interface Collision {
  kind: ResolvableClaimKind;
  id: number;
  label: string;
  exact: boolean;
}

/** En lugar de esta acción, la vista previa propone otra (p. ej. fusionar en vez de renombrar). */
export interface ActionProposal {
  actionKey: string;
  params: Record<string, unknown>;
  reason: string;
}

export type BlockedCode =
  | "not_found" | "not_open" | "stale" | "not_applicable" | "invalid" | "noop" | "empty" | "collision" | "level";

export interface Blocked {
  code: BlockedCode;
  message: string;
}

/** Una precondición comprobada contra el catálogo vivo (CAS, existencia, cero vínculos…). */
export interface Precondition {
  key: string;
  ok: boolean;
  /** Si no se cumple: con qué código queda bloqueado el ítem y por qué. */
  code?: BlockedCode;
  message?: string;
}

export interface ActionPreview {
  /** Fichas que la acción escribe: candados al aplicar y foco de la verificación dirigida. */
  touched: EntityKey[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  blocked: Blocked | null;
  /**
   * La acción no cambiaría nada. `coveredBy` = hallazgo cuyo ítem anterior en el
   * mismo lote ya deja este valor (dos limpiezas sobre el mismo nombre).
   */
  noop?: { coveredBy: number | null };
  /** Avisos: no bloquean y no entran en el hash. */
  collisions: Collision[];
  warnings: string[];
  proposal: ActionProposal | null;
  /** Hechos que entran en el hash además de antes/después (p. ej. el hash de la vista previa de una fusión). */
  hashMaterial?: unknown;
  /** Ficha y campo que la acción deja con `value`: el siguiente ítem del lote sobre lo mismo parte de ahí. */
  chain?: { key: string; value: string };
}

export interface ActionOutcome {
  after: Record<string, unknown>;
}

/** Nombres del mismo tipo para buscar colisiones antes de renombrar (se cargan una vez por vista previa). */
export interface NameLookup {
  similar(kind: ResolvableClaimKind, id: number, value: string): Promise<Collision[]>;
  /** El ítem anterior del lote renombra la ficha: las colisiones siguientes lo tienen en cuenta. */
  rename(kind: ResolvableClaimKind, id: number, value: string): void;
}

export interface ActionContext {
  /** Vista previa: transacción de solo lectura. Aplicar: la transacción del run del ítem. */
  client: PoolClient;
  mode: "preview" | "apply";
  batchMode: FixMode;
  /** Solo en la vista previa: valor que dejan los ítems anteriores del lote, por `chain.key`. */
  pending: Map<string, { value: string; findingId: number }>;
  names: NameLookup;
}

export interface FixActionDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  key: string;
  label: string;
  description: string;
  /** Nivel base; `levelFor` lo precisa por hallazgo y parámetros. */
  level: ActionLevel;
  inverse?: ActionInverse;
  paramsSchema: z.ZodType<P, z.ZodTypeDef, unknown>;
  /** ¿La ofrece el detector de este hallazgo? (síncrono: alimenta el listado). */
  appliesTo(finding: ActionFinding): boolean;
  /**
   * ¿Se puede pedir a mano sobre un hallazgo que no la ofrece? (p. ej. fusionar
   * la ficha de un nombre sucio con la que ya tiene el nombre limpio).
   */
  acceptsExplicit?(finding: ActionFinding, params: P): boolean;
  levelFor(finding: ActionFinding, params: P | null): ActionLevel;
  /** null = no aplicable a este hallazgo. */
  defaultParams(finding: ActionFinding, ctx: ActionContext): Promise<P | null>;
  /** Orden entre ítems del lote que tocan lo mismo: misma `key`, menor `rank` primero. */
  chain?(finding: ActionFinding, params: P): { key: string; rank: number } | null;
  preconditions(finding: ActionFinding, params: P, ctx: ActionContext): Promise<Precondition[]>;
  preview(finding: ActionFinding, params: P, ctx: ActionContext): Promise<ActionPreview>;
  /** Escribe por `src/merge/operator.ts` u operaciones auditadas, dentro del run del ítem. */
  apply(context: OperatorContext, finding: ActionFinding, params: P, preview: ActionPreview): Promise<ActionOutcome>;
}

/** Registro heterogéneo: cada acción valida sus propios parámetros con su esquema. */
export type AnyFixAction = FixActionDefinition<Record<string, unknown>>;
