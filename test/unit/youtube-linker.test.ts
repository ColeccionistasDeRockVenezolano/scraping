import { describe, expect, it } from "vitest";
import { youtubeLinkKey } from "../../src/youtube/linker.js";

describe("clave conservadora para yt:link", () => {
  it("normaliza sólo variaciones tipográficas previsibles", () => {
    expect(youtubeLinkKey("Cantos De Victoria II (Jinetes De Rohan)"))
      .toBe(youtubeLinkKey("cantos de victoria ii - jinetes de rohan"));
    expect(youtubeLinkKey("Pacífica")).toBe(youtubeLinkKey("Pacifica"));
  });

  it("no reduce una identidad a coincidencia por palabras", () => {
    expect(youtubeLinkKey("The Collapse Of Singularity"))
      .not.toBe(youtubeLinkKey("Collapse"));
  });
});
