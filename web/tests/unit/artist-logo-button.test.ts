import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtistLogoButton } from "../../src/components/ArtistLogoButton";

describe("miniatura inicial del logo", () => {
  const render = (src: string, artistId: number) => renderToStaticMarkup(createElement(ArtistLogoButton, {
    src, artistId, name: "Artista", onOpen: () => undefined,
  }));

  it("muestra la clase cuadrada antes de cargar el PNG de Abaddonsheol", () => {
    const html = render("/crv/media/artist/3179-logo.png", 3179);
    expect(html).toContain("artist-profile__logo--square");
    expect(html).toContain('style="width:88px;height:88px"');
  });

  it("muestra la clase parcialmente cuadrada para un logo intermedio", () => {
    expect(render("/crv/media/artist/105-logo.jpg", 105)).toContain("artist-profile__logo--near-square");
  });

  it("mantiene la franja para el logo ancho de Abaddon", () => {
    const html = render("/crv/media/artist/963-logo.jpg", 963);
    expect(html).toContain("artist-profile__logo--wide");
    expect(html).toContain('style="width:88px;height:30px"');
  });

  it("conserva el formato del catálogo si la API devuelve otra URL", () => {
    const html = render("https://example.com/logo-externo.png", 3179);
    expect(html).toContain("artist-profile__logo--square");
    expect(html).toContain('style="width:88px;height:88px"');
  });
});
