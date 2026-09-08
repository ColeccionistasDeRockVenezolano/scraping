import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/adapters/registry.js";
import { parseRhvTitle } from "../../src/adapters/rhv-blogspot.js";
import type { RawRecord, StoredPage } from "../../src/adapters/contracts.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters", "rhv-blogspot.json");
const adapter = adapterFor({ slug: "rhv-blogspot", siteType: "blogspot" })!;

async function records(): Promise<RawRecord[]> {
  const body = await readFile(fixture, "utf8");
  return adapter.extractSnapshot?.({ url: "https://fixture.invalid/rhv-blogspot", kind: "json", rawPageId: 1, body } as StoredPage) ?? [];
}

describe("RHV Blogspot es prensa: solo el título con año es una ficha", () => {
  it("el titular sin año no produce nada", async () => {
    const all = await records();
    // "BANDA FIXTURE: Escucha su nuevo sencillo promocional" tiene la forma
    // `BANDA: algo`, pero sin año es una nota de prensa, no una publicación.
    expect(all.filter((record) => record.entityKind === "album")).toHaveLength(2);
    expect(all.every((record) => !record.identity.includes("Escucha"))).toBe(true);
  });

  it("el prefijo de la serie editorial no es la banda", async () => {
    const all = await records();
    // "Los Discos de Oro del Rock Hecho en Venezuela: SEGUNDA FIXTURE: …"
    // Sin quitar el prefijo, la banda sería el nombre de la sección. Con él,
    // se recuperan cinco clásicos de 1977-1991 del blog real.
    const names = all.filter((r) => r.entityKind === "artist").map((r) => r.identity);
    expect(names).toContain("SEGUNDA FIXTURE");
    expect(names.every((name) => !/discos de oro/i.test(name))).toBe(true);
  });

  it("las etiquetas aquí son secciones, así que no aportan artista", async () => {
    const all = await records();
    // `lanzamientos`, `reseñas`, `variedad`, `prensa`, `oro`… ninguna es una
    // banda, al revés que en Rock De Vzla o Rockzuela.
    const names = all.filter((r) => r.entityKind === "artist").map((r) => r.identity);
    expect(names).toEqual(["BANDA FIXTURE", "SEGUNDA FIXTURE"]);
  });
});

describe("el título de una ficha de RHV", () => {
  it("separa banda y disco por los dos puntos, no por el guion", () => {
    expect(parseRhvTitle("PROARESIS: Propios Y Extraños (2022)")).toEqual({ artist: "PROARESIS", album: "Propios Y Extraños", year: "2022" });
    // El primer dos puntos manda: el disco puede llevar los suyos.
    expect(parseRhvTitle("BOOGIEMAN´S CURDA: Freedom Of Repression: Prophetic Tunes (2015)"))
      .toMatchObject({ artist: "BOOGIEMAN´S CURDA", album: "Freedom Of Repression: Prophetic Tunes" });
  });

  it("acepta el guion y el entrecomillado que el blog usa al citar", () => {
    expect(parseRhvTitle("Discos de Oro del Rock Hecho en Venezuela: LA MISMA GENTE - Por Fin (1983)"))
      .toEqual({ artist: "LA MISMA GENTE", album: "Por Fin", year: "1983" });
    expect(parseRhvTitle('Discos de Oro del Rock Hecho en Venezuela: JUAN MANUEL PONCE "Del Origen A La Transición" (2016)'))
      .toEqual({ artist: "JUAN MANUEL PONCE", album: "Del Origen A La Transición", year: "2016" });
  });

  it("sin año, o sin separador, no hay ficha", () => {
    expect(parseRhvTitle("ALTO VOLTAJE: Escucha su nuevo sencillo promocional")).toBeUndefined();
    expect(parseRhvTitle("IX Edición PREMIOS MELOMANIAC")).toBeUndefined();
    // Sin separador no se adivina dónde acaba el grupo y empieza el disco.
    expect(parseRhvTitle("Los Discos de Oro del Rock Hecho en Venezuela Conozca Los Impala (1964)")).toBeUndefined();
    expect(parseRhvTitle('Discos de Oro del Rock Hecho en Venezuela: "SPITERI" (1973)')).toBeUndefined();
  });
});
