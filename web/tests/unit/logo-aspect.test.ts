import { describe, expect, it } from "vitest";
import { classifyLogoAspect, knownLogoAspect } from "../../src/lib/logoAspect";

describe("formato de la miniatura de logos", () => {
  it("distingue un logo cuadrado, uno parcialmente cuadrado y uno horizontal del catálogo", () => {
    expect(classifyLogoAspect(636, 635)).toBe("square"); // Abaddonsheol
    expect(classifyLogoAspect(386, 188)).toBe("near-square"); // Grand Bite
    expect(classifyLogoAspect(787, 102)).toBe("wide"); // Abaddon
  });

  it("trata proporciones intermedias como parcialmente cuadradas", () => {
    expect(classifyLogoAspect(180, 100)).toBe("near-square");
    expect(classifyLogoAspect(250, 100)).toBe("wide");
  });

  it("usa dimensiones locales antes de que cargue la imagen, incluso con un URL con query", () => {
    expect(knownLogoAspect("/crv/media/artist/3179-logo.png")).toBe("square");
    expect(knownLogoAspect("/crv/media/artist/105-logo.jpg?v=2")).toBe("near-square");
    expect(knownLogoAspect("/crv/media/artist/963-logo.jpg")).toBe("wide");
    expect(knownLogoAspect("https://example.com/logo-externo.png", 3179)).toBe("square");
    expect(knownLogoAspect("https://example.com/logo-externo.png", 963)).toBe("wide");
    expect(knownLogoAspect("https://example.com/otro-logo.png")).toBeNull();
  });
});
