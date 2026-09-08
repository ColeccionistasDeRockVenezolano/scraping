import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/adapters/registry.js";
import { parseBandcampLabel, HUMANO_DERECHO } from "../../src/adapters/el-punk.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters", "el-punk-en-venezuela.json");
const adapter = adapterFor({ slug: "el-punk-en-venezuela", siteType: "wordpress" })!;

async function records(): Promise<RawRecord[]> {
  const body = await readFile(fixture, "utf8");
  return adapter.extractSnapshot?.({ url: "https://fixture.invalid/el-punk-en-venezuela", kind: "json", rawPageId: 1, body } as StoredPage) ?? [];
}

describe("del libro se extraen hechos, nunca imágenes", () => {
  it("no extrae ni una imagen: los escaneos son obra protegida", async () => {
    const all = await records();
    const images = all.flatMap((r) => r.fields).filter((f) => /cover_url|picture_url|media_url/.test(f.field));
    expect(images).toHaveLength(0);
    expect(all.flatMap((r) => r.fields).every((f) => !String(f.value).includes("scan-p123"))).toBe(true);
  });

  it("el reproductor de Bandcamp sí es estructura: disco, banda y sello", async () => {
    const all = await records();
    const album = all.find((r) => r.entityKind === "album");
    expect(album?.identity).toBe("Psh-Psh::Psh-Psh: Demo");
    expect(album?.fields.find((f) => f.field === "release_year")?.value).toBe("1983");
    expect(album?.fields.find((f) => f.field === "label")?.value).toBe(HUMANO_DERECHO);
    expect(all.some((r) => r.entityKind === "organization" && r.identity === HUMANO_DERECHO)).toBe(true);
  });

  it("un recopilatorio no tiene artista único, así que no entra", async () => {
    const all = await records();
    // "Decodifícame al chavismo by Recopilatorio": `albums.artist_id` es NOT
    // NULL e inventar una entidad para él es decisión de modelo, no de parsing.
    expect(all.every((r) => !r.identity.includes("Decodif"))).toBe(true);
    expect(all.filter((r) => r.entityKind === "album")).toHaveLength(1);
  });
});

describe("la etiqueta «Título by Artista» de Bandcamp", () => {
  it("separa disco de banda", () => {
    expect(parseBandcampLabel("Flecha by Oktavo Pasajero", "https://x/album/flecha"))
      .toEqual({ album: "Flecha", artist: "Oktavo Pasajero", url: "https://x/album/flecha" });
  });

  it("saca el año solo del paréntesis final", () => {
    expect(parseBandcampLabel("En vivo Teatro Rafael Guinand (1987) by Sentimiento Muerto", "https://x/a"))
      .toMatchObject({ album: "En vivo Teatro Rafael Guinand", year: "1987" });
    // "Demo 1985" y "86-96" son el título tal cual lo publicó el sello.
    expect(parseBandcampLabel("Demo 1985 by 4to Reich", "https://x/a")).toMatchObject({ album: "Demo 1985" });
    expect(parseBandcampLabel("86-96 by 4to Reich", "https://x/a")?.year).toBeUndefined();
  });

  it("descarta el `by` que no nombra a un grupo", () => {
    expect(parseBandcampLabel("Rajatavla, zona liberada by Recopilación", "https://x/a")).toBeUndefined();
    expect(parseBandcampLabel("Detenciones by Humano Derecho Records", "https://x/a")).toBeUndefined();
  });
});
