// CRV · Análisis incremental de Curaduría (PLAN_CURADURIA E9).
//
// Lo que sostiene la verificación dirigida: hay detectores que pueden mirar una
// ficha sola y dar el mismo resultado que mirando el catálogo entero (locales),
// y detectores que no (globales). Un análisis local no da por mirado lo global,
// así que nunca resuelve lo que no pudo ver (C1 sigue en pie). Y lo que sostiene
// la escritura por diferencia: una huella del contenido que cambia cuando
// cambia algo que se muestra, y no cuando cambia la historia del hallazgo.
import { describe, expect, it } from "vitest";
import {
  DETECTORS, GLOBAL_DETECTORS, LOCAL_DETECTORS, analyzeCatalog, contentHashOf, fingerprintOf, isLocalDetector,
} from "../../src/curation/analyze.js";
import { buildLexicon, collectNames } from "../../src/curation/lexicon.js";
import { cachedLexicon, rememberLexicon, resetLexiconCache } from "../../src/curation/lexicon-cache.js";
import { cleanSnapshot } from "../support/curation-snapshot.js";
import type { CatalogSnapshot, Finding } from "../../src/curation/types.js";

/** La vecindad de una pista, como la carga `loadFocusedSnapshot`: su disco, las pistas de ese disco y el artista. */
function neighbourhood(snapshot: CatalogSnapshot, trackId: number): CatalogSnapshot {
  const track = snapshot.tracks.find((item) => item.id === trackId)!;
  const album = snapshot.albums.find((item) => item.id === track.albumId)!;
  const artist = snapshot.artists.find((item) => item.id === album.artistId)!;
  return {
    ...snapshot,
    artists: [artist],
    persons: [],
    organizations: [],
    albums: [album],
    tracks: snapshot.tracks.filter((item) => item.albumId === album.id),
    creditRoles: [],
    personArtists: new Map(),
    personLinks: new Map(),
    organizationLinks: new Map(),
    artistLinks: new Map([[artist.id, 1]]),
    reviews: [],
    conflicts: [],
    handledPairs: new Set(),
    distinctPairs: new Set(),
  };
}

const keysOf = (findings: readonly Finding[], detector: string) => findings.filter((finding) => finding.detector === detector);

describe("detectores locales y globales (E9.1)", () => {
  it("son globales los que necesitan el catálogo entero: duplicados, cola y «Otros»", () => {
    expect(GLOBAL_DETECTORS.map((detector) => detector.key).sort()).toEqual([
      "alias_que_choca_con_otra_ficha",
      "artistas_equivalentes",
      "cola_de_revision",
      "conflictos_abiertos",
      "creditos_duplicados",
      "disco_sin_pistas",
      "discos_repetidos",
      "enlace_de_medio_a_ficha_fusionada",
      "mayusculas_sostenidas",
      "organizaciones_equivalentes",
      "periodo_de_membresia_imposible",
      "personas_equivalentes",
      "pistas_repetidas",
      "pistas_sin_duracion_en_disco_con_duraciones",
      "redireccion_en_cadena",
      "rol_contra_tipo_de_credito",
      "sello_que_es_artista",
      "tipo_de_organizacion_contra_nombre",
    ]);
    expect(LOCAL_DETECTORS.length + GLOBAL_DETECTORS.length).toBe(DETECTORS.length);
    expect(isLocalDetector("anomalia_del_catalogo")).toBe(false);
    expect(isLocalDetector("caracteres_invisibles")).toBe(true);
  });

  it("un análisis local no da por mirados los globales: sus hallazgos no se pueden resolver", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists.push({ id: 9001, name: "Los Trueno Negro", originCity: "Caracas", formedYear: 1985, disbandedYear: null });
    snapshot.artistLinks.set(9001, 1);

    const complete = analyzeCatalog(snapshot);
    expect(complete.completed).toContain("artistas_equivalentes");
    expect(complete.completed).toContain("anomalia_del_catalogo");
    expect(keysOf(complete.findings, "artistas_equivalentes").length).toBeGreaterThan(0);

    const local = analyzeCatalog(snapshot, { detectors: LOCAL_DETECTORS, anomalies: false });
    expect(local.completed).not.toContain("artistas_equivalentes");
    expect(local.completed).not.toContain("anomalia_del_catalogo");
    expect(keysOf(local.findings, "artistas_equivalentes")).toEqual([]);
    expect(local.failures).toEqual([]);
  });

  it("un detector local ve en la vecindad de una ficha lo mismo que en el catálogo entero", () => {
    const snapshot = cleanSnapshot();
    const track = snapshot.tracks[0]!;
    track.durationSeconds = 4200;
    track.title = `Trueno Negro - ${track.title}`;

    const whole = analyzeCatalog(snapshot);
    const expected = whole.findings.filter((finding) => finding.entity.kind === "track" && finding.entity.id === track.id);
    expect(expected.map((finding) => finding.detector).sort()).toEqual(["artista_en_titulo_de_pista", "duracion_atipica"]);

    // El vocabulario llega aprendido del catálogo entero: es lo que hace que un
    // trozo del catálogo se juzgue con la vara del catálogo (E9.1, E9.3).
    const lexicon = buildLexicon(snapshot, collectNames(snapshot));
    const focused = analyzeCatalog(neighbourhood(snapshot, track.id), { detectors: LOCAL_DETECTORS, lexicon, anomalies: false });
    const found = focused.findings.filter((finding) => finding.entity.kind === "track" && finding.entity.id === track.id);
    expect(found.map(fingerprintOf).sort()).toEqual(expected.map(fingerprintOf).sort());
  });

  it("sin el vocabulario del catálogo, la vecindad se juzgaría contra sí misma", () => {
    const snapshot = cleanSnapshot();
    const track = snapshot.tracks[0]!;
    track.durationSeconds = 4200;
    // Cuatro pistas no son una distribución: el detector calla en vez de inventar.
    const alone = analyzeCatalog(neighbourhood(snapshot, track.id), { detectors: LOCAL_DETECTORS, anomalies: false });
    expect(keysOf(alone.findings, "duracion_atipica")).toEqual([]);
  });
});

describe("huella del contenido para escribir solo la diferencia (E9.4)", () => {
  const base = (): Finding => ({
    detector: "caracteres_invisibles", category: "nombres_sucios", signature: "caracteres_invisibles", severity: "medium",
    entity: { kind: "artist", id: 7, label: "Trueno Negro" }, field: "name", value: "Trueno​ Negro",
    title: "Carácter invisible en el nombre", related: [], evidence: { span: [6, 7] },
  });

  it("el mismo hallazgo da la misma huella, y cualquier cambio visible la mueve", () => {
    expect(contentHashOf(base())).toBe(contentHashOf(base()));
    expect(contentHashOf(base())).toMatch(/^[0-9a-f]{32}$/u);
    for (const change of [
      { severity: "high" as const },
      { title: "Otro título" },
      { value: "Trueno Negro" },
      { suggestedValue: "Trueno Negro" },
      { evidence: { span: [0, 1] } },
      { related: [{ kind: "album" as const, id: 3, label: "Ruido" }] },
      { entity: { kind: "artist" as const, id: 7, label: "Trueno Negro (Caracas)" } },
    ]) {
      expect(contentHashOf({ ...base(), ...change })).not.toBe(contentHashOf(base()));
    }
  });

  it("no depende del orden con que el detector haya escrito la evidencia", () => {
    const uno = { ...base(), evidence: { span: [6, 7], char: "U+200B" } };
    const otro = { ...base(), evidence: { char: "U+200B", span: [6, 7] } };
    expect(contentHashOf(uno)).toBe(contentHashOf(otro));
  });
});

describe("vocabulario en caché (E9.3)", () => {
  it("guarda el último aprendido y dice si es el del catálogo de ahora o el de antes", () => {
    resetLexiconCache();
    const snapshot = cleanSnapshot();
    const lexicon = buildLexicon(snapshot, collectNames(snapshot));
    expect(cachedLexicon("firma-1")).toBeNull();

    rememberLexicon("firma-1", lexicon);
    expect(cachedLexicon("firma-1")).toMatchObject({ source: "cache" });
    // El catálogo se movió: el dirigido sigue con él, pero queda dicho que es
    // el anterior (el completo, que manda, no lo mira: reaprende siempre).
    expect(cachedLexicon("firma-2")).toMatchObject({ source: "cache_anterior" });
    expect(cachedLexicon("firma-2")!.lexicon).toBe(lexicon);
    resetLexiconCache();
    expect(cachedLexicon("firma-1")).toBeNull();
  });
});
