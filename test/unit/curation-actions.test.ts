// CRV · Marco de acciones de corrección de Curaduría (PLAN_CURADURIA E4.1, E4.8):
// lo que se decide sin base de datos — qué acciones declara cada detector y
// existen, cuándo aplica `limpiar_texto` y con qué nivel, el nivel de una
// fusión, el tope de nivel por modo y el hash canónico de la vista previa.
import { describe, expect, it } from "vitest";
import { DETECTOR_DEFINITIONS } from "../../src/curation/analyze.js";
import { FIX_ACTIONS, applicableActions, declaredActions, getFixAction, summarizeActions } from "../../src/curation/actions/registry.js";
import { cleanTextAction, TEXT_CLEANUPS, type CleanTextParams } from "../../src/curation/actions/text.js";
import { mergeAction } from "../../src/curation/actions/merge.js";
import { MAX_LEVEL, itemHash, stableJson, type ItemHashInput } from "../../src/curation/actions/batches.js";
import type { ActionFinding } from "../../src/curation/actions/types.js";
import { inFocus, recommendedActionLevels } from "../../src/curation/scan.js";
import type { Finding } from "../../src/curation/types.js";

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function finding(overrides: Partial<ActionFinding> = {}): ActionFinding {
  return {
    id: 1, detector: "caracteres_invisibles", signature: "zero_width", status: "open",
    entity: { kind: "artist", id: 10, label: `Trueno${ZERO_WIDTH_SPACE} Negro` }, field: "name",
    value: `Trueno${ZERO_WIDTH_SPACE} Negro`, suggestedValue: "Trueno Negro", related: [], evidence: {}, title: "Carácter invisible",
    ...overrides,
  };
}

describe("registro de acciones (E4.1)", () => {
  it("toda acción que declara un detector existe, y toda acción registrada la declara algún detector", () => {
    const declared = new Set<string>();
    for (const detector of DETECTOR_DEFINITIONS) {
      for (const keys of Object.values(detector.actions ?? {})) {
        for (const key of keys) {
          expect(getFixAction(key), `${detector.key} declara «${key}»`).toBeDefined();
          declared.add(key);
        }
      }
    }
    expect([...declared].sort()).toEqual(FIX_ACTIONS.map((action) => action.key).sort());
    expect(new Set(FIX_ACTIONS.map((action) => action.key)).size).toBe(FIX_ACTIONS.length);
  });

  it("limpiar_texto conserva los alias E4 y E5 declara acciones semánticas por subgrupo", () => {
    for (const detector of ["caracteres_invisibles", "espacios_irregulares", "entidades_html", "signos_colgantes"]) {
      expect(declaredActions(detector, "cualquiera")).toContain("limpiar_texto");
    }
    expect(declaredActions("codificacion_rota", "mojibake")).toEqual(["reparar_codificacion", "limpiar_texto"]);
    expect(declaredActions("codificacion_rota", "mezcla_de_alfabetos")).toEqual(["reparar_cp1251", "sustituir_homoglifos"]);
    expect(declaredActions("codificacion_rota", "letra_perdida")).toEqual(["restaurar_letra"]);
    expect(declaredActions("signos_sin_cerrar", "cualquiera")).toEqual(["quitar_signo_huerfano", "cerrar_signo"]);
    expect(declaredActions("aclaracion_en_nombre_de_artista", "region")).toEqual(["mover_region"]);
    expect(declaredActions("varias_personas_en_una", "alias_en_nombre")).toEqual(["renombrar_con_alias"]);
    expect(declaredActions("palabras_pegadas", "palabras_pegadas")).toEqual(["separar_palabras"]);
    expect(declaredActions("artistas_equivalentes", "misma_clave")).toEqual(["fusionar"]);
    expect(declaredActions("detector_inexistente", "x")).toEqual([]);
  });

  it("una acción declarada solo se ofrece si ella misma aplica: sin valor sugerido no hay limpieza", () => {
    expect(applicableActions(finding()).map((action) => action.key)).toEqual(["limpiar_texto"]);
    expect(applicableActions(finding({ suggestedValue: null }))).toEqual([]);
    expect(applicableActions(finding({ suggestedValue: "  " }))).toEqual([]);
    // El campo tiene que ser el nombre o título de la propia ficha.
    expect(applicableActions(finding({ field: "origin_city" }))).toEqual([]);
    expect(applicableActions(finding({ entity: { kind: "album", id: 3, label: "Disco" }, field: "title" })).map((action) => action.key)).toEqual(["limpiar_texto"]);
    expect(applicableActions(finding({ entity: { kind: "review", id: 3, label: "Revisión" } }))).toEqual([]);
    expect(summarizeActions(finding())).toEqual([{ key: "limpiar_texto", label: cleanTextAction.label, level: 0 }]);
  });
});

describe("limpiar_texto: parámetros, niveles y encadenado (E4.8, §2.3)", () => {
  const level = (overrides: Partial<ActionFinding>, params: CleanTextParams | null = null) => cleanTextAction.levelFor(finding(overrides), params);

  it("invisibles, espacios y entidades son nivel 0; reparar la codificación, 1", () => {
    expect(level({})).toBe(0);
    expect(level({ detector: "espacios_irregulares" })).toBe(0);
    expect(level({ detector: "entidades_html" })).toBe(0);
    expect(level({ detector: "codificacion_rota", signature: "mojibake", value: "AhÃ­ QA" })).toBe(1);
  });

  it("un signo colgante es 0 si lo que se recorta es « -», «,» o «/» suelto; 1 en el resto", () => {
    const dangling = (value: string) => level({ detector: "signos_colgantes", signature: "x", value });
    expect(dangling("Sesión -")).toBe(0);
    expect(dangling(", Sesión")).toBe(0);
    expect(dangling("Sesión /")).toBe(0);
    expect(dangling("Sesión :")).toBe(1);
    expect(dangling("• Sesión")).toBe(1);
    expect(dangling("Sesión --")).toBe(1);
    expect(dangling("- Sesión -")).toBe(0);
  });

  it("un valor escrito a mano es nivel 1 y va el último en la cadena de la misma ficha", () => {
    expect(level({}, { field: "name", cleanup: "invisibles", value: "Trueno Negro" })).toBe(1);
    const chain = (params: CleanTextParams) => cleanTextAction.chain!(finding(), params);
    expect(chain({ field: "name", cleanup: "invisibles" })).toEqual({ key: "artist:10:name", rank: TEXT_CLEANUPS.indexOf("invisibles") });
    // Reparar la codificación antes que quitar invisibles: el guion blando de «ahÃ­» es parte del mojibake.
    expect(chain({ field: "name", cleanup: "mojibake" })!.rank).toBeLessThan(chain({ field: "name", cleanup: "invisibles" })!.rank);
    expect(chain({ field: "name", cleanup: "colgantes", value: "x" })!.rank).toBe(TEXT_CLEANUPS.length);
  });

  it("los parámetros por defecto son el campo y la limpieza del detector; el esquema no admite otros", async () => {
    const ctx = {} as never;
    expect(await cleanTextAction.defaultParams(finding(), ctx)).toEqual({ field: "name", cleanup: "invisibles" });
    expect(await cleanTextAction.defaultParams(finding({ detector: "codificacion_rota", signature: "letra_perdida" }), ctx)).toBeNull();
    expect(cleanTextAction.paramsSchema.safeParse({ field: "name", cleanup: "invisibles", extra: 1 }).success).toBe(false);
    expect(cleanTextAction.paramsSchema.safeParse({ field: "origin_city", cleanup: "invisibles" }).success).toBe(false);
    expect(cleanTextAction.paramsSchema.safeParse({ field: "name", cleanup: "invisibles", value: "  " }).success).toBe(false);
  });
});

describe("fusionar: nivel y propuesta explícita (E4.7)", () => {
  const pair = (overrides: Partial<ActionFinding> = {}) => finding({
    detector: "artistas_equivalentes", signature: "misma_clave", evidence: { pair: [10, 11], values: [{ id: 10, value: "Los Flanders" }, { id: 11, value: "Flanders" }] },
    ...overrides,
  });

  it("mismo nombre sin tildes ni mayúsculas es 1; sin artículo o con aclaración es 2", () => {
    expect(mergeAction.levelFor(pair(), null)).toBe(1);
    expect(mergeAction.levelFor(pair({ signature: "sin_articulo_o_espacios" }), null)).toBe(2);
    expect(mergeAction.levelFor(pair({ signature: "con_aclaracion" }), null)).toBe(2);
    // Organizaciones: la firma no lo dice, pero los dos valores tienen la misma clave.
    expect(mergeAction.levelFor(pair({
      detector: "organizaciones_equivalentes", signature: "sin_palabras_de_sello", entity: { kind: "organization", id: 10, label: "Sello" },
      evidence: { pair: [10, 11], values: [{ id: 10, value: "Sónica" }, { id: 11, value: "SONICA" }] },
    }), null)).toBe(1);
    // Propuesta explícita desde un renombrado que choca: el nombre limpio ya es idéntico.
    expect(mergeAction.levelFor(finding(), null)).toBe(1);
  });

  it("se ofrece sobre los pares de fichas repetidas y se acepta a mano solo con una de las fichas del hallazgo", () => {
    expect(mergeAction.appliesTo(pair())).toBe(true);
    expect(mergeAction.appliesTo(pair({ evidence: {} }))).toBe(false);
    expect(mergeAction.appliesTo(finding())).toBe(false);
    const accepts = mergeAction.acceptsExplicit!;
    expect(accepts(finding(), { kind: "artist", keepId: 11, dropId: 10 })).toBe(true);
    expect(accepts(finding(), { kind: "artist", keepId: 12, dropId: 13 })).toBe(false);
    expect(accepts(finding(), { kind: "person", keepId: 11, dropId: 10 })).toBe(false);
    expect(accepts(pair(), { kind: "artist", keepId: 11, dropId: 10 })).toBe(true);
    expect(accepts(pair(), { kind: "artist", keepId: 10, dropId: 12 })).toBe(false);
  });
});

describe("lotes: tope de nivel por modo y hash canónico (E4.2, §2.1.5)", () => {
  it("individual y selección llegan a nivel 2, un grupo a 1, la autocorrección a 0; el 3 nunca", () => {
    expect(MAX_LEVEL).toEqual({ individual: 2, selected: 2, group: 1, auto: 0 });
  });

  it("el JSON estable no depende del orden de las claves ni de los undefined", () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: undefined }, null], e: "ñ" })).toBe('{"a":[{"d":2},null],"b":1,"e":"ñ"}');
    expect(stableJson({ a: 1, b: { y: 2, x: 1 } })).toBe(stableJson({ b: { x: 1, y: 2 }, a: 1 }));
    expect(stableJson(undefined)).toBe("null");
  });

  it("el hash de un ítem cambia con lo que la persona vio y no con el orden de las claves", () => {
    const base: ItemHashInput = {
      findingId: 7, actionKey: "limpiar_texto", level: 0, params: { field: "name", cleanup: "invisibles" },
      before: { field: "name", value: `A${ZERO_WIDTH_SPACE}B` }, after: { field: "name", value: "AB" }, blocked: null, noop: false, material: undefined,
    };
    const hash = itemHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(itemHash({ ...base, params: { cleanup: "invisibles", field: "name" }, after: { value: "AB", field: "name" } })).toBe(hash);
    expect(itemHash({ ...base, material: null })).toBe(hash);
    expect(itemHash({ ...base, before: { field: "name", value: "A B" } })).not.toBe(hash);
    expect(itemHash({ ...base, level: 1 })).not.toBe(hash);
    expect(itemHash({ ...base, blocked: "collision" })).not.toBe(hash);
    expect(itemHash({ ...base, noop: true })).not.toBe(hash);
    expect(itemHash({ ...base, material: "hash-de-la-fusion" })).not.toBe(hash);
  });
});

describe("verificación dirigida: el foco (E4.6)", () => {
  it("un hallazgo está en el foco si su ficha o una relacionada lo están", () => {
    const focus = new Set(["artist:10", "album:3"]);
    expect(inFocus({ entity: { kind: "artist", id: 10, label: "" }, related: [] }, focus)).toBe(true);
    expect(inFocus({ entity: { kind: "track", id: 99, label: "" }, related: [{ kind: "album", id: 3, label: "" }] }, focus)).toBe(true);
    expect(inFocus({ entity: { kind: "artist", id: 11, label: "" }, related: [{ kind: "album", id: 4, label: "" }] }, focus)).toBe(false);
    expect(inFocus({ entity: { kind: "conflict", id: null, label: "" }, related: [] }, focus)).toBe(false);
  });
});

describe("cobertura de acciones en un escaneo seco (E5)", () => {
  it("cuenta la acción recomendada por nivel, también cuando no hay una segura", () => {
    const rows: Finding[] = [
      {
        detector: "entidades_html", category: "nombres_sucios", signature: "entidades_html", severity: "medium",
        entity: { kind: "artist", id: 1, label: "Green &amp; Blue" }, field: "name", value: "Green &amp; Blue",
        suggestedValue: "Green & Blue", title: "Entidad HTML", related: [], evidence: {},
      },
      {
        detector: "minusculas", category: "nombres_sucios", signature: "minusculas", severity: "low",
        entity: { kind: "person", id: 2, label: "juan de la cruz" }, field: "name", value: "juan de la cruz",
        suggestedValue: "Juan de la Cruz", title: "Nombre en minúsculas", related: [], evidence: {},
      },
      {
        detector: "url_en_nombre", category: "nombres_sucios", signature: "url_en_nombre", severity: "medium",
        entity: { kind: "organization", id: 3, label: "Keloide.net" }, field: "name", value: "Keloide.net",
        suggestedValue: "Keloide", title: "Dominio", related: [], evidence: { domain: "Keloide.net" },
      },
      {
        detector: "signos_sin_cerrar", category: "nombres_sucios", signature: "signos_sin_cerrar", severity: "medium",
        entity: { kind: "person", id: 4, label: "Texto (" }, field: "name", value: "Texto (",
        title: "Signo ambiguo", related: [], evidence: { mark: "(" },
      },
    ];
    expect(recommendedActionLevels(rows)).toEqual({
      level0: 1, level1: 1, level2: 1, manual: 1,
      byCategory: { nombres_sucios: { level0: 1, level1: 1, level2: 1, manual: 1 } },
    });
  });
});
