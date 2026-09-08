import { describe, expect, it } from "vitest";
import { normalizeEntityName, splitDeclaredStageName } from "../../src/normalization/entity-name.js";
import { resolveEntityDeterministically } from "../../src/er/scoring.js";
import { DEFAULT_RESOLUTION_THRESHOLDS, type ResolutionCandidate } from "../../src/er/types.js";

describe("normalizacion de identidad por capas", () => {
  it("conserva original, normaliza Unicode/case/espacios/puntuacion y deja tildes como senal secundaria", () => {
    const value = "  PACI\u0066I\u0063A  “Rock”  ";
    const normalized = normalizeEntityName(value);
    expect(normalized.original).toBe(value);
    expect(normalized.display).toBe("PACIfIcA “Rock”");
    expect(normalized.primaryKey).toBe("pacifica rock");

    const plain = normalizeEntityName("Pacifica");
    const accented = normalizeEntityName("Paci\u0301fica");
    expect(accented.display).toBe("Pacífica");
    expect(accented.primaryKey).not.toBe(plain.primaryKey);
    expect(accented.secondaryKey).toBe(plain.secondaryKey);
  });

  it("normaliza comillas/apostrofes/articulos como variantes sin reescribir presentacion", () => {
    const curly = normalizeEntityName("Los D’León — Rock");
    const straight = normalizeEntityName("los d'león rock");
    expect(curly.primaryKey).toBe(straight.primaryKey);
    expect(curly.articlelessPrimaryKey).toBe("dleón rock");
    expect(curly.display).toBe("Los D’León — Rock");
    expect(splitDeclaredStageName("José Luis Rodríguez aka El Puma")).toEqual({ legalOrCanonical: "José Luis Rodríguez", stageName: "El Puma" });
  });
});

describe("scores explicables por tipo", () => {
  it("auto-matchea un ARTIST exacto unico y expone cada feature", () => {
    const candidates: ResolutionCandidate[] = [{ kind: "ARTIST", id: 1, name: "Caramelos de Cianuro", canonicalName: "Caramelos de Cianuro", origin: { country: "Venezuela" } }];
    const decision = resolveEntityDeterministically({ kind: "ARTIST", name: "  CARAMELOS DE CIANURO " }, candidates);
    expect(decision.action).toBe("AUTO_MATCH");
    expect(decision.candidateId).toBe(1);
    expect(decision.features.map((item) => item.key)).toContain("artist.unique_exact_identity");
    expect(decision.features.every((item) => item.evidence.length > 0)).toBe(true);
  });

  it("reconoce un nombre artistico solo porque existe como alias explicito", () => {
    const decision = resolveEntityDeterministically({ kind: "PERSON", name: "El Puma", bands: ["Una trayectoria solista"], roles: ["cantante"] }, [{
      kind: "PERSON", id: 8, name: "José Luis Rodríguez", canonicalName: "José Luis Rodríguez",
      aliases: [{ value: "El Puma", type: "stage_name", confidence: "high" }],
      bands: ["Una trayectoria solista"], roles: ["cantante"],
    }]);
    expect(decision.action).toBe("AUTO_MATCH");
    expect(decision.candidates[0]?.nameBasis).toBe("alias_exact");
  });

  it("desambigua homonimos PERSON por bandas/periodo/rol, no por nombre solo", () => {
    const candidates: ResolutionCandidate[] = [
      { kind: "PERSON", id: 10, name: "Carlos García", canonicalName: "Carlos García", bands: ["Sentimiento Muerto"], roles: ["bajo"], period: { from: 1988, to: 1992 } },
      { kind: "PERSON", id: 11, name: "Carlos García", canonicalName: "Carlos García", bands: ["Los Paranoias"], roles: ["batería"], period: { from: 2005, to: 2010 } },
    ];
    const contextual = resolveEntityDeterministically({ kind: "PERSON", name: "Carlos Garcia", bands: ["Los Paranoias"], roles: ["batería"], period: { from: 2006, to: 2009 } }, candidates);
    // La falta de tilde es secundaria, pero tres senales contextuales permiten
    // recomendar al homonimo correcto sin depender del fuzzy.
    expect(contextual.candidateId).toBe(11);
    expect(contextual.action).not.toBe("NO_MATCH");
    expect(contextual.candidates[0]?.features.map((item) => item.key)).toEqual(expect.arrayContaining(["person.bands", "person.roles", "person.period"]));

    const nameOnly = resolveEntityDeterministically({ kind: "PERSON", name: "Carlos García" }, candidates);
    expect(nameOnly.action).toBe("REVIEW");
  });

  it("ALBUM requiere artista+titulo; un artista distinto bloquea auto-merge", () => {
    const candidate: ResolutionCandidate = {
      kind: "ALBUM", id: 20, name: "En Vivo", canonicalName: "En Vivo",
      artist: { id: 1, name: "Caramelos de Cianuro" }, year: 2009, releaseType: "live_album",
      tracklist: ["El último polvo"],
    };
    const match = resolveEntityDeterministically({ kind: "ALBUM", name: "En Vivo", artist: { id: 1, name: "Caramelos de Cianuro" }, year: 2009, releaseType: "live_album" }, [candidate]);
    expect(match.action).toBe("AUTO_MATCH");
    expect(match.features.map((item) => item.key)).toContain("album.composite_identity");

    const wrongArtist = resolveEntityDeterministically({ kind: "ALBUM", name: "En Vivo", artist: { id: 999, name: "Otra Banda" }, year: 2009 }, [candidate]);
    expect(wrongArtist.action).not.toBe("AUTO_MATCH");
    expect(wrongArtist.candidates[0]?.hardConflicts).toContain("parent_id distinto (999 != 1)");
  });

  it("TRACK usa album+disco+numero+titulo como identidad compuesta", () => {
    const decision = resolveEntityDeterministically({ kind: "TRACK", name: "De vuelta a casa", album: { id: 30, name: "Miss Mujerzuela" }, disc: 1, trackNumber: 3 }, [{
      kind: "TRACK", id: 31, name: "De Vuelta A Casa", canonicalName: "De Vuelta A Casa",
      album: { id: 30, name: "Miss Mujerzuela" }, disc: 1, trackNumber: 3,
    }]);
    expect(decision.action).toBe("AUTO_MATCH");
    expect(decision.features.map((item) => item.key)).toContain("track.composite_position");
  });

  it("ORGANIZATION separa nombre, tipo, ubicacion y asociaciones", () => {
    const decision = resolveEntityDeterministically({ kind: "ORGANIZATION", name: "Sonográfica", organizationType: "record_label", location: { country: "Venezuela" }, associatedAlbums: ["En Vivo"] }, [{
      kind: "ORGANIZATION", id: 40, name: "Sonográfica", canonicalName: "Sonográfica", organizationType: "record_label", location: { country: "Venezuela" }, associatedAlbums: ["En Vivo"],
    }]);
    expect(decision.action).toBe("AUTO_MATCH");
    expect(decision.features.map((item) => item.key)).toEqual(expect.arrayContaining(["organization.type", "organization.location_country", "organization.albums"]));
  });

  it("rechaza fuzzy-only, articulo-only y tilde-only como auto merge", () => {
    const fuzzy = resolveEntityDeterministically({ kind: "ARTIST", name: "Sentimientos Muertoo" }, [{ kind: "ARTIST", id: 50, name: "Sentimiento Muerto", canonicalName: "Sentimiento Muerto" }]);
    const article = resolveEntityDeterministically({ kind: "ARTIST", name: "Amigos Invisibles" }, [{ kind: "ARTIST", id: 51, name: "Los Amigos Invisibles", canonicalName: "Los Amigos Invisibles" }]);
    const accent = resolveEntityDeterministically({ kind: "ARTIST", name: "Pacifica" }, [{ kind: "ARTIST", id: 52, name: "Pacífica", canonicalName: "Pacífica" }]);
    for (const decision of [fuzzy, article, accent]) expect(decision.action).not.toBe("AUTO_MATCH");
    expect(fuzzy.candidates[0]?.nameBasis).toBe("fuzzy");
    expect(article.candidates[0]?.nameBasis).toBe("article_variant");
    expect(accent.candidates[0]?.nameBasis).toBe("accent_only");
  });

  it("respeta thresholds configurables", () => {
    const candidate: ResolutionCandidate = { kind: "PERSON", id: 60, name: "Ana Pérez", canonicalName: "Ana Pérez" };
    const defaultDecision = resolveEntityDeterministically({ kind: "PERSON", name: "Ana Pérez" }, [candidate]);
    const stricter = resolveEntityDeterministically({ kind: "PERSON", name: "Ana Pérez" }, [candidate], { ...DEFAULT_RESOLUTION_THRESHOLDS, POSSIBLE_MATCH: 0.8, REVIEW: 0.7 });
    expect(defaultDecision.action).toBe("POSSIBLE_MATCH");
    expect(stricter.action).toBe("REVIEW");
  });
});
