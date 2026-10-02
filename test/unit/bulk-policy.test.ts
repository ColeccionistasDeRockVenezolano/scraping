import { describe, expect, it } from "vitest";
import { decideVerdict, editDistanceWithin, nearness, type DecisionEvidence } from "../../src/review/bulk-policy.js";

const review = (...candidates: Array<{ id: number; name: string; parentId?: number }>): DecisionEvidence => ({
  action: "REVIEW", score: 0.52, candidates: candidates.map((c) => ({ ...c, score: 0.5 })),
});
const noMatch: DecisionEvidence = { action: "NO_MATCH", score: 0, candidates: [] };

describe("nearness", () => {
  it("reconoce tildes, errata, orden y nombre contenido", () => {
    expect(nearness("Víctor Cuica", "Victor Cuica", 1)).toBe("exacto");
    expect(nearness("Juan Munguía", "Juan Mungia", 2)).toBe("errata");
    expect(nearness("Pérez, Juan", "Juan Pérez", 2)).toBe("reordenado");
    expect(nearness("Cuica Víctor Hugo", "Víctor Hugo Cuica", 2)).toBe("reordenado");
    expect(nearness("Virgilio Araque Reyes", "Virgilio Araque", 2)).toBe("contenido");
    expect(nearness("Orquesta Sinfónica Venezuela", "Orquesta Sinfónica de Venezuela", 1)).toBe("exacto");
  });

  it("no confunde nombres distintos del mismo nombre de pila", () => {
    expect(nearness("Carlos Duarte", "Carlos Baute", 1)).toBeUndefined();
    expect(nearness("Alfredo Naranjo", "Alfredo Mena", 2)).toBeUndefined();
    expect(nearness("Pedro Speck", "Pedro Misle", 2)).toBeUndefined();
  });

  it("una sola palabra contenida no basta para personas pero sí para bandas", () => {
    expect(nearness("Frank Haslam", "Frank", 2)).toBeUndefined();
    expect(nearness("Impromptu Trio", "Impromptu", 1)).toBe("contenido");
  });

  it("la distancia de edición corta al pasar el límite", () => {
    expect(editDistanceWithin("kitten", "sitting", 3)).toBe(3);
    expect(editDistanceWithin("abcdef", "uvwxyz", 2)).toBeGreaterThan(2);
  });
});

describe("decideVerdict", () => {
  it("sin decisión de ER no se afirma nada", () => {
    expect(decideVerdict({ kind: "person", name: "Ana", decision: undefined, sameName: [] }).kind).toBe("hold");
  });

  it("AUTO_MATCH pasa por el merge normal", () => {
    const decision: DecisionEvidence = { action: "AUTO_MATCH", score: 1, candidates: [] };
    expect(decideVerdict({ kind: "person", name: "José Castro", decision, sameName: [{ id: 4334, name: "José Castro" }] })).toEqual({ kind: "approve", rule: "auto-match" });
  });

  it("una persona sin coincidencia se crea", () => {
    expect(decideVerdict({ kind: "person", name: "Iker Nuevo", decision: noMatch, sameName: [] })).toEqual({ kind: "different", rule: "sin-coincidencia" });
  });

  it("un homónimo exacto sin proyecto común se crea y se marca, no se fusiona", () => {
    const verdict = decideVerdict({
      kind: "person", name: "Leonardo Blanco",
      decision: { action: "POSSIBLE_MATCH", score: 0.74, candidates: [{ id: 12713, name: "Leonardo Blanco", score: 0.74 }] },
      sameName: [{ id: 12713, name: "Leonardo Blanco" }],
    });
    expect(verdict).toMatchObject({ kind: "different", rule: "homonimo-sin-proyecto-comun", flag: { reason: "homonimo-exacto", otherIds: [12713] } });
  });

  it("una persona de nombre parecido se crea y se marca", () => {
    const verdict = decideVerdict({ kind: "person", name: "Juan Munguía", decision: review({ id: 1, name: "Juan Mungia" }), sameName: [] });
    expect(verdict).toMatchObject({ kind: "different", flag: { reason: "nombre-parecido", otherIds: [1] } });
  });

  it("una persona con candidatas débiles se crea sin marca", () => {
    const verdict = decideVerdict({ kind: "person", name: "Pedro Speck", decision: review({ id: 1, name: "Pedro Misle" }, { id: 2, name: "Pedro Pérez" }), sameName: [] });
    expect(verdict).toEqual({ kind: "different", rule: "solo-coincidencias-debiles" });
  });

  it("un artista casi igual a otro del core queda abierto; uno distinto se crea", () => {
    expect(decideVerdict({ kind: "artist", name: "Impromptu Trio", decision: review({ id: 3057, name: "Impromptu" }), sameName: [] }).kind).toBe("hold");
    expect(decideVerdict({ kind: "artist", name: "Carlos Duarte", decision: review({ id: 1801, name: "Carlos Baute" }), sameName: [] })).toEqual({ kind: "different", rule: "solo-coincidencias-debiles" });
  });

  it("«Independent» no es un sello: se rechaza, no se crea la organización", () => {
    expect(decideVerdict({ kind: "organization", name: "Independent", decision: noMatch, sameName: [] })).toEqual({ kind: "dismiss", rule: "marcador-sin-sello" });
    expect(decideVerdict({ kind: "organization", name: "Velvet", decision: noMatch, sameName: [] }).kind).toBe("different");
  });

  it("un disco o pista sin padre resuelto no se decide", () => {
    expect(decideVerdict({ kind: "album", name: "Joropo", decision: noMatch, sameName: [] })).toMatchObject({ kind: "hold", rule: "padre-sin-resolver" });
    expect(decideVerdict({ kind: "track", name: "Intro", decision: noMatch, sameName: [] })).toMatchObject({ kind: "hold", rule: "padre-sin-resolver" });
  });

  it("un homónimo con contradicción del ER no se fusiona ni se crea", () => {
    expect(decideVerdict({ kind: "album", name: "Joropo", decision: noMatch, sameName: [{ id: 9, name: "Joropo" }], parentId: 5 }))
      .toMatchObject({ kind: "hold", rule: "titulo-igual-con-contradiccion" });
    expect(decideVerdict({ kind: "artist", name: "Danto", decision: noMatch, sameName: [{ id: 2140, name: "Danto" }] }))
      .toMatchObject({ kind: "hold", rule: "mismo-nombre-en-el-core" });
  });

  it("un artista que solo difiere en tildes es el mismo", () => {
    expect(decideVerdict({ kind: "artist", name: "Victor Cuica", decision: review({ id: 1617, name: "Víctor Cuica" }), sameName: [{ id: 1617, name: "Víctor Cuica" }] }))
      .toEqual({ kind: "same", targetId: 1617, rule: "mismo-nombre-sin-tildes" });
  });

  it("lo que no es una persona queda abierto, no se crea como ficha", () => {
    expect(decideVerdict({ kind: "person", name: "Armando Figueredo/Eduardo Lárez", decision: noMatch, sameName: [] }))
      .toMatchObject({ kind: "hold", rule: "no-es-una-persona:multiple_people" });
    expect(decideVerdict({ kind: "person", name: "Kokopelli Studios", decision: noMatch, sameName: [] }).kind).toBe("hold");
    expect(decideVerdict({ kind: "person", name: "Ensamble Gurrufio", decision: noMatch, sameName: [] })).toMatchObject({ kind: "hold", rule: "no-es-una-persona:agrupacion-o-lugar" });
    expect(decideVerdict({ kind: "person", name: "Rios Reyna Concert Hall", decision: noMatch, sameName: [] }).kind).toBe("hold");
    for (const name of ["Skylight Recording", "Synth Lab", "Archivo de La Ciudad", "Poliedro de Caracas", "Daddy's Workshop"]) {
      expect(decideVerdict({ kind: "person", name, decision: noMatch, sameName: [] }), name).toMatchObject({ kind: "hold", rule: "no-es-una-persona:agrupacion-o-lugar" });
    }
    expect(decideVerdict({ kind: "person", name: "Gabriela Montero", decision: noMatch, sameName: [] }).kind).toBe("different");
    expect(decideVerdict({ kind: "person", name: "The forbidden land", decision: noMatch, sameName: [] })).toMatchObject({ kind: "hold", rule: "no-es-una-persona:parece-un-titulo" });
    expect(decideVerdict({ kind: "person", name: "mar Oliveros", decision: noMatch, sameName: [] }).kind).toBe("hold");
    expect(decideVerdict({ kind: "person", name: "Carlos de la Cruz", decision: noMatch, sameName: [] }).kind).toBe("different");
    expect(decideVerdict({ kind: "person", name: "Ludwig van Beethoven", decision: noMatch, sameName: [] }).kind).toBe("different");
    expect(decideVerdict({ kind: "person", name: "9'44", decision: noMatch, sameName: [] })).toEqual({ kind: "dismiss", rule: "basura:duration" });
  });

  it("rótulos y números en el lugar del nombre quedan abiertos", () => {
    const autoMatch: DecisionEvidence = { action: "AUTO_MATCH", score: 0.97, candidates: [] };
    for (const name of ["Feat. Elisa Rego", "Arr: Miguel Astor", "Bonus Track", "tracks 1-4", "Radio Version", "versión a 4 Manos",
      "3rd Mov", "Carlos Rodríguez (track", "The Incoming Race Part II", "Ernesto Schweinburger a.ka. tropi69", "1928", "1248-1254",
      "Comp: Vicente Emilio Sojo", "Recop: Vicente Emilio Sojo", "Recopilación: Vicente Emilio Sojo", "Rec. Vicente Emilio Sojo",
      "Recp. Vicente Emilio Sojo", "Compilation: Vicente Emilio Sojo", "Cuento", "Demo", "Acústico", "Medley"]) {
      expect(decideVerdict({ kind: "person", name, decision: autoMatch, sameName: [] }), name).toMatchObject({ kind: "hold", rule: "no-es-una-persona:rotulo" });
    }
    for (const name of ["Arvo Part", "Mixtli Gómez", "Olivia Bonuse", "Liveth Rojas", "Introíto Pérez",
      "Rebeca Castro", "Compay Segundo", "Cuentos Pérez", "Demóstenes Rojas", "Musical Youth"]) {
      expect(decideVerdict({ kind: "person", name, decision: noMatch, sameName: [] }).kind, name).toBe("different");
    }
  });

  it("lo que solo llega como paréntesis de un título no se crea", () => {
    const parenthesis = { kind: "person" as const, decision: noMatch, sameName: [], onlyTitleParenthesis: true };
    expect(decideVerdict({ ...parenthesis, name: "Capricornio" })).toMatchObject({ kind: "hold", rule: "no-es-una-persona:parentesis-de-titulo" });
    expect(decideVerdict({ ...parenthesis, name: "Night Flight Over Tokyo" }).kind).toBe("hold");
    // Enlace seguro del ER a una persona que ya existe: el crédito sí se aplica.
    const autoMatch: DecisionEvidence = { action: "AUTO_MATCH", score: 0.97, candidates: [{ id: 7, name: "Antonio Lauro", score: 0.97 }] };
    expect(decideVerdict({ ...parenthesis, name: "Antonio Lauro", decision: autoMatch })).toEqual({ kind: "approve", rule: "auto-match" });
    expect(decideVerdict({ ...parenthesis, name: "Leo", decision: autoMatch }).kind).toBe("hold");
    // Sin la señal, el mismo nombre se crea como siempre.
    expect(decideVerdict({ kind: "person", name: "Daniel Pinkham", decision: noMatch, sameName: [] }).kind).toBe("different");
  });

  it("el mismo título bajo el mismo padre es el mismo disco o pista", () => {
    expect(decideVerdict({ kind: "album", name: "Joropo", decision: review(), sameName: [{ id: 9, name: "Joropo" }], parentId: 5 }))
      .toEqual({ kind: "same", targetId: 9, rule: "mismo-titulo-mismo-artista" });
    expect(decideVerdict({ kind: "track", name: "Intro", decision: review(), sameName: [{ id: 7, name: "Intro" }], parentId: 5 }))
      .toEqual({ kind: "same", targetId: 7, rule: "mismo-titulo-mismo-disco" });
  });

  it("el mismo título bajo OTRO padre es otra obra", () => {
    const decision = review({ id: 77, name: "Intro", parentId: 99 });
    expect(decideVerdict({ kind: "track", name: "Intro", decision, sameName: [], parentId: 5 }))
      .toEqual({ kind: "different", rule: "solo-coincide-bajo-otro-padre" });
  });

  it("un título casi igual bajo el mismo padre queda abierto", () => {
    const decision = review({ id: 77, name: "Alma Llanera (Versión)", parentId: 5 });
    expect(decideVerdict({ kind: "track", name: "Alma Llanera", decision, sameName: [], parentId: 5 }).kind).toBe("hold");
  });
});
