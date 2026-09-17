import { describe, expect, it } from "vitest";
import { analyzeCatalog, DETECTOR_DEFINITIONS, DETECTORS, fingerprintOf, storableText } from "../../src/curation/analyze.js";
import { CATEGORIES, OTHER_CATEGORY, effectiveCategory } from "../../src/curation/taxonomy.js";
import type { Detector } from "../../src/curation/detectors/shared.js";
import type { CatalogSnapshot } from "../../src/curation/types.js";
import { cleanSnapshot } from "../support/curation-snapshot.js";

// Los caracteres invisibles se construyen por código para que se vean en la prueba.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function findings(snapshot: CatalogSnapshot, detectors?: readonly Detector[]) {
  return analyzeCatalog(snapshot, detectors).findings;
}

describe("detector de conflictos de Curaduría", () => {
  it("no inventa problemas en un catálogo limpio", () => {
    const result = analyzeCatalog(cleanSnapshot());
    expect(result.failures).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("toda categoría declarada por un detector existe en la taxonomía, y «Otros» siempre está", () => {
    const keys = new Set(CATEGORIES.map((category) => category.key));
    expect(keys.has(OTHER_CATEGORY)).toBe(true);
    for (const detector of DETECTOR_DEFINITIONS) expect(keys.has(detector.category), detector.key).toBe(true);
    expect(new Set(DETECTOR_DEFINITIONS.map((detector) => detector.key)).size).toBe(DETECTOR_DEFINITIONS.length);
  });

  it("marca el carácter invisible con el tramo exacto", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = `Trueno${ZERO_WIDTH_SPACE} Negro`;
    const found = findings(snapshot).filter((finding) => finding.detector === "caracteres_invisibles");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category: "nombres_sucios", entity: { kind: "artist", id: 1 }, evidence: { span: [6, 7] } });
  });

  it("detecta una persona que se llama igual que una organización del catálogo", () => {
    const snapshot = cleanSnapshot();
    snapshot.persons.push({ id: 999, name: "Estudios Sonoros" });
    snapshot.personLinks.set(999, 1);
    const found = findings(snapshot).find((finding) => finding.detector === "persona_es_organizacion");
    expect(found).toMatchObject({
      category: "ficha_de_otro_tipo", signature: "coincide_con_organizacion", severity: "high",
      entity: { kind: "person", id: 999 }, related: [{ kind: "organization", id: 1 }],
    });
  });

  it("detecta el artista del disco repetido dentro del título de la pista", () => {
    const snapshot = cleanSnapshot();
    const album = snapshot.albums[0]!;
    const artist = snapshot.artists.find((item) => item.id === album.artistId)!;
    const track = snapshot.tracks.find((item) => item.albumId === album.id)!;
    track.title = `${artist.name} - ${track.title}`;
    const found = findings(snapshot).filter((finding) => finding.detector === "artista_en_titulo_de_pista");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category: "mal_segmentados", entity: { kind: "track", id: track.id } });
    expect(found[0]!.related).toContainEqual(expect.objectContaining({ kind: "album", id: album.id }));
  });

  it("encuentra fichas sin vínculos", () => {
    const snapshot = cleanSnapshot();
    snapshot.personLinks.delete(5);
    snapshot.personArtists.delete(5);
    const found = findings(snapshot).filter((finding) => finding.detector === "fichas_sin_vinculos");
    expect(found.map((finding) => finding.entity)).toEqual([expect.objectContaining({ kind: "person", id: 5 })]);
  });

  it("un tipo de revisión que la taxonomía no conoce cae en «Otros»", () => {
    const snapshot = cleanSnapshot();
    snapshot.reviews.push({ id: 7, kind: "tipo_inventado", status: "open", priority: 50, notes: null, payload: {}, createdAt: "2026-09-16T00:00:00Z", refs: {} });
    snapshot.reviews.push({ id: 8, kind: "person_duplicate", status: "open", priority: 50, notes: null, payload: {}, createdAt: "2026-09-16T00:00:00Z", refs: {} });
    const found = findings(snapshot).filter((finding) => finding.detector === "cola_de_revision");
    // `person_duplicate` tiene su propia pestaña (Posibles duplicados).
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category: OTHER_CATEGORY, signature: "review:tipo_inventado", entity: { kind: "review", id: 7 } });
  });

  it("un detector que declara una categoría desconocida termina en «Otros» con su procedencia", () => {
    const newcomer: Detector = {
      key: "detector_nuevo", category: "categoria_que_no_existe", label: "Nuevo", description: "Prueba",
      run: () => [{
        detector: "detector_nuevo", category: "categoria_que_no_existe", signature: "detector_nuevo", severity: "low",
        entity: { kind: "artist", id: 1, label: "Trueno Negro" }, title: "Algo nuevo", related: [], evidence: {},
      }],
    };
    expect(effectiveCategory("categoria_que_no_existe")).toBe(OTHER_CATEGORY);
    const [found] = findings(cleanSnapshot(), [newcomer]);
    expect(found).toMatchObject({ category: OTHER_CATEGORY, evidence: { declaredCategory: "categoria_que_no_existe" } });
  });

  it("«Otros» recoge un valor raro que ningún detector específico explica", () => {
    const snapshot = cleanSnapshot();
    snapshot.albums[3]!.title = "Memoria § Ciudad";
    const found = findings(snapshot).filter((finding) => finding.category === OTHER_CATEGORY);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ detector: "anomalia_del_catalogo", entity: { kind: "album", id: 4 } });
    // B1: el subgrupo es la clase del signo y el campo; el carácter queda en el título.
    expect(found[0]!.signature).toBe("signo:puntuacion:album.title");
    expect(found[0]!.title).toContain("U+00A7");
  });

  it("«Otros» no repite lo que ya explica una categoría de forma", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = `Trueno${ZERO_WIDTH_SPACE} § Negro`;
    const found = findings(snapshot).filter((finding) => finding.entity.kind === "artist" && finding.entity.id === 1);
    expect(found.map((finding) => finding.category)).not.toContain(OTHER_CATEGORY);
    expect(found.map((finding) => finding.detector)).toContain("caracteres_invisibles");
  });

  it("un detector que falla no apaga a los demás", () => {
    const broken: Detector = { key: "roto", category: OTHER_CATEGORY, label: "Roto", description: "", run: () => { throw new Error("boom"); } };
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = `Trueno${ZERO_WIDTH_SPACE} Negro`;
    const result = analyzeCatalog(snapshot, [broken, ...DETECTORS]);
    expect(result.failures).toEqual([{ detector: "roto", error: "boom" }]);
    expect(result.findings.some((finding) => finding.detector === "caracteres_invisibles")).toBe(true);
  });

  it("un detector que falla no cuenta como mirado: el análisis no lo da por completo (C1)", () => {
    // «Fichas repetidas» no explica la forma de un nombre: «Otros» sí puede correr.
    const broken: Detector = { key: "roto", category: "fichas_repetidas", label: "Roto", description: "", run: () => { throw new Error("boom"); } };
    const result = analyzeCatalog(cleanSnapshot(), [broken, ...DETECTORS]);
    expect(result.completed).not.toContain("roto");
    expect(result.completed).toEqual(expect.arrayContaining([...DETECTORS.map((detector) => detector.key), "anomalia_del_catalogo"]));
  });

  it("si falla un detector de forma, «Otros» tampoco se da por mirado: mostraría lo que ese detector explica (C1)", () => {
    const brokenHygiene: Detector = {
      key: "caracteres_invisibles", category: "nombres_sucios", label: "Roto", description: "", run: () => { throw new Error("boom"); },
    };
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = `Trueno${ZERO_WIDTH_SPACE} § Negro`;
    const result = analyzeCatalog(snapshot, [brokenHygiene, ...DETECTORS.filter((detector) => detector.key !== "caracteres_invisibles")]);
    expect(result.completed).not.toContain("caracteres_invisibles");
    expect(result.completed).not.toContain("anomalia_del_catalogo");
    expect(result.failures.map((failure) => failure.detector)).toEqual(["caracteres_invisibles", "anomalia_del_catalogo"]);
    expect(result.findings.filter((finding) => finding.category === OTHER_CATEGORY)).toEqual([]);
  });

  it("una referencia numérica HTML fuera de rango no rompe el detector ni propone un valor (C2)", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = "Trueno &#xFFFFFF; Negro";
    snapshot.artists[1]!.name = "Trueno &#9999999; Eléctrico";
    snapshot.artists[2]!.name = "Trueno &#xD800; Salvaje";
    snapshot.artists[3]!.name = "Trueno &#00; Nocturno";
    const result = analyzeCatalog(snapshot);
    expect(result.failures).toEqual([]);
    const html = result.findings.filter((finding) => finding.detector === "entidades_html");
    expect(html.map((finding) => finding.entity.id).sort()).toEqual([1, 2, 3, 4]);
    for (const finding of html) expect(finding.suggestedValue).toBeUndefined();
  });

  it("decodifica con la tabla HTML5 y solo propone un valor que cambia algo (C2)", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = "Trueno &amp; Negro";
    snapshot.albums[0]!.title = "Canci&oacute;n &hellip;";
    snapshot.persons[0]!.name = "&Aacute;ngel P&#233;rez";
    snapshot.tracks[0]!.title = "Noche &#150; Calle";
    snapshot.organizations[0]!.name = "Rock&roll; Estudios";
    const html = new Map(analyzeCatalog(snapshot).findings
      .filter((finding) => finding.detector === "entidades_html")
      .map((finding) => [`${finding.entity.kind}:${finding.entity.id}`, finding.suggestedValue]));
    expect(html.get("artist:1")).toBe("Trueno & Negro");
    expect(html.get("album:1")).toBe("Canción …");
    expect(html.get("person:1")).toBe("Ángel Pérez");
    // Las referencias 128–159 son Windows-1252 según HTML5: 150 es la raya corta.
    expect(html.get("track:1")).toBe("Noche – Calle");
    // «&roll;» no es una entidad: no hay nada que decodificar ni que reportar.
    expect(html.has("organization:1")).toBe(false);
  });

  it("la huella de un hallazgo es estable entre análisis y cambia si cambia el valor", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = `Trueno${ZERO_WIDTH_SPACE} Negro`;
    const first = findings(snapshot).find((finding) => finding.detector === "caracteres_invisibles")!;
    const again = findings(snapshot).find((finding) => finding.detector === "caracteres_invisibles")!;
    expect(fingerprintOf(again)).toBe(fingerprintOf(first));
    expect(fingerprintOf({ ...first, related: [...first.related].reverse() })).toBe(fingerprintOf(first));

    snapshot.artists[0]!.name = `Trueno Negro${ZERO_WIDTH_SPACE}`;
    const changed = findings(snapshot).find((finding) => finding.detector === "caracteres_invisibles")!;
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(first));
  });

  it("guarda texto que PostgreSQL acepta", () => {
    const nul = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd800);
    expect(storableText(`a${nul}b${loneSurrogate}c`)).toBe(`ab${String.fromCharCode(0xfffd)}c`);
  });
});
