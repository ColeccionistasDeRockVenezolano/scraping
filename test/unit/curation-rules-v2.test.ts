// CRV · Reglas de Curaduría v2 (PLAN_CURADURIA E2): los falsos positivos que
// el etiquetado del corpus encontró (A6), la clase de «Otros» (B1), el emoji
// compuesto (B2), el mojibake Windows-1252 (B3), el solista detrás del
// proyecto (B5) y la huella por pares que sobrevive a un tercer miembro (A5).
import { describe, expect, it } from "vitest";
import { analyzeCatalog, fingerprintOf, RULES_VERSION } from "../../src/curation/analyze.js";
import { repairMojibake } from "../../src/curation/detectors/text-hygiene.js";
import { buildLexicon, collectNames, signClass, signsOf } from "../../src/curation/lexicon.js";
import { catalogState, classifyResolution } from "../../src/curation/resolution.js";
import type { CatalogSnapshot, Finding } from "../../src/curation/types.js";
import { cleanSnapshot } from "../support/curation-snapshot.js";

const ZWJ = String.fromCharCode(0x200d);

function detected(snapshot: CatalogSnapshot, detector: string): Finding[] {
  return analyzeCatalog(snapshot).findings.filter((finding) => finding.detector === detector);
}

function lexiconOf(snapshot: CatalogSnapshot) {
  return buildLexicon(snapshot, collectNames(snapshot));
}

/** Añade un disco de un artista nuevo con cuatro pistas bien numeradas y devuelve su id. */
function addAlbum(snapshot: CatalogSnapshot, title: string, albumType: string, artistName = `Banda ${snapshot.artists.length + 1}`): number {
  const artistId = snapshot.artists.length + 1;
  snapshot.artists.push({ id: artistId, name: artistName, originCity: "Caracas", formedYear: 1980, disbandedYear: null });
  snapshot.artistLinks.set(artistId, 1);
  const albumId = snapshot.albums.length + 1;
  snapshot.albums.push({ id: albumId, artistId, albumType, releaseYear: 1995, title });
  return albumId;
}

describe("reglas v3: tipo de disco (A6)", () => {
  it("la versión de las reglas es la v3", () => {
    expect(RULES_VERSION).toBe("curation-rules.v3");
  });

  it("«vol» nunca se aprende como tipo aunque solo aparezca en recopilatorios", () => {
    const snapshot = cleanSnapshot();
    for (let index = 1; index <= 10; index += 1) addAlbum(snapshot, `Grandes Exitos Vol ${index}`, "compilation");
    const words = lexiconOf(snapshot).albumTypeWords;
    // Control: la palabra propia del tipo sí se aprende con los mismos discos.
    expect(words.get("exitos")).toBe("compilation");
    expect(words.has("vol")).toBe(false);
  });

  it("una palabra que la mayoría de sus discos usa sin clasificar no se aprende («rock»)", () => {
    const snapshot = cleanSnapshot();
    for (let index = 1; index <= 10; index += 1) addAlbum(snapshot, `Grandes Exitos Rock ${index}`, "compilation");
    for (let index = 1; index <= 15; index += 1) addAlbum(snapshot, `Rock ${index}`, "other");
    const words = lexiconOf(snapshot).albumTypeWords;
    expect(words.get("exitos")).toBe("compilation");
    expect(words.has("rock")).toBe(false);
  });

  it("el hallazgo dice si la palabra es semilla (corrección sin criterio) o aprendida", () => {
    const snapshot = cleanSnapshot();
    for (let index = 1; index <= 10; index += 1) addAlbum(snapshot, `Grandes Exitos ${index}`, "compilation");
    const seed = addAlbum(snapshot, "Demo 1995", "studio_album");
    const learned = addAlbum(snapshot, "Exitos De Siempre", "studio_album");
    const found = detected(snapshot, "tipo_de_disco_contra_titulo");
    expect(found.find((finding) => finding.entity.id === seed)!.evidence).toMatchObject({ words: ["demo"], wordSource: "semilla" });
    expect(found.find((finding) => finding.entity.id === learned)!.evidence).toMatchObject({ words: ["exitos"], wordSource: "aprendida" });
  });
});

describe("reglas v2: numeración (A6)", () => {
  function withTracks(numbers: Array<[disc: number, number: number]>) {
    const snapshot = cleanSnapshot();
    const album = snapshot.albums[0]!;
    const others = snapshot.tracks.filter((track) => track.albumId !== album.id);
    snapshot.tracks = [...others, ...numbers.map(([disc, number], index) => ({
      id: 10_000 + index, albumId: album.id, disc, number, durationSeconds: 200, title: `Tema Numero ${number}`,
    }))];
    return { snapshot, albumId: album.id };
  }

  it("una numeración que empieza en 2 es su propio subgrupo", () => {
    const { snapshot, albumId } = withTracks([[1, 2], [1, 3], [1, 4]]);
    const found = detected(snapshot, "numeracion_con_huecos");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ signature: "empieza_en_2", entity: { id: albumId }, title: "La numeración empieza en 2: falta la pista 1" });
  });

  it("singular y plural en el título", () => {
    expect(detected(withTracks([[1, 1], [1, 2], [1, 4]]).snapshot, "numeracion_con_huecos")[0]!.title).toBe("Falta la pista 3");
    expect(detected(withTracks([[1, 1], [1, 4]]).snapshot, "numeracion_con_huecos")[0]).toMatchObject({
      signature: "numeracion_con_huecos", title: "Faltan las pistas 2, 3",
    });
  });

  it("la numeración que sigue de un disco al siguiente no es un hueco; un salto entre discos sí", () => {
    expect(detected(withTracks([[1, 1], [1, 2], [1, 3], [2, 4], [2, 5]]).snapshot, "numeracion_con_huecos")).toEqual([]);
    const gap = detected(withTracks([[1, 1], [1, 2], [1, 3], [2, 5], [2, 6]]).snapshot, "numeracion_con_huecos");
    expect(gap).toHaveLength(1);
    expect(gap[0]!.title).toContain("del disco 2");
  });
});

describe("reglas v2: personas y organizaciones (A6, B5)", () => {
  function withWarner(): CatalogSnapshot {
    const snapshot = cleanSnapshot();
    for (const [index, name] of ["Warner Music", "Warner Chappell", "Warner Bros", "Warner Discos", "Warner Latina", "Warner Classics", "Warner Records"].entries()) {
      snapshot.organizations.push({ id: 10 + index, name, type: "label" });
      snapshot.organizationLinks.set(10 + index, 1);
    }
    return snapshot;
  }

  it("una marca aprendida al final de un nombre con forma de persona es un apellido («Dan Warner»)", () => {
    const snapshot = withWarner();
    snapshot.persons.push({ id: 500, name: "Juan Warner" }, { id: 501, name: "Discos Warner" });
    for (const id of [500, 501]) snapshot.personLinks.set(id, 1);
    expect(lexiconOf(snapshot).organizationMarkers.has("warner")).toBe(true);
    const found = detected(snapshot, "persona_es_organizacion");
    expect(found.map((finding) => finding.entity.id)).toEqual([501]);
  });

  it("una persona en minúsculas sin palabras de nombre es un fragmento, no un nombre en minúsculas", () => {
    const snapshot = cleanSnapshot();
    snapshot.persons.push({ id: 500, name: "grabado en la sala" }, { id: 501, name: "juan pérez" });
    for (const id of [500, 501]) snapshot.personLinks.set(id, 1);
    const all = analyzeCatalog(snapshot).findings;
    const of = (id: number) => all.filter((finding) => finding.entity.kind === "person" && finding.entity.id === id);
    expect(of(500).map((finding) => [finding.detector, finding.signature])).toContainEqual(["persona_no_es_un_nombre", "fragmento"]);
    expect(of(500).some((finding) => finding.detector === "minusculas")).toBe(false);
    expect(of(501).some((finding) => finding.detector === "minusculas")).toBe(true);
    expect(of(501).some((finding) => finding.detector === "persona_no_es_un_nombre")).toBe(false);
  });

  it("el alias escrito dentro del nombre es una persona con alias, no dos", () => {
    const snapshot = cleanSnapshot();
    snapshot.persons.push({ id: 500, name: "Juan Pérez (aka Mr. Sonic)" }, { id: 501, name: "Ana Díaz as \"Lohan Duff\"" });
    for (const id of [500, 501]) snapshot.personLinks.set(id, 1);
    const found = detected(snapshot, "varias_personas_en_una");
    expect(found.find((finding) => finding.entity.id === 500)).toMatchObject({ signature: "alias_en_nombre", evidence: { name: "Juan Pérez", alias: "Mr. Sonic" } });
    expect(found.find((finding) => finding.entity.id === 501)).toMatchObject({ signature: "alias_en_nombre", evidence: { name: "Ana Díaz", alias: "Lohan Duff" } });
  });

  it("persona con nombre de artista: solista si tiene forma de nombre, banda si no", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists.push({ id: 100, name: "Carlos Rivas", originCity: "Caracas", formedYear: 1980, disbandedYear: null });
    snapshot.artistLinks.set(100, 1);
    const carlos = snapshot.persons.find((person) => person.name === "Carlos Rivas")!;
    snapshot.persons.push({ id: 500, name: "Trueno Negro" });
    snapshot.personLinks.set(500, 1);
    const found = detected(snapshot, "persona_con_nombre_de_artista");
    expect(found.find((finding) => finding.entity.id === carlos.id)).toMatchObject({ signature: "solista_detras_del_proyecto", severity: "low" });
    expect(found.find((finding) => finding.entity.id === 500)).toMatchObject({ signature: "banda_como_persona", severity: "medium" });
  });
});

describe("reglas v2: forma del texto (A6, B1, B2, B3)", () => {
  it("una sola palabra en camelCase es posible estilizado; una persona que empieza por nombre de pila, no", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = "TruenoNegro";
    snapshot.artists[1]!.name = "Sombra TruenoNegro";
    snapshot.persons.push({ id: 500, name: "JuanPerez" });
    snapshot.personLinks.set(500, 1);
    const found = detected(snapshot, "palabras_pegadas");
    const signature = (kind: string, id: number) => found.find((finding) => finding.entity.kind === kind && finding.entity.id === id)?.signature;
    expect(signature("artist", 1)).toBe("posible_estilizado");
    expect(signature("artist", 2)).toBe("palabras_pegadas");
    expect(signature("person", 500)).toBe("palabras_pegadas");
  });

  it("una pieza breve («Intro») no es una duración atípica; otra pista igual de corta sí", () => {
    const snapshot = cleanSnapshot();
    snapshot.tracks[0]!.title = "Intro";
    snapshot.tracks[0]!.durationSeconds = 9;
    snapshot.tracks[1]!.durationSeconds = 9;
    const found = detected(snapshot, "duracion_atipica");
    expect(found.map((finding) => finding.entity.id)).toEqual([snapshot.tracks[1]!.id]);
  });

  it("el unidor dentro de un emoji compuesto no es un invisible; suelto entre letras, sí (B2)", () => {
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = `Trueno \u{1F468}${ZWJ}\u{1F3A4} Negro`;
    snapshot.artists[1]!.name = `Sombra${ZWJ}Eléctrico`;
    expect(detected(snapshot, "caracteres_invisibles").map((finding) => finding.entity.id)).toEqual([2]);
    expect(signsOf(`\u{1F468}${ZWJ}\u{1F3A4}`).has(ZWJ)).toBe(false);
  });

  it("«Otros» agrupa por clase Unicode (B1)", () => {
    expect(signClass("§")).toBe("puntuacion");
    expect(signClass("€")).toBe("moneda");
    expect(signClass("♫")).toBe("simbolo");
    expect(signClass("́")).toBe("invisible_o_marca");
  });

  it("repara el mojibake de Windows-1252 y propone el valor (B3)", () => {
    expect(repairMojibake("Donâ€™t Stop")).toBe("Don’t Stop");
    expect(repairMojibake("CanciÃ³n")).toBe("Canción");
    expect(repairMojibake("Canción")).toBeUndefined();
    const snapshot = cleanSnapshot();
    snapshot.artists[0]!.name = "Donâ€™t Stop";
    expect(detected(snapshot, "codificacion_rota")[0]).toMatchObject({ signature: "mojibake", suggestedValue: "Don’t Stop" });
  });
});

describe("reglas v2: duplicados por pares (A5, M3)", () => {
  function withFlanders(names: string[]): CatalogSnapshot {
    const snapshot = cleanSnapshot();
    for (const [index, name] of names.entries()) {
      snapshot.artists.push({ id: 101 + index, name, originCity: "Caracas", formedYear: 1980, disbandedYear: null });
      snapshot.artistLinks.set(101 + index, 1);
    }
    return snapshot;
  }

  it("cada par tiene huella propia: un tercer miembro o un renombrado no cambian la del par", () => {
    const [pair] = detected(withFlanders(["Los Flanders", "Flanders"]), "artistas_equivalentes");
    expect(pair).toMatchObject({ pair: [101, 102], entity: { id: 101 }, related: [{ kind: "artist", id: 102 }] });

    const three = detected(withFlanders(["Los Flanders", "Flanders", "The Flanders"]), "artistas_equivalentes");
    expect(three.map((finding) => finding.pair)).toEqual([[101, 102], [101, 103], [102, 103]]);
    expect(fingerprintOf(three[0]!)).toBe(fingerprintOf(pair!));
    expect(new Set(three.map(fingerprintOf)).size).toBe(3);

    const renamed = detected(withFlanders(["LOS FLANDERS", "Flanders"]), "artistas_equivalentes");
    expect(fingerprintOf(renamed[0]!)).toBe(fingerprintOf(pair!));
  });

  it("un par declarado distinto no vuelve y su hallazgo abierto se resuelve como tal", () => {
    const snapshot = withFlanders(["Los Flanders", "Flanders", "The Flanders"]);
    snapshot.distinctPairs.add("artist:101-102");
    snapshot.handledPairs.add("artist:101-102");
    expect(detected(snapshot, "artistas_equivalentes").map((finding) => finding.pair)).toEqual([[101, 103], [102, 103]]);
    const rules = { version: RULES_VERSION, detectors: new Set(["artistas_equivalentes"]) };
    const stale = { detector: "artistas_equivalentes", entityKind: "artist", entityId: 101, field: "name", value: "Los Flanders", rulesVersion: RULES_VERSION };
    expect(classifyResolution({ ...stale, pair: [101, 102] }, undefined, catalogState(snapshot), rules)).toEqual({ resolution: "declared_distinct", runId: null });
    // El par que nadie declaró sigue su camino normal.
    expect(classifyResolution({ ...stale, pair: [101, 103] }, undefined, catalogState(snapshot), rules).resolution).not.toBe("declared_distinct");
  });
});
