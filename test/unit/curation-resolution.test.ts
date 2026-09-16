// CRV · Por qué se resuelve un hallazgo (PLAN_CURADURIA E1, M1) y qué
// escrituras de la API piden un análisis completo (M11).
import { describe, expect, it } from "vitest";
import { catalogState, classifyResolution, type StaleFinding } from "../../src/curation/resolution.js";
import { isCatalogWrite } from "../../src/api/routes/curation.js";
import { cleanSnapshot } from "../support/curation-snapshot.js";

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const rules = { version: "curation-rules.v1", detectors: new Set(["caracteres_invisibles", "numeracion_con_huecos", "cola_de_revision"]) };
const state = catalogState(cleanSnapshot());

/** El artista 1 del catálogo sintético se llama hoy «Trueno Negro»; el hallazgo vio el nombre con un invisible. */
function stale(overrides: Partial<StaleFinding> = {}): StaleFinding {
  return {
    detector: "caracteres_invisibles", entityKind: "artist", entityId: 1, field: "name", value: `Trueno${ZERO_WIDTH_SPACE} Negro`,
    rulesVersion: "curation-rules.v1", ...overrides,
  };
}

describe("motivo de resolución de un hallazgo (M1)", () => {
  it("un run de Curaduría que cambió el valor detectado: corregido desde Curaduría, con su run", () => {
    expect(classifyResolution(stale(), { runId: 42, action: "api:curation:fix" }, state, rules))
      .toEqual({ resolution: "fixed_by_curation", runId: 42 });
  });

  it("otra escritura auditada: cambiado en otra parte, con su run", () => {
    expect(classifyResolution(stale(), { runId: 43, action: "api:artist:update" }, state, rules))
      .toEqual({ resolution: "changed_elsewhere", runId: 43 });
    // Un cambio auditado sin run (p. ej. el enlazador de YouTube) tampoco es de Curaduría.
    expect(classifyResolution(stale(), { runId: null, action: null }, state, rules))
      .toEqual({ resolution: "changed_elsewhere", runId: null });
  });

  it("sin rastro en merge_audit y con las mismas reglas: cambiado en otra parte, sin run", () => {
    expect(classifyResolution(stale(), undefined, state, rules)).toEqual({ resolution: "changed_elsewhere", runId: null });
  });

  it("la ficha ya no está en el catálogo: retirada, aunque antes alguien la haya editado", () => {
    expect(classifyResolution(stale({ entityId: 9_999 }), { runId: 42, action: "api:curation:fix" }, state, rules))
      .toEqual({ resolution: "entity_removed", runId: null });
  });

  it("un detector que las reglas ya no tienen: cambio de reglas", () => {
    expect(classifyResolution(stale({ detector: "detector_retirado" }), undefined, state, rules))
      .toEqual({ resolution: "rules_changed", runId: null });
  });

  it("reglas de otra versión y el valor sigue igual: cambio de reglas", () => {
    expect(classifyResolution(stale({ value: "Trueno Negro", rulesVersion: "curation-rules.v0" }), undefined, state, rules))
      .toEqual({ resolution: "rules_changed", runId: null });
    // Si la foto no permite comparar el valor, lo que desaparece al cambiar las reglas se atribuye a ellas.
    expect(classifyResolution(stale({ detector: "numeracion_con_huecos", entityKind: "album", field: "tracks", value: "Camino Viento", rulesVersion: "curation-rules.v0" }), undefined, state, rules))
      .toEqual({ resolution: "rules_changed", runId: null });
  });

  it("reglas de otra versión pero el valor cambió: no es el cambio de reglas", () => {
    expect(classifyResolution(stale({ rulesVersion: "curation-rules.v0" }), undefined, state, rules))
      .toEqual({ resolution: "changed_elsewhere", runId: null });
  });

  it("una revisión de la cola que ya no está viva no cuenta como ficha retirada", () => {
    expect(classifyResolution(stale({ detector: "cola_de_revision", entityKind: "review", entityId: 77, field: "low_confidence", value: null }), undefined, state, rules))
      .toEqual({ resolution: "changed_elsewhere", runId: null });
  });
});

describe("escrituras que piden un análisis completo (M11)", () => {
  it.each([
    ["PATCH", "/artists/12"], ["POST", "/persons"], ["DELETE", "/tracks/9"], ["POST", "/persons/3/merge"],
    ["POST", "/persons/3/convert"], ["POST", "/artists/1/aliases"], ["DELETE", "/albums/4/aliases/2"],
    ["POST", "/album-credits"], ["PATCH", "/artist-members/5"], ["DELETE", "/album-formats/8"],
    ["POST", "/review-queue/5/accept"], ["POST", "/review-queue/5/reject"], ["POST", "/review-queue/5/resolve-conflict"],
    ["POST", "/merge-runs/7/undo"],
  ])("%s %s cambia el catálogo", (method, path) => {
    expect(isCatalogWrite(method, path)).toBe(true);
  });

  it.each([
    ["PATCH", "/review-queue/5/priority"], ["POST", "/auth/login"], ["POST", "/auth/logout"],
    ["POST", "/curation/scan"], ["POST", "/curation/findings/1/ignore"], ["POST", "/curation/findings/ignore-group"],
    ["GET", "/artists/12"], ["POST", "/artistsx"],
  ])("%s %s no dispara un análisis", (method, path) => {
    expect(isCatalogWrite(method, path)).toBe(false);
  });
});
