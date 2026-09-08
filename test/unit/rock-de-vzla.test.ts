import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/adapters/registry.js";
import { parseReleaseHead } from "../../src/adapters/shared.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters", "rock-de-vzla.json");
const adapter = adapterFor({ slug: "rock-de-vzla", siteType: "blogspot" })!;

async function records(): Promise<RawRecord[]> {
  const body = await readFile(fixture, "utf8");
  const page: StoredPage = { url: "https://fixture.invalid/rock-de-vzla", kind: "json", rawPageId: 1, body };
  return adapter.extractSnapshot?.(page) ?? [];
}

function fromFeed(entry: Record<string, unknown>): RawRecord[] {
  const page: StoredPage = { url: "https://fixture.invalid/rock-de-vzla", kind: "json", rawPageId: 1, body: JSON.stringify({ feed: { entry: [entry] } }) };
  return adapter.extractSnapshot?.(page) ?? [];
}

const valuesOf = (all: RawRecord[], kind: RawRecord["entityKind"], field: string): string[] =>
  all.filter((record) => record.entityKind === kind).flatMap((record) => record.fields.filter((item) => item.field === field).map((item) => String(item.value)));

describe("la ficha de Rock De Vzla vive fuera del texto corrido", () => {
  it("saca la banda de la etiqueta del feed, porque el título viene vacío", async () => {
    const all = await records();
    // 1.110 de las 1.113 entradas del blog no tienen título: el nombre del
    // grupo existe únicamente como `entry.category`.
    expect(valuesOf(all, "artist", "name")).toEqual(["Banda Fixture"]);
    expect(valuesOf(all, "album", "artist_name")).toEqual(["Banda Fixture", "Banda Fixture"]);
  });

  it("sin etiqueta, o con varias, no atribuye el post a nadie", () => {
    const content = { $t: '<div><span style="font-size: large;">Disco Suelto (2001)</span></div>' };
    const link = [{ rel: "alternate", href: "https://fixture.invalid/rock-de-vzla/x" }];
    expect(fromFeed({ content, link })).toEqual([]);
    expect(fromFeed({ content, link, category: [{ term: "Una" }, { term: "Otra" }] })).toEqual([]);
    expect(fromFeed({ content, link, category: [{ term: "Una" }] })).not.toEqual([]);
  });

  it("la línea de guiones corta la discografía: lo de abajo son videos, no discos", async () => {
    const all = await records();
    // Tras el separador el blog rotula CANCIONES con el mismo `large`:
    // "Tema Uno (En Vivo El Teatro Bar, 2010)" es una actuación, no una
    // publicación, y sin el corte entraba al catálogo como disco.
    expect(valuesOf(all, "album", "title")).toEqual(["Disco Fixture", "Segundo Fixture"]);
  });

  it("lee las pistas separadas solo por <br>, que no son un bloque propio", async () => {
    const all = await records();
    const titles = valuesOf(all, "track", "title");
    expect(titles).toEqual(["Tema Uno", "Tema Dos", "Tema Tres", "Tema Cuatro"]);
    // "Tema Tres" y "Tema Cuatro" comparten un solo <div>, partido por <br>.
    // Leer el bloque como una línea escondía 484 pistas del blog.
    const cuatro = all.find((record) => record.identity.endsWith("Tema Cuatro"));
    expect(cuatro?.fields.find((item) => item.field === "track_number")?.value).toBe("2");
  });

  it("la portada sale del bloque de su ficha, y los iconos sociales no son portada", async () => {
    const all = await records();
    const covers = valuesOf(all, "album", "cover_url");
    expect(covers).toHaveLength(1);
    expect(covers[0]).toContain("blogger.googleusercontent.com");
    expect(covers.some((url) => url.includes("photobucket"))).toBe(false);
    // El segundo disco no trae imagen: no se le presta la del primero.
    const segundo = all.find((record) => record.entityKind === "album" && record.identity.endsWith("Segundo Fixture"));
    expect(segundo?.fields.some((item) => item.field === "cover_url")).toBe(false);
  });

  it("no extrae enlaces de descarga, y sí la presencia del artista", async () => {
    const all = await records();
    const every = all.flatMap((record) => record.fields.map((item) => String(item.value)));
    expect(every.some((value) => /mediafire|megaupload|rapidshare/i.test(value))).toBe(false);
    expect(valuesOf(all, "artist", "web_url")).toEqual([
      "http://www.myspace.com/bandafixture",
      "http://www.facebook.com/bandafixture",
    ]);
  });

  it("la biografía termina donde empieza la discografía", async () => {
    const all = await records();
    const [biography] = valuesOf(all, "artist", "biography");
    expect(biography).toBe("Banda de rock progresivo de Barquisimeto formada en 2003, con tres discos editados y una gira por el interior del pais.");
    expect(biography).not.toMatch(/Disco Fixture|DESCARGAR/);
  });

  it("cada claim apunta a la entrada de la que salió", async () => {
    const claims = (await records()).flatMap(normalizeRecord);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.evidence.url === "https://fixture.invalid/rock-de-vzla/banda-fixture")).toBe(true);
  });
});

describe("el paréntesis de la línea de ficha", () => {
  it("separa tipo de año cuando el blog lo declara", () => {
    expect(parseReleaseHead("Hambre (Demo 2010)")).toEqual({ title: "Hambre", year: "2010", albumType: "demo" });
    expect(parseReleaseHead("We Will Judge Angels (Ep 2008)")).toMatchObject({ albumType: "ep" });
    expect(parseReleaseHead("Querido Loco (Single 2010)")).toMatchObject({ albumType: "single" });
    expect(parseReleaseHead("Concierto (En Vivo 1996)")).toMatchObject({ albumType: "live_album" });
  });

  it("un año a secas no se convierte en 'álbum de estudio'", () => {
    // 1.348 fichas del blog traen solo el año. Rellenar el tipo por defecto
    // sería afirmar algo que la fuente no dice.
    expect(parseReleaseHead("CMYK (2010)")).toEqual({ title: "CMYK", year: "2010" });
  });

  it("el soporte no es el tipo de publicación", () => {
    // "Lp" dice en qué se editó, no si es un álbum de estudio.
    expect(parseReleaseHead("Ya no estás a mi lado (Lp 1979)")).toEqual({ title: "Ya no estás a mi lado", year: "1979", format: "Lp" });
    expect(parseReleaseHead("Demos (Cassette 1988)")).toMatchObject({ format: "Cassette" });
  });

  it("lo que no reconoce lo deja sin tipo en vez de forzarlo al enum", () => {
    expect(parseReleaseHead("Primitive (Pre-Gillman San Francisco 2011)")).toEqual({ title: "Primitive", year: "2011" });
    expect(parseReleaseHead("Viva Navidad (Promocional 2008)")).toEqual({ title: "Viva Navidad", year: "2008" });
  });

  it("sin título delante o sin año no hay ficha", () => {
    // "(En Vivo El Teatro Bar, 2010)" es el pie de un video, no un disco.
    expect(parseReleaseHead("(En Vivo El Teatro Bar, 2010)")).toBeUndefined();
    expect(parseReleaseHead("Reflector")).toBeUndefined();
    expect(parseReleaseHead("Programa A Toque (Sake Bar)")).toBeUndefined();
  });
});
