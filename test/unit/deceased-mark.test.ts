import { describe, expect, it } from "vitest";
import { hasDeceasedMark, stripDeceasedMark } from "../../src/normalization/entity-name.js";
import { diffCoreCatalog } from "../../src/doctor/core-catalog.js";
import { artistDeceasedSql, personDeceasedSql } from "../../src/api/repositories/deceased.js";

describe("marca de fallecido en los nombres", () => {
  it("quita la cruz del nombre y avisa", () => {
    expect(stripDeceasedMark('Tirone González "Canserbero" (†)')).toEqual({ name: 'Tirone González "Canserbero"', deceased: true });
    expect(stripDeceasedMark("Elsa María Mateu †")).toEqual({ name: "Elsa María Mateu", deceased: true });
    expect(stripDeceasedMark("✝ Ana Rojas")).toEqual({ name: "Ana Rojas", deceased: true });
    expect(stripDeceasedMark("Ana [✞] Rojas")).toEqual({ name: "Ana Rojas", deceased: true });
  });

  it("no toca nombres sin cruz, ni la doble daga de las notas al pie", () => {
    expect(stripDeceasedMark("Luis Pérez (Caracas)")).toEqual({ name: "Luis Pérez (Caracas)", deceased: false });
    expect(hasDeceasedMark("Nota‡")).toBe(false);
    expect(hasDeceasedMark("Nano †")).toBe(true);
  });
});

describe("huella del core con is_deceased (0032)", () => {
  it("la columna añadida no cuenta como alteración del core", () => {
    expect(diffCoreCatalog(["COL persons.is_deceased boolean"], [])).toEqual({ missing: [], extra: [] });
    expect(diffCoreCatalog(["COL persons.otra boolean"], []).extra).toEqual(["COL persons.otra boolean"]);
  });
});

describe("fallecido en la API", () => {
  it("persona: la columna o la fecha", () => {
    expect(personDeceasedSql("p")).toBe("(COALESCE(p.is_deceased, false) OR p.death_date IS NOT NULL)");
  });

  it("artista: titular fallecido o proyecto de una sola persona fallecida, no una banda con un muerto", () => {
    const sql = artistDeceasedSql("a.id");
    expect(sql).toContain("dm.role = 'Titular del proyecto'");
    expect(sql).toContain("count(DISTINCT dm.person_id)");
    expect(sql).toContain("= 1");
  });
});
