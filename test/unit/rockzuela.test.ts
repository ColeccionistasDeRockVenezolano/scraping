import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/adapters/registry.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters", "rockzuela.json");
const adapter = adapterFor({ slug: "rockzuela", siteType: "blogspot" })!;

async function records(): Promise<RawRecord[]> {
  const body = await readFile(fixture, "utf8");
  return adapter.extractSnapshot?.({ url: "https://fixture.invalid/rockzuela", kind: "json", rawPageId: 1, body } as StoredPage) ?? [];
}

function fromFeed(entry: Record<string, unknown>): RawRecord[] {
  const body = JSON.stringify({ feed: { entry: [entry] } });
  return adapter.extractSnapshot?.({ url: "https://fixture.invalid/rockzuela", kind: "json", rawPageId: 1, body } as StoredPage) ?? [];
}

const valuesOf = (all: RawRecord[], kind: RawRecord["entityKind"], field: string): string[] =>
  all.filter((record) => record.entityKind === kind)
    .flatMap((record) => record.fields.filter((item) => item.field === field).map((item) => String(item.value)));

describe("la etiqueta de sección de Rockzuela decide qué es una publicación", () => {
  it("un post de Videos da el artista pero NO un disco", async () => {
    const all = await records();
    // "Banda Fixture - Tema Uno (En Vivo en Coro)" tiene la MISMA forma que
    // la ficha del disco; solo la etiqueta `Videos` dice que es una canción.
    expect(valuesOf(all, "album", "title")).toEqual(["Disco Fixture", "Segundo Fixture"]);
    expect(all.filter((record) => record.entityKind === "artist")).toHaveLength(3);
  });

  it("un post de Eventos con varias bandas reconoce a todas y no atribuye disco", () => {
    const all = fromFeed({
      title: { $t: "Toque en Sake Bar" },
      category: [{ term: "Eventos" }, { term: "Rock Nacional" }, { term: "Una" }, { term: "Otra" }],
      link: [{ rel: "alternate", href: "https://fixture.invalid/rockzuela/evento" }],
      content: { $t: "<div>Cartel compartido.</div>" },
    });
    expect(valuesOf(all, "artist", "name")).toEqual(["Una", "Otra"]);
    expect(all.some((record) => record.entityKind === "album")).toBe(false);
  });

  it("el disco homónimo se escribe sin repetir el nombre de la banda", async () => {
    const all = await records();
    // "Segundo Fixture - (1996)": el título del disco es el de la banda, que
    // es la convención del blog, no una inferencia sobre el paréntesis.
    const homonimo = all.find((record) => record.entityKind === "album" && record.identity.startsWith("Segundo Fixture"));
    expect(homonimo?.fields.find((item) => item.field === "title")?.value).toBe("Segundo Fixture");
    expect(homonimo?.fields.find((item) => item.field === "release_year")?.value).toBe("1996");
  });

  it("un disco sin año publicado entra igual: la etiqueta ya dijo que es una ficha", () => {
    const all = fromFeed({
      title: { $t: "Zapato Fixture - En Vivo" },
      category: [{ term: "Musica" }, { term: "Zapato Fixture" }],
      link: [{ rel: "alternate", href: "https://fixture.invalid/rockzuela/sinanio" }],
      content: { $t: "<div>Ficha.</div>" },
    });
    expect(valuesOf(all, "album", "title")).toEqual(["En Vivo"]);
    expect(valuesOf(all, "album", "release_year")).toEqual([]);
  });

  it("la etiqueta es la identidad y el título su alias, porque trae las tildes", async () => {
    const all = await records();
    expect(valuesOf(all, "artist", "name")).toContain("Banda Fíxture");
    expect(valuesOf(all, "artist", "alias")).toContain("Banda Fixture");
  });

  it("no extrae el enlace de descarga, y sí la presencia del artista", async () => {
    const all = await records();
    const every = all.flatMap((record) => record.fields.map((item) => String(item.value)));
    expect(every.some((value) => /rapidshare|mediafire/i.test(value))).toBe(false);
    expect(valuesOf(all, "artist", "web_url")).toEqual(["http://myspace.com/bandafixture"]);
  });

  it("cada claim apunta a la entrada de la que salió", async () => {
    const claims = (await records()).flatMap(normalizeRecord);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.evidence.url.startsWith("https://fixture.invalid/rockzuela/"))).toBe(true);
  });
});
