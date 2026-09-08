// A2 · Portadas. Ningún adapter extraía una sola imagen y `albums.cover_url`
// llevaba existiendo desde el principio en el merge spec. Lo que se prueba
// aquí es que la imagen que se toma es la de contenido y que cada fuente la
// clasifica por SU canal, no por una corazonada.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { contentImages } from "../../src/adapters/shared.js";
import { adapterFor } from "../../src/adapters/registry.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters");

async function records(slug: string, file: string, url: string, siteType: string): Promise<RawRecord[]> {
  const adapter = adapterFor({ slug, siteType });
  if (!adapter) throw new Error(`adapter faltante: ${slug}`);
  const page: StoredPage = { url, kind: file.endsWith(".json") ? "json" : "html", rawPageId: 1, body: await readFile(path.join(fixtureDir, file), "utf8") };
  return adapter.extractSnapshot?.(page) ?? [];
}

const valueOf = (record: RawRecord | undefined, field: string): unknown =>
  record?.fields.find((item) => item.field === field)?.value;

describe("imágenes de contenido", () => {
  const html = `
    <p><img src="../covers160/kings_1vol.jpg" width="160" alt="Los Kings - Vol. 1"></p>
    <p><img src="https://i.photobucket.com/albums/ee87/x/facebookma.png" width="40"></p>
    <p><img src="/img/icons/rss.png" width="16"></p>
    <p><img src="data:image/gif;base64,R0lGOD"></p>
    <p><img src="../covers160/kings_1vol.jpg" width="160" alt="repetida"></p>
    <p><img src="../photos5/kings_banda.jpg" width="279" alt="Los Kings"></p>`;

  it("descarta iconos sociales, adornos y data: URIs, y deduplica", () => {
    const found = contentImages(load(html), "https://fixture.invalid/rock_pop/cdinfo_rock/kings.htm");
    expect(found).toHaveLength(2);
    expect(found.map((image) => image.url)).toEqual([
      "https://fixture.invalid/rock_pop/covers160/kings_1vol.jpg",
      "https://fixture.invalid/rock_pop/photos5/kings_banda.jpg",
    ]);
  });

  it("conserva el alt, que en varias fuentes es la identidad", () => {
    const [cover] = contentImages(load(html), "https://fixture.invalid/a/b/c.htm");
    expect(cover?.alt).toBe("Los Kings - Vol. 1");
  });

  it("no confunde el id opaco de Blogger con una palabra de adorno", () => {
    // El id de contenido es base64ish y contiene "avatar", "logo" o "s0" por
    // pura coincidencia de letras: trocearlo descartaba 47 portadas buenas.
    const opaco = "https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEjeI8g3DMOFZhCDtrnZxgsxBtMApF8aaKNMmvxPb1gtw7C5d2FQz/s0/";
    expect(contentImages(load(`<img src="${opaco}">`), "https://fixture.invalid/x")).toHaveLength(1);
  });

  it("el tamaño que declara el servidor manda sobre el nombre del archivo", () => {
    // Carátula de SoundCloud rebotada a Blogger: el archivo se llama
    // "avatars-…" pero se sirve a 400px, así que es contenido.
    const cover = "https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEje/s400/avatars-000188282602-oxzvju-t500x500.jpg";
    const thumb = "https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEje/s72-c/foto.jpg";
    expect(contentImages(load(`<img src="${cover}">`), "https://fixture.invalid/x")).toHaveLength(1);
    expect(contentImages(load(`<img src="${thumb}">`), "https://fixture.invalid/x")).toHaveLength(0);
  });

  it("sin tamaño declarado sí vale el nombre del archivo", () => {
    const found = contentImages(load(`<img src="../photos5/desorden_logo_b.jpg"><img src="/img/icons/rss.png">`), "https://fixture.invalid/a/b.htm");
    expect(found).toHaveLength(0);
  });

  it("no descarta una imagen sin width declarado", () => {
    const found = contentImages(load(`<img src="/portada.jpg">`), "https://fixture.invalid/x");
    expect(found).toHaveLength(1);
    expect(found[0]?.width).toBeNull();
  });
});

describe("cada fuente clasifica por su propio canal", () => {
  it("Sincopa: la portada sale de la RUTA covers*/, y no se confunde con una foto", async () => {
    const parsed = await records("sincopa", "sincopa-album.html", "https://fixture.invalid/rock_pop/cdinfo_rock/fusion4_tarde.htm", "database");
    const album = parsed.find((record) => record.entityKind === "album");
    expect(valueOf(album, "cover_url")).toBe("https://fixture.invalid/jazz/coversbig/fusion4_tarde1.jpg");
    // una portada nunca se emite como foto de artista
    expect(parsed.some((record) => record.fields.some((f) => f.field === "picture_url"))).toBe(false);
  });

  it("Hippito: la portada es la primera imagen de la entrada del blog", async () => {
    const parsed = await records("hippito-y-sus-chatarritas", "hippito-y-sus-chatarritas.json", "https://fixture.invalid/hippito", "blogspot");
    const albums = parsed.filter((record) => record.entityKind === "album");
    expect(albums.length).toBeGreaterThan(0);
    const conPortada = albums.filter((album) => typeof valueOf(album, "cover_url") === "string");
    expect(conPortada.length).toBe(albums.length);
    expect(conPortada.length).toBeGreaterThan(0);
    expect(valueOf(conPortada[0], "cover_url")).toMatch(/^https:\/\/blogger\.googleusercontent\.com\/img\//);
  });

  it("Descargas Metal: ídem, y la portada cuelga del disco, no del artista", async () => {
    const parsed = await records("descargas-metal-venezolano", "descargas-metal-venezolano.json", "https://fixture.invalid/descargas", "blogspot");
    const album = parsed.find((record) => record.entityKind === "album");
    expect(valueOf(album, "cover_url")).toMatch(/^https:\/\/blogger\.googleusercontent\.com\/img\//);
    for (const artist of parsed.filter((record) => record.entityKind === "artist")) {
      expect(valueOf(artist, "cover_url")).toBeUndefined();
    }
  });
});
