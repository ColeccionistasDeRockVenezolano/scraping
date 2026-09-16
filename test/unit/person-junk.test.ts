import { describe, expect, it } from "vitest";
import { classifyPersonName } from "../../src/review/person-junk.js";

describe("clasificador de nombres de persona (E11.7)", () => {
  it("reconoce los casos reales del catálogo", () => {
    expect(classifyPersonName("9'44").kind).toBe("duration");
    expect(classifyPersonName("4:39").kind).toBe("duration");
    expect(classifyPersonName("(66)").kind).toBe("duration");
    expect(classifyPersonName("Beyond Music Studios").kind).toBe("organization_like");
    expect(classifyPersonName("Doblevia Records").kind).toBe("organization_like");
    expect(classifyPersonName('Tema interpretado por "Poster').kind).toBe("fragment");
  });

  it("una lista de varias personas no es «ok»", () => {
    const junk = 'Ana Valencia Pimpi Santistevan Carlos Moreán Gonzalo "Chile" Veloz';
    expect(classifyPersonName(junk).kind).toBe("multiple_people");
    expect(classifyPersonName('Carlos "Nene" Quintero Jesús "Chuo" Quintero').kind).toBe("multiple_people");
    expect(classifyPersonName("Juan Manuel De Ferrari Alejandro Londoño").kind).toBe("multiple_people");
    expect(classifyPersonName("Aldemaro Romero y Su Onda Nueva").kind).toBe("multiple_people");
  });

  it("no marca como basura los nombres reales, por largos que sean", () => {
    expect(classifyPersonName('Carlos Alberto Abuchaibe Ferreira "Cabeto"')).toEqual({ kind: "ok", reason: "" });
    expect(classifyPersonName("Carlos H. Moreán de Las Casas").kind).toBe("ok");
    expect(classifyPersonName("Asier Cazalis").kind).toBe("ok");
    expect(classifyPersonName('Miguel Gonzáles "El Enano"').kind).toBe("ok");
    // Un estudio de verdad: la clase es la correcta (organización), la
    // decisión de convertirla la toma una persona.
    expect(classifyPersonName("Mad Box's Studios").kind).toBe("organization_like");
  });

  it("un nombre vacío o muy corto es fragmento", () => {
    expect(classifyPersonName("").kind).toBe("fragment");
    expect(classifyPersonName("Ab").kind).toBe("fragment");
    expect(classifyPersonName("Part 2").kind).toBe("fragment");
  });
});
