import { describe, expect, it } from "vitest";
import { titleKey, variantOf } from "../../scripts/lote-etapa3-comun.js";

const core = (...titles: string[]) => titles.map((title, index) => ({ id: index + 1, title, year: null, type: "other" }));

describe("etapa 3 · títulos de discos", () => {
  it("quita lo que añaden las plataformas", () => {
    expect(titleKey("Mutant (Deluxe Edition)")).toBe(titleKey("Mutant"));
    expect(titleKey("Chama - Single")).toBe("chama");
    expect(titleKey("Children Of Tomorrow (Pythius Remix) (Instrumental)")).toBe(titleKey("Children Of Tomorrow (Pythius Remix)"));
    expect(titleKey("Before The Dawn (feat. Celldweller)")).toBe("before the dawn");
    expect(titleKey("Sinfonía del Palmar [Remasterizado]")).toBe(titleKey("Sinfonia Del Palmar"));
  });

  it("los volúmenes y numerales son discos distintos", () => {
    expect(variantOf(titleKey("Stretch 1"), core("Stretch 2"))).toBeNull();
    expect(variantOf(titleKey("KicK iii"), core("KICK ii"))).toBeNull();
    expect(variantOf(titleKey("Concierto en la Llanura, Vol. 2"), core("Concierto en la Llanura"))).toBeNull();
  });

  it("detecta variantes de un mismo título", () => {
    expect(variantOf(titleKey("La Navidad De Juan Vicente Torrealba"), core("La Navidad De Juan Vicente"))?.id).toBe(1);
    expect(variantOf(titleKey("Sinfonia del Palmar"), core("Sinfonía Del Palmarr"))?.id).toBe(1);
    expect(variantOf(titleKey("Xen"), core("Mutant"))).toBeNull();
  });
});
