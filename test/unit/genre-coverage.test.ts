// CRV · PLAN_GENEROS_CATALOGO_Y_RADIO_CRV etapa 1 — clasificación del
// inventario de valores de género (no decide taxonomía, solo forma).
import { describe, expect, it } from "vitest";
import { classifyGenreValue, renderGenreSourceCoverageMarkdown, type GenreSourceCoverageReport } from "../../src/curation/genre-coverage.js";

describe("classifyGenreValue", () => {
  it("reconoce un valor simple", () => {
    expect(classifyGenreValue("Rock")).toBe("simple");
    expect(classifyGenreValue("Death Metal")).toBe("simple");
  });

  it("reconoce listas por coma, barra, punto y coma o conjunción", () => {
    expect(classifyGenreValue("Rock, Pop")).toBe("list_separator");
    expect(classifyGenreValue("Heavy/Power Metal")).toBe("list_separator");
    expect(classifyGenreValue("Rock; Ska")).toBe("list_separator");
    expect(classifyGenreValue("Rock y Pop")).toBe("list_separator");
  });

  it("un compuesto con guion es un solo valor, no una lista (PLAN §Etapa 2 regla 5)", () => {
    expect(classifyGenreValue("Pop-Rock")).toBe("hyphen_compound");
    expect(classifyGenreValue("Rock-Pop")).toBe("hyphen_compound");
  });

  it("un valor con guion Y separador de lista cuenta como lista (la lista manda)", () => {
    expect(classifyGenreValue("Death-Thrash, Grindcore")).toBe("list_separator");
  });

  it("reconoce formato, contexto y adjetivo promocional como no-género (PLAN §Etapa 2 punto 3)", () => {
    expect(classifyGenreValue("Independent")).toBe("not_a_genre");
    expect(classifyGenreValue("EP")).toBe("not_a_genre");
    expect(classifyGenreValue("Live")).toBe("not_a_genre");
  });
});

describe("renderGenreSourceCoverageMarkdown", () => {
  it("produce un reporte legible con las secciones esperadas", () => {
    const report: GenreSourceCoverageReport = {
      generatedAt: "2026-09-22T00:00:00.000Z",
      bySourceAndLevel: [
        { sourceSlug: "sincopa", sourceName: "Sincopa", level: "album", totalEntities: 10, entitiesWithGenre: 5, genreClaims: 6, distinctValues: 4 },
      ],
      valueInventory: [
        { level: "album", value: "Rock", claims: 3, shape: "simple", sources: ["sincopa"] },
      ],
      albumsGenreProjection: { totalAlbums: 100, albumsWithGenre: 40, distinctGenreValues: 12 },
      multiSourceEntities: [],
      sourcesWithoutGenreEvidence: [{ sourceSlug: "rockzuela", sourceName: "Rockzuela", totalClaims: 5, distinctFields: 2 }],
    };
    const markdown = renderGenreSourceCoverageMarkdown(report);
    expect(markdown).toContain("Cobertura de géneros por fuente");
    expect(markdown).toContain("Sincopa");
    expect(markdown).toContain("Rockzuela");
    expect(markdown).toContain("Proyección `albums.genre`");
  });
});
