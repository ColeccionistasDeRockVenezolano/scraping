import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/adapters/registry.js";
import { parseHippitoTitle } from "../../src/adapters/hippito.js";
import { VARIOUS_ARTISTS } from "../../src/adapters/shared.js";
import { FIXTURE_DIR } from "../support/adapter-fixtures.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const adapter = adapterFor({ slug: "hippito-y-sus-chatarritas", siteType: "blogspot" })!;

async function records(): Promise<RawRecord[]> {
  const body = await readFile(path.join(FIXTURE_DIR, "hippito-y-sus-chatarritas.json"), "utf8");
  return adapter.extractSnapshot?.({ url: "https://fixture.invalid/hippito", kind: "json", rawPageId: 1, body } as StoredPage) ?? [];
}

const value = (record: RawRecord | undefined, field: string) => record?.fields.find((item) => item.field === field)?.value;

describe("un recopilatorio de Hippito nombra a cada banda en su pista", () => {
  it("el disco cuelga del marcador y se declara recopilatorio", async () => {
    const all = await records();
    const va = all.find((r) => r.entityKind === "album" && r.identity.startsWith(VARIOUS_ARTISTS));
    expect(value(va, "artist_name")).toBe(VARIOUS_ARTISTS);
    expect(value(va, "album_type")).toBe("compilation");
    expect(value(va, "title")).toContain("Aquellos Años 60");
  });

  it("el marcador se declara como lo que es, no como una banda", async () => {
    const all = await records();
    const marker = all.find((r) => r.entityKind === "artist" && r.identity === VARIOUS_ARTISTS);
    expect(value(marker, "artist_type")).toBe("other");
    expect(String(value(marker, "notes"))).toContain("marcador");
  });

  it("la banda de cada pista sale del título y va al crédito, no al disco", async () => {
    const all = await records();
    // "01. Los 007 - El Ultimo Beso (Last Kiss)": el grupo va delante.
    const track = all.find((r) => r.entityKind === "track" && r.identity.includes("El Ultimo Beso"));
    expect(value(track, "title")).toBe("El Ultimo Beso (Last Kiss)");
    expect(value(track, "artist_name")).toBe(VARIOUS_ARTISTS);
    expect(String(value(track, "title"))).not.toContain("Los 007");

    const credit = all.find((r) => r.entityKind === "track_credit" && String(value(r, "credited_name")) === "Los 007");
    expect(value(credit, "credit_role")).toBe("intérprete");
    expect(value(credit, "credit_scope")).toBe("track");
    // Sin esto el puente probaría `person` primero y podría engancharlo a un
    // homónimo: aquí quien toca es un grupo.
    expect(value(credit, "credited_kind")).toBe("artist");
    expect(value(credit, "track_title")).toBe("El Ultimo Beso (Last Kiss)");
  });

  it("cada banda del recopilatorio se emite como artista, o el crédito no tendría a qué engancharse", async () => {
    const all = await records();
    const names = all.filter((r) => r.entityKind === "artist").map((r) => r.identity);
    expect(names).toContain("Los 007");
    expect(names).toContain("Los Impala");
  });

  it("el compositor en gris sigue siendo compositor, no intérprete", async () => {
    const all = await records();
    // "(Bert Russell - Phil Medley / Francisco Belisario)" son autores.
    const composer = all.find((r) => r.entityKind === "track_credit" && String(value(r, "credited_name")) === "Phil Medley");
    expect(value(composer, "credit_role")).toBe("composer");
    expect(composer?.fields.some((item) => item.field === "credited_kind")).toBe(false);
    expect(all.some((r) => r.entityKind === "person" && r.identity === "Phil Medley")).toBe(true);
  });

  it("un disco normal no se toca: su artista sigue siendo su banda", async () => {
    const all = await records();
    const normal = all.find((r) => r.entityKind === "album" && r.identity.startsWith("Ballroom Orchestra"));
    expect(value(normal, "artist_name")).toBe("Ballroom Orchestra");
    expect(normal?.fields.some((item) => item.field === "album_type")).toBe(false);
    // Y su tracklist no se parte por el guion, que ahí no separa grupo.
    const track = all.find((r) => r.entityKind === "track" && r.identity.includes("Beguine"));
    expect(value(track, "title")).toBe("Beguine The Beguine");
  });
});

describe("el título de un recopilatorio", () => {
  it("normaliza el VA al marcador sin perder sello, catálogo ni año", () => {
    expect(parseHippitoTitle("VA - Top Hits Vol. 5 (Top Hits THS 1039 / Venezuela 1972)"))
      .toMatchObject({ artist: VARIOUS_ARTISTS, album: "Top Hits Vol. 5", year: "1972", label: "Top Hits", catalog: "THS 1039", various: true });
    expect(parseHippitoTitle("Various Artists - Otro (Sello / Venezuela 1980)"))
      .toMatchObject({ artist: VARIOUS_ARTISTS, various: true });
  });

  it("un disco de un solo grupo no queda marcado", () => {
    const facts = parseHippitoTitle("Ballroom Orchestra - Dance Again (Televen LPS-99516 / Venezuela 1982)");
    expect(facts?.artist).toBe("Ballroom Orchestra");
    expect(facts?.various).toBeUndefined();
  });
});
