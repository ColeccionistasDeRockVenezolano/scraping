import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/adapters/registry.js";
import { parseArtAlt } from "../../src/adapters/crv-wordpress.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters", "coleccionistas-de-rock-venezolano.html");
const adapter = adapterFor({ slug: "coleccionistas-de-rock-venezolano", siteType: "wordpress" })!;

async function records(): Promise<RawRecord[]> {
  const body = await readFile(fixture, "utf8");
  return adapter.extractSnapshot?.({ url: "https://fixture.invalid/crv/banda", kind: "html", rawPageId: 1, body } as StoredPage) ?? [];
}

const field = (record: RawRecord | undefined, name: string) =>
  record?.fields.find((item) => item.field === name)?.value;

describe("las artes de CRV WordPress viven en el alt, no en el texto", () => {
  it("la portada va a la columna del core y el resto a media_links", async () => {
    const all = await records();
    const album = all.find((r) => r.entityKind === "album" && r.identity.endsWith("Disco Fixture"));
    // `albums.cover_url` es UNA imagen: la portada es la canónica.
    expect(String(field(album, "cover_url"))).toContain("portada.jpg");
    expect(field(album, "release_year")).toBe("1995");

    // Contraportada, galleta y libreto no compiten por esa columna.
    const links = all.filter((r) => r.entityKind === "media_link");
    const urls = links.map((r) => String(field(r, "media_url")));
    expect(urls.some((u) => u.includes("contra.jpg"))).toBe(true);
    expect(urls.some((u) => u.includes("cd.jpg"))).toBe(true);
    expect(urls.some((u) => u.includes("interna1.jpg"))).toBe(true);
    // La portada NO se duplica en media_links: sería la misma afirmación dos veces.
    expect(urls.some((u) => u.includes("portada.jpg"))).toBe(false);
    expect(links.every((r) => ["scan", "artist_photo"].includes(String(field(r, "media_type"))))).toBe(true);
  });

  it("un arte sin disco nombrado cuelga de la banda, no le inventa una publicación", async () => {
    const all = await records();
    const banda = all.find((r) => r.entityKind === "media_link" && String(field(r, "media_url")).includes("banda.jpg"));
    expect(field(banda, "media_target")).toBe("artist");
    expect(field(banda, "media_type")).toBe("artist_photo");
    expect(banda?.fields.some((item) => item.field === "album_title")).toBe(false);
  });

  it("un alt que es el nombre de archivo de Facebook no es el título de un disco", async () => {
    const all = await records();
    const titles = all.filter((r) => r.entityKind === "album").map((r) => String(field(r, "title")));
    expect(titles.every((title) => !/\d{5,}/.test(title))).toBe(true);
    // El arte no se pierde: se cuelga de la banda.
    const fb = all.find((r) => r.entityKind === "media_link" && String(field(r, "media_url")).includes("fb.jpg"));
    expect(field(fb, "media_target")).toBe("artist");
  });

  it("los avatares de quien comenta no son artes", async () => {
    const all = await records();
    expect(all.flatMap((r) => r.fields).every((item) => !String(item.value).includes("gravatar"))).toBe(true);
  });

  it("solo se lee el cuerpo de la entrada, no la plantilla", async () => {
    const all = await records();
    expect(all.flatMap((r) => r.fields).every((item) => !String(item.value).includes("plantilla.jpg"))).toBe(true);
  });
});

describe("el alt de una imagen de CRV WordPress", () => {
  it("recorta la banda del principio y el tipo del final", () => {
    expect(parseArtAlt("Billy Se Fue Todo No Es Suficiente Cd", "Billy Se Fue"))
      .toEqual({ album: "Todo No Es Suficiente", mediaType: "scan" });
    expect(parseArtAlt("Billy Se Fue Todo No Es Suficiente Portada", "Billy Se Fue"))
      .toEqual({ album: "Todo No Es Suficiente", mediaType: "cover" });
  });

  it("el tipo también va delante y la banda detrás", () => {
    // "Contraportada Parte Interna Misión Fantasma La Puta Eléctrica"
    expect(parseArtAlt("Contraportada Parte Interna Mision Fantasma La Puta Electrica", "La Puta Electrica"))
      .toMatchObject({ album: "Mision Fantasma", mediaType: "scan" });
  });

  it("reconoce el tipo aunque el alt venga cortado", () => {
    // El archivo real trae "Contraportada Pa" y "Parte Interna Digip".
    expect(parseArtAlt("Blush Magenta Caras Flashes Contraportada Pa", "Blush Magenta"))
      .toMatchObject({ album: "Caras Flashes", mediaType: "scan" });
  });

  it("el índice de página no es parte del título, vaya delante o detrás", () => {
    expect(parseArtAlt("La Nave 1 Astro", "La Nave")).toMatchObject({ album: "Astro", ordinal: 1 });
    expect(parseArtAlt("La Nave Astro Parte Interna 3", "La Nave")).toMatchObject({ album: "Astro", ordinal: 3 });
  });

  it("el año que encabeza el alt es el de edición", () => {
    expect(parseArtAlt("1995 Dermis Tatu La Violo La Mato y La Pico", "Dermis Tatu"))
      .toMatchObject({ album: "La Violo La Mato y La Pico", year: "1995" });
  });

  it("sin título plausible no se afirma ningún disco", () => {
    expect(parseArtAlt("417659_293684330760172_532462359_n", "La Calle")?.album).toBeUndefined();
    expect(parseArtAlt("Pacifica Portada", "Pacifica")?.album).toBeUndefined();
  });

  it("conserva las tildes del alt original, que el emparejado ignora", () => {
    expect(parseArtAlt("Culto Oculto Flotar No Es Más Que Existir Contraportada", "Culto Oculto"))
      .toMatchObject({ album: "Flotar No Es Más Que Existir" });
  });
});
