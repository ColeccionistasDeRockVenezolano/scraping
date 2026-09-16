import { describe, expect, it } from "vitest";
import { nameWithoutNickname, personBlockingKeys, scorePersonPair, type PersonFacts } from "../../src/review/person-candidates.js";

const person = (over: Partial<PersonFacts> & { id: number; name: string }): PersonFacts => ({
  aliases: [], bandIds: [], albumIds: [], creditTypes: [], birthDate: null, deathDate: null, ...over,
});

describe("detector de candidatos de persona (E11.5)", () => {
  it("nameWithoutNickname iguala el nombre con apodo y sin él", () => {
    expect(nameWithoutNickname('Carlos "Nene" Quintero')).toBe(nameWithoutNickname("Carlos Quintero"));
    expect(nameWithoutNickname("Luis (Golding) Barrios")).toBe(nameWithoutNickname("Luis Barrios"));
  });

  it("personBlockingKeys da la clave completa y la de primer/último token", () => {
    expect(personBlockingKeys('Carlos "Nene" Quintero').sort()).toEqual(["fl:carlos|quintero", "full:carlos quintero"]);
    // Un nombre de un solo token solo bloquea por la clave completa.
    expect(personBlockingKeys("Prince")).toEqual(["full:prince"]);
  });

  it("un estudio con nombre de persona queda bloqueado, no propuesto", () => {
    const left = person({ id: 1, name: "Black Cat Studio" });
    const right = person({ id: 2, name: "Black Beans Music Studio" });
    const scored = scorePersonPair(left, right);
    expect(scored.blocked).toMatch(/organización|estudio|sello|productora/u);
    expect(scored.score).toBe(0);
  });

  it("fechas de nacimiento o muerte distintas bloquean el par", () => {
    const base = person({ id: 1, name: "Alejandro Rodríguez" });
    expect(scorePersonPair(base, person({ id: 2, name: "Alejandro Rodríguez", birthDate: "1970-01-01" })).blocked).toBeUndefined();
    expect(scorePersonPair(
      person({ id: 3, name: "Ana Díaz", birthDate: "1970-01-01" }),
      person({ id: 4, name: "Ana Díaz", birthDate: "1980-01-01" }),
    )).toMatchObject({ score: 0, blocked: "fechas de nacimiento distintas" });
    expect(scorePersonPair(
      person({ id: 5, name: "Ana Díaz", deathDate: "2001-05-05" }),
      person({ id: 6, name: "Ana Díaz", deathDate: "2010-05-05" }),
    ).blocked).toBe("fechas de muerte distintas");
  });

  it("el apodo entre comillas suma, pero el segundo nombre distinto resta", () => {
    const scored = scorePersonPair(
      person({ id: 1, name: 'Carlos "Nene" Quintero' }),
      person({ id: 2, name: "Carlos Quintero" }),
    );
    expect(scored.blocked).toBeUndefined();
    expect(scored.score).toBeGreaterThanOrEqual(0.6);
    expect(scored.features.map((feature) => feature.key)).toContain("nickname_equal");

    const middle = scorePersonPair(
      person({ id: 3, name: "Alejandro Pérez Rodríguez" }),
      person({ id: 4, name: "Alejandro Rodríguez" }),
    );
    // Comparten primer y último token, pero el segundo nombre distinto resta y
    // el par no llega al umbral fuerte (0,60).
    expect(middle.score).toBeLessThan(0.6);
    expect(middle.features.map((feature) => feature.key)).toContain("first_last_equal");
  });

  it("un alias declarado del otro lado cruza los nombres", () => {
    const scored = scorePersonPair(
      person({ id: 1, name: "Luis Golding Barrios" }),
      person({ id: 2, name: "Luis Barrios", aliases: ["Luis Golding Barrios"] }),
    );
    expect(scored.features.map((feature) => feature.key)).toContain("alias_cross");
    expect(scored.score).toBeGreaterThanOrEqual(0.45);
  });

  it("bandas y discos compartidos suman contexto", () => {
    const scored = scorePersonPair(
      person({ id: 1, name: "Pablo Martínez", bandIds: [10], albumIds: [77] }),
      person({ id: 2, name: "Pablo Martianez", bandIds: [10], albumIds: [77] }),
    );
    const keys = scored.features.map((feature) => feature.key);
    expect(keys).toContain("shared_band");
    expect(keys).toContain("shared_album");
  });
});
