// CRV · Fusionar sin perder datos: uniones, notas y validación de la IA (2026-10-01).
import { describe, expect, it } from "vitest";
import { containsText, dedupeSources, joinTexts, lostValuesLine } from "../../src/merge/preserve.js";
import { rewriteProblems } from "../../src/merge/text-rewrite.js";

describe("preserve: uniones de texto", () => {
  it("une dos textos distintos en párrafos y no repite uno contenido en otro", () => {
    expect(joinTexts("Banda de Maracaibo.", "Gira por Europa.")).toBe("Banda de Maracaibo.\n\nGira por Europa.");
    expect(joinTexts("Banda de Maracaibo formada en 1958.", "banda de  maracaibo")).toBe("Banda de Maracaibo formada en 1958.");
    expect(joinTexts("corta", "Una versión más larga y corta del texto")).toBe("Una versión más larga y corta del texto");
    expect(containsText("A  b\nC", "a b c")).toBe(true);
  });

  it("deja las fuentes distintas y quita las contenidas en otra", () => {
    const sources = dedupeSources([
      { label: "A", text: "uno dos" },
      { label: "B", text: "uno dos tres" },
      { label: "C", text: "otra cosa" },
      { label: "D", text: "  " },
    ]);
    expect(sources).toEqual([{ label: "B", text: "uno dos tres" }, { label: "C", text: "otra cosa" }]);
  });

  it("anota en una línea lo que quedó fuera", () => {
    const line = lostValuesLine("Los Impalas", 2117, [{ label: "Desde", value: 1959 }, { label: "Ciudad", value: "Lara" }, { label: "Fallecido/a", value: true }],
      new Date("2026-10-01T12:00:00Z"));
    expect(line).toBe("Al fusionar «Los Impalas» (#2117, 2026-10-01) quedó fuera — Desde: 1959; Ciudad: «Lara»; Fallecido/a: sí.");
  });
});

describe("text-rewrite: validación del texto de la IA", () => {
  const input = {
    kind: "artist" as const, name: "Los Impala",
    sources: [
      { label: "Los Impala", text: "Banda de Maracaibo formada en 1958. Grabó Taxi en 1967 y se disolvió en 1970 tras un concierto en Caracas." },
      { label: "Los Impalas", text: "Agrupación surgida en 1959 que giró por Europa con The Hollies." },
    ],
  };
  const good = "Los Impala es una banda de Maracaibo formada en 1958 (otras fuentes dicen 1959). Giró por Europa con The Hollies, grabó Taxi en 1967 y se disolvió en 1970 tras un concierto en Caracas.";

  it("acepta un texto que une sin inventar", () => {
    expect(rewriteProblems(input, good)).toEqual([]);
  });

  it("rechaza años inventados, años perdidos, formato y resúmenes", () => {
    expect(rewriteProblems(input, good.replace("1967", "1968")).join(" ")).toMatch(/1968.*1967|1967.*1968/u);
    expect(rewriteProblems(input, `**${good}**`).join(" ")).toMatch(/Markdown/u);
    expect(rewriteProblems(input, "Banda de Maracaibo de 1958, 1959, 1967 y 1970.").join(" ")).toMatch(/más corto/u);
    expect(rewriteProblems(input, `${good} Según las fuentes, fue pionera.`).join(" ")).toMatch(/fuentes/u);
  });
});

describe("text-rewrite: «fusión» y «el material» como palabras del relato", () => {
  it("no confunde el género «fusión latina» ni «el material original» con hablar de la fusión", () => {
    const input = { kind: "album" as const, name: "Disco", sources: [{ label: "A", text: "Disco de pop." }, { label: "B", text: "Con fusión latina." }] };
    expect(rewriteProblems(input, "Disco de pop con humor y fusión latina; reúne el material original del álbum.")).toEqual([]);
    expect(rewriteProblems(input, "Disco de pop con fusión latina. El nombre de la ficha es otro.").join(" ")).toMatch(/fichas/u);
  });
});
