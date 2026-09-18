// CRV · Acciones de texto de Curaduría (PLAN_CURADURIA E5).
//
// Esta tabla es deliberadamente concreta: no prueba una función de reemplazo
// aislada, sino el recorrido detector → suggestedValue → acción recomendada →
// parámetros. Así evita volver a ofrecer una acción que no tiene una salida
// aplicable desde el marco de lotes.
import { describe, expect, it } from "vitest";
import { analyzeCatalog } from "../../src/curation/analyze.js";
import { applicableActions } from "../../src/curation/actions/registry.js";
import type { ActionContext, ActionFinding } from "../../src/curation/actions/types.js";
import type { CatalogSnapshot, Finding } from "../../src/curation/types.js";
import { cleanSnapshot } from "../support/curation-snapshot.js";

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function asActionFinding(finding: Finding): ActionFinding {
  return {
    id: 1,
    detector: finding.detector,
    signature: finding.signature,
    status: "open",
    entity: finding.entity,
    field: finding.field ?? null,
    value: finding.value ?? null,
    suggestedValue: finding.suggestedValue ?? null,
    related: finding.related,
    evidence: finding.evidence,
    title: finding.title,
  };
}

function find(snapshot: CatalogSnapshot, detector: string, entityId?: number): Finding {
  const finding = analyzeCatalog(snapshot).findings.find((item) => item.detector === detector
    && (entityId === undefined || item.entity.id === entityId));
  expect(finding, `debe detectar ${detector}`).toBeDefined();
  return finding!;
}

async function caseOf(input: {
  name: string;
  mutate(snapshot: CatalogSnapshot): { detector: string; id?: number };
  action: string;
  expected: string;
  level: number;
  params?: Record<string, unknown>;
}) {
  const snapshot = cleanSnapshot();
  const target = input.mutate(snapshot);
  const finding = find(snapshot, target.detector, target.id);
  expect(finding.value, input.name).toBeTruthy();
  expect(finding.suggestedValue, input.name).toBe(input.expected);
  const actions = applicableActions(asActionFinding(finding));
  expect(actions[0]?.key, input.name).toBe(input.action);
  expect(actions[0]?.levelFor(asActionFinding(finding), null), input.name).toBe(input.level);
  if (input.params) {
    expect(await actions[0]!.defaultParams(asActionFinding(finding), {} as ActionContext), input.name).toEqual(input.params);
  }
}

describe("tabla de casos reales por acción de texto (E5)", () => {
  it("calcula salida, acción y parámetros deterministas para nombres sucios", async () => {
    await caseOf({
      name: "B​.​E​.​T​.​O​.​E con U+200B",
      mutate(snapshot) {
        snapshot.artists[0]!.name = `B${ZERO_WIDTH_SPACE}.${ZERO_WIDTH_SPACE}E${ZERO_WIDTH_SPACE}.${ZERO_WIDTH_SPACE}T${ZERO_WIDTH_SPACE}.${ZERO_WIDTH_SPACE}O${ZERO_WIDTH_SPACE}.${ZERO_WIDTH_SPACE}E`;
        return { detector: "caracteres_invisibles", id: 1 };
      },
      action: "limpiar_texto", expected: "B.E.T.O.E", level: 0,
      params: { field: "name", cleanup: "invisibles" },
    });
    await caseOf({
      name: "Green &amp; blue",
      mutate(snapshot) { snapshot.artists[0]!.name = "Green &amp; blue"; return { detector: "entidades_html", id: 1 }; },
      action: "decodificar_html", expected: "Green & blue", level: 0,
      params: { field: "name", value: "Green & blue" },
    });
    await caseOf({
      name: "Donâ€™t Stop",
      mutate(snapshot) { snapshot.artists[0]!.name = "Donâ€™t Stop"; return { detector: "codificacion_rota", id: 1 }; },
      action: "reparar_codificacion", expected: "Don’t Stop", level: 1,
      params: { field: "name", value: "Don’t Stop" },
    });
    await caseOf({
      name: "manipulaciГіn",
      mutate(snapshot) { snapshot.artists[0]!.name = "manipulaciГіn"; return { detector: "codificacion_rota", id: 1 }; },
      action: "reparar_cp1251", expected: "manipulación", level: 1,
      params: { field: "name", value: "manipulación" },
    });
    await caseOf({
      name: "Вel",
      mutate(snapshot) { snapshot.artists[0]!.name = "Вel"; return { detector: "codificacion_rota", id: 1 }; },
      action: "sustituir_homoglifos", expected: "Bel", level: 1,
      params: { field: "name", value: "Bel" },
    });
    await caseOf({
      name: "Xim?na",
      mutate(snapshot) {
        snapshot.persons.push({ id: 500, name: "Ximena" }, { id: 501, name: "Xim?na" });
        snapshot.personLinks.set(500, 1); snapshot.personLinks.set(501, 1);
        return { detector: "codificacion_rota", id: 501 };
      },
      action: "restaurar_letra", expected: "Ximena", level: 1,
      params: { field: "name", value: "Ximena" },
    });
    await caseOf({
      name: "Brianne McWane)",
      mutate(snapshot) { snapshot.persons[0]!.name = "Brianne McWane)"; return { detector: "signos_sin_cerrar", id: 1 }; },
      action: "quitar_signo_huerfano", expected: "Brianne McWane", level: 1,
      params: { field: "name", value: "Brianne McWane" },
    });
    await caseOf({
      name: "Tema interpretado por \"Poster",
      mutate(snapshot) { snapshot.persons[0]!.name = "Tema interpretado por \"Poster"; return { detector: "signos_sin_cerrar", id: 1 }; },
      action: "cerrar_signo", expected: "Tema interpretado por \"Poster\"", level: 1,
      params: { field: "name", value: "Tema interpretado por \"Poster\"" },
    });
    await caseOf({
      name: "Sesión -",
      mutate(snapshot) { snapshot.artists[0]!.name = "Sesión -"; return { detector: "signos_colgantes", id: 1 }; },
      action: "recortar_extremos", expected: "Sesión", level: 0,
      params: { field: "name", value: "Sesión" },
    });
    await caseOf({
      name: "juan de la cruz",
      mutate(snapshot) { snapshot.persons[0]!.name = "juan de la cruz"; return { detector: "minusculas", id: 1 }; },
      action: "capitalizar", expected: "Juan de la Cruz", level: 1,
      params: { field: "name", value: "Juan de la Cruz" },
    });
    await caseOf({
      name: "Keloide.net",
      mutate(snapshot) { snapshot.organizations[0]!.name = "Keloide.net"; return { detector: "url_en_nombre", id: 1 }; },
      action: "dominio_a_alias", expected: "Keloide", level: 2,
      params: { field: "name", value: "Keloide", alias: "Keloide.net", aliasType: "other" },
    });
  });

  it("calcula las acciones de segmentación que solo escriben texto", async () => {
    await caseOf({
      name: "artista repetido en el título de una pista",
      mutate(snapshot) {
        const album = snapshot.albums.find((item) => item.artistId === 1)!;
        const track = snapshot.tracks.find((item) => item.albumId === album.id)!;
        track.title = "Trueno Negro - Noche QA";
        return { detector: "artista_en_titulo_de_pista", id: track.id };
      },
      action: "quitar_prefijo_artista", expected: "Noche QA", level: 1,
      params: { field: "title", value: "Noche QA" },
    });
    await caseOf({
      name: "artista repetido en el título de un disco",
      mutate(snapshot) {
        const album = snapshot.albums.find((item) => item.artistId === 1)!;
        album.title = "Trueno Negro - BlackHymn";
        return { detector: "artista_en_titulo_de_disco", id: album.id };
      },
      action: "quitar_prefijo_artista", expected: "BlackHymn", level: 1,
      params: { field: "title", value: "BlackHymn" },
    });
    await caseOf({
      name: "Banda: Misantropia",
      mutate(snapshot) { snapshot.organizations[0]!.name = "Banda: Misantropia"; return { detector: "etiqueta_en_nombre", id: 1 }; },
      action: "quitar_rotulo", expected: "Misantropia", level: 1,
      params: { field: "name", value: "Misantropia" },
    });
    await caseOf({
      name: "Sombra TruenoNegro",
      mutate(snapshot) { snapshot.artists[1]!.name = "Sombra TruenoNegro"; return { detector: "palabras_pegadas", id: 2 }; },
      action: "separar_palabras", expected: "Sombra Trueno Negro", level: 2,
      params: { field: "name", value: "Sombra Trueno Negro" },
    });
    await caseOf({
      name: "Noctambulath (Caracas)",
      mutate(snapshot) { snapshot.artists[0]!.name = "Noctambulath (Caracas)"; return { detector: "aclaracion_en_nombre_de_artista", id: 1 }; },
      action: "mover_region", expected: "Noctambulath", level: 1,
      params: { field: "name", value: "Noctambulath", region: "Caracas" },
    });
    await caseOf({
      name: "Juan Cristóbal Losada (aka Mr. Sonic)",
      mutate(snapshot) { snapshot.persons[0]!.name = "Juan Cristóbal Losada (aka Mr. Sonic)"; return { detector: "varias_personas_en_una", id: 1 }; },
      action: "renombrar_con_alias", expected: "Juan Cristóbal Losada", level: 1,
      params: { field: "name", value: "Juan Cristóbal Losada", alias: "Mr. Sonic", aliasType: "stage_name" },
    });
  });

  it("restaurar_letra expone varias opciones como nivel 2 en vez de elegirlas en un lote", async () => {
    const snapshot = cleanSnapshot();
    // «Mar?a» puede ser «María» o «Marea» en este catálogo: la acción queda
    // disponible, pero no se vuelve una autocorrección disfrazada.
    snapshot.persons.push({ id: 500, name: "María" }, { id: 501, name: "Mar?a" });
    snapshot.personLinks.set(500, 1); snapshot.personLinks.set(501, 1);
    const finding = asActionFinding(find(snapshot, "codificacion_rota", 501));
    const [action] = applicableActions(finding);
    expect(action).toMatchObject({ key: "restaurar_letra" });
    expect(action!.levelFor(finding, null)).toBe(2);
    expect(await action!.defaultParams(finding, {} as ActionContext)).toEqual({ field: "name", value: "Marea" });
    expect(finding.evidence["candidates"]).toEqual(["Marea", "María"]);
  });
});
