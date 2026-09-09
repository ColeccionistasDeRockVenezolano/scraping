// Hippito codifica la ficha del disco en el TÍTULO de la entrada, no en el
// cuerpo. Lo que se fija aquí es la convención exacta y, sobre todo, dónde el
// adapter se niega a adivinar: paréntesis que traen una función en vez de un
// nombre. Los recopilatorios ya no se descartan — desde C3 entran bajo el
// marcador aprobado; su comportamiento propio vive en hippito-va.test.ts.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HippitoYSusChatarritasAdapter, composers, parseHippitoTitle } from "../../src/adapters/hippito.js";
import { VARIOUS_ARTISTS } from "../../src/adapters/shared.js";
import type { StoredPage } from "../../src/adapters/contracts.js";

const fixture = path.join(process.cwd(), "test/fixtures/adapters/hippito-y-sus-chatarritas.json");

async function records() {
  const page: StoredPage = {
    url: "https://hippitoysuschatarritas.blogspot.com/feeds/posts/default?alt=json",
    kind: "json", rawPageId: 1, body: await readFile(fixture, "utf8"),
  };
  return new HippitoYSusChatarritasAdapter().extractSnapshot(page);
}

describe("título discográfico de Hippito", () => {
  it("separa artista, título, sello, catálogo y año", () => {
    expect(parseHippitoTitle("Ballroom Orchestra - Dance Again (Televen LPS-99516 / Venezuela 1982)"))
      .toEqual({ artist: "Ballroom Orchestra", album: "Dance Again", label: "Televen", catalog: "LPS-99516", year: "1982" });
  });

  it("no confunde el catálogo numérico con el nombre del sello", () => {
    // "Polydor 30.353" es sello + catálogo; leerlo entero como sello creaba
    // una organización distinta por cada disco del mismo sello.
    expect(parseHippitoTitle("Pablo Manavello - Mi Fantasía (Polydor 30.353 / Venezuela 1981)"))
      .toMatchObject({ label: "Polydor", catalog: "30.353" });
    // Un sello sin código detrás se conserva íntegro.
    expect(parseHippitoTitle("VA2 - Algo (Top Hits - Balboa / Venezuela 2002)")).toMatchObject({ label: "Top Hits - Balboa" });
  });

  it("tolera las irregularidades reales del blog", () => {
    // Sin espacio antes del guion.
    expect(parseHippitoTitle("Rudy La Scala- It's Time To Dance (Polydor 30.288 / Venezuela 1979)")).toMatchObject({ artist: "Rudy La Scala", album: "It's Time To Dance" });
    // Año con separador de miles.
    expect(parseHippitoTitle("Franco De Vita - Franco De Vita (Sonográfica 40.390/ Venezuela 1.984)")).toMatchObject({ year: "1984" });
    // Paréntesis dentro del título: gana el último bloque, que es la ficha.
    expect(parseHippitoTitle("X - Dance Again (Volver a Bailar) (Televen LPS 99516 / Venezuela 1982)")).toMatchObject({ album: "Dance Again (Volver a Bailar)", catalog: "LPS 99516" });
    // Sin sello: un solo segmento, solo año.
    expect(parseHippitoTitle("OSV - El Camino de Santiago (Venezuela 2018)")).toEqual({ artist: "OSV", album: "El Camino de Santiago", year: "2018" });
  });

  it("un recopilatorio queda marcado como tal en vez de inventarle un artista", () => {
    // `albums.artist_id` es NOT NULL y un "VA" no tiene artista único. Desde
    // C3 el marcador aprobado ocupa esa columna y quien toca cada pista se
    // afirma en track_credits — ver hippito-va.test.ts.
    for (const title of ["VA - Especiales 1090 (United Artists LP-7500 / Venezuela 1969)", "V.A. - Algo (Sello / 1970)", "Various Artists - Algo (Sello / 1970)"]) {
      expect(parseHippitoTitle(title)).toMatchObject({ artist: VARIOUS_ARTISTS, various: true });
    }
    // Sin ficha entre paréntesis no se asume que el post sea discográfico.
    expect(parseHippitoTitle("La Historia Sonora del Rock - Azúcar, Cacao y Leche")).toBeUndefined();
  });
});

describe("créditos en gris de Hippito", () => {
  it("separa varios compositores de una misma pista", () => {
    expect(composers("(Bruce Sussman / Barry Manilow / Charles Albertine)").map((item) => item.name))
      .toEqual(["Bruce Sussman", "Barry Manilow", "Charles Albertine"]);
    expect(composers("(Bert Russell - Phil Medley / Francisco Belisario)").map((item) => item.name))
      .toEqual(["Bert Russell", "Phil Medley", "Francisco Belisario"]);
  });

  it("no convierte una función en una persona", () => {
    // "Arreglos y Dirección: Isaías Urbina" es rol + nombre, no un nombre.
    expect(composers("(Arreglos y Dirección: Isaías Urbina)")).toEqual([{ name: "Isaías Urbina", role: "Arreglos y Dirección" }]);
    // Si la función no trae nombre separable, se omite en vez de inventarla.
    expect(composers("(Arreglos del maestro)")).toEqual([]);
  });
});

describe("extracción de entradas reales de Hippito", () => {
  it("saca álbum, sello, pistas y créditos de una entrada de artista único", async () => {
    const all = await records();
    const kinds = new Map<string, number>();
    for (const record of all) kinds.set(record.entityKind, (kinds.get(record.entityKind) ?? 0) + 1);

    expect(all.some((r) => r.entityKind === "artist" && r.identity === "Ballroom Orchestra")).toBe(true);
    expect(all.some((r) => r.entityKind === "album" && r.identity === "Ballroom Orchestra::Dance Again")).toBe(true);
    expect(all.some((r) => r.entityKind === "organization" && r.identity === "Televen")).toBe(true);
    expect(kinds.get("track")).toBeGreaterThan(3);
    expect(kinds.get("track_credit")).toBeGreaterThan(3);

    // Toda evidencia apunta a la entrada, y el año viene del título.
    expect(all.every((r) => r.fields.every((f) => f.evidence.url.includes("hippito")))).toBe(true);
    const album = all.find((r) => r.entityKind === "album")!;
    expect(album.fields.find((f) => f.field === "release_year")?.value).toBe("1982");
    expect(album.fields.find((f) => f.field === "catalog_number")?.value).toBe("LPS-99516");
  });

  it("la entrada VA del mismo feed entra bajo el marcador, nunca bajo «VA»", async () => {
    const all = await records();
    // "VA" es la abreviatura del blog, no una entidad del catálogo.
    expect(all.some((r) => r.identity.startsWith("VA::") || r.identity === "VA")).toBe(false);
    expect(all.some((r) => r.identity === `${VARIOUS_ARTISTS}::Aquellos Años 60 & 70 Vol. 2`)).toBe(true);
  });
});
