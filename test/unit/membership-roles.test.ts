import { describe, expect, it } from "vitest";
import { combineRoles, compatiblePeriods, disjointPeriods, roleKeys, sameRole } from "../../src/merge/membership-roles.js";

describe("roles de membresía", () => {
  it("reconoce el mismo rol escrito por fuentes distintas", () => {
    expect(sameRole("Guitar", "Guitars")).toBe(true);
    expect(sameRole("Lead Vocals", "Vocals (lead)")).toBe(true);
    expect(sameRole("bajo", "Bass")).toBe(true);
    expect(sameRole("Guitar & Backing Vocals", "Guitars, Vocals (backing)")).toBe(true);
    expect(sameRole("cuatro, tenor", "Tenor Vocals & First Cuatro")).toBe(true);
    expect(sameRole("Drums", "Keyboards & Sequences")).toBe(false);
  });

  it("los genéricos no aportan claves", () => {
    expect(roleKeys("Integrante").size).toBe(0);
    expect(roleKeys("Unknown").size).toBe(0);
  });

  it("une tomando el más completo y añadiendo lo que falta", () => {
    expect(combineRoles(["Guitar", "Guitars"])).toBe("Guitar");
    expect(combineRoles(["Lead Vocals", "Bass (1994), Vocals"])).toBe("Bass (1994), Vocals");
    expect(combineRoles(["integrante", "Trombone"])).toBe("Trombone");
    expect(combineRoles(["trombón", "Trombone"])).toBe("Trombone");
    expect(combineRoles(["Guitars", "guitarra acústica, guitarra eléctrica"])).toBe("guitarra acústica, guitarra eléctrica");
    expect(combineRoles(["Drums", "Keyboards & Sequences"])).toBe("Keyboards & Sequences, Drums");
    expect(combineRoles(["Integrante"])).toBe("Integrante");
  });

  it("separa etapas solo cuando los períodos no se tocan", () => {
    const period = (from_year: number | null, to_year: number | null) => ({ from_year, to_year });
    expect(compatiblePeriods(period(1976, 1981), period(1976, null))).toBe(true);
    expect(compatiblePeriods(period(null, null), period(1999, 2017))).toBe(true);
    expect(disjointPeriods(period(2008, 2009), period(2017, 2020))).toBe(true);
    expect(disjointPeriods(period(1990, 1995), period(1992, 1998))).toBe(false);
    expect(disjointPeriods(period(null, null), period(2017, 2020))).toBe(false);
  });
});
