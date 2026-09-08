// El rol crudo se conserva íntegro en la columna `role`; credit_type es solo
// la clasificación gruesa. Lo que se fija aquí es que la clasificación sea
// determinista y que un rol desconocido caiga en `other` en vez de forzarse
// a `musician`: inventar que alguien tocó es peor que no clasificarlo.
import { describe, expect, it } from "vitest";
import { creditTypeForRole, isRelationKind } from "../../src/merge/relations.js";

describe("clasificación de créditos", () => {
  it("mapea instrumentos y voces a musician, en inglés y español", () => {
    for (const role of ["Guitar", "Electric Bass", "Bajo", "Batería", "Drums", "Voz", "Lead Vocals",
      "Teclados", "Piano", "Saxo Tenor", "Cuatro", "Maracas", "Coros"]) {
      expect(creditTypeForRole(role)).toBe("musician");
    }
  });

  it("distingue las funciones de estudio entre sí", () => {
    expect(creditTypeForRole("Produced by")).toBe("producer");
    expect(creditTypeForRole("Producción")).toBe("producer");
    expect(creditTypeForRole("Recorded at Estudios Fidelis")).toBe("recording");
    expect(creditTypeForRole("Mezcla")).toBe("mixing");
    expect(creditTypeForRole("Mastered by")).toBe("mastering");
    // Lo específico gana sobre lo genérico: "mastering engineer" no es
    // `recording` aunque contenga "engineer".
    expect(creditTypeForRole("Mastering Engineer")).toBe("mastering");
  });

  it("separa autoría, arte e invitados", () => {
    expect(creditTypeForRole("Composer")).toBe("composer");
    expect(creditTypeForRole("Letra")).toBe("writer");
    expect(creditTypeForRole("Fotografía")).toBe("photography");
    expect(creditTypeForRole("Diseño de portada")).toBe("artwork");
    expect(creditTypeForRole("Guest Vocals")).toBe("guest");
  });

  it("no clasifica lo que no reconoce", () => {
    expect(creditTypeForRole("Agradecimientos")).toBe("other");
    expect(creditTypeForRole("")).toBe("other");
  });

  it("solo reconoce como relación los tres tipos con tabla puente", () => {
    expect(isRelationKind("artist_membership")).toBe(true);
    expect(isRelationKind("album_credit")).toBe(true);
    expect(isRelationKind("track_credit")).toBe(true);
    for (const kind of ["artist", "person", "album", "track", "organization",
      "person_organization", "album_format", "youtube_video"]) {
      expect(isRelationKind(kind)).toBe(false);
    }
  });
});
