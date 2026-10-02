import { describe, expect, it } from "vitest";
import { splitTrailingNickname } from "../../src/normalization/entity-name.js";

describe("splitTrailingNickname", () => {
  it("separa el apodo final del nombre (caso Canserbero)", () => {
    expect(splitTrailingNickname('Tirone González "Canserbero"')).toEqual({ name: "Tirone González", nicknames: ["Canserbero"] });
    expect(splitTrailingNickname('Reynaldo Goitía "Boston Rex"')).toEqual({ name: "Reynaldo Goitía", nicknames: ["Boston Rex"] });
    expect(splitTrailingNickname('José Javier Márquez Nuñez "J.J."')).toEqual({ name: "José Javier Márquez Nuñez", nicknames: ["J.J."] });
  });

  it("reparte los apodos que la fuente apiló con barra", () => {
    expect(splitTrailingNickname('Sebastián González "Sebas/Grimmode"')).toEqual({ name: "Sebastián González", nicknames: ["Sebas", "Grimmode"] });
  });

  it("acepta comillas tipográficas", () => {
    expect(splitTrailingNickname("Pedro Pérez “Perucho”")).toEqual({ name: "Pedro Pérez", nicknames: ["Perucho"] });
  });

  it("no toca el apodo intercalado: así se nombra a la persona", () => {
    expect(splitTrailingNickname('Rafael "Pollo" Brito')).toBeNull();
    expect(splitTrailingNickname('Rubén "Micho" Correa')).toBeNull();
  });

  it("no deja una base que no identifique a nadie", () => {
    expect(splitTrailingNickname('Pablo "El Che"')).toBeNull();
    expect(splitTrailingNickname('"R"')).toBeNull();
  });

  it("separa el @usuario final, solo o detrás de un apodo (2026-10-02)", () => {
    expect(splitTrailingNickname("Gustavo Dal Farra @GustavoDB")).toEqual({ name: "Gustavo Dal Farra", nicknames: ["GustavoDB"] });
    expect(splitTrailingNickname('Edward Vera "Turtled" @Turtleddj')).toEqual({ name: "Edward Vera", nicknames: ["Turtled", "Turtleddj"] });
    expect(splitTrailingNickname("joa@DiArt")).toBeNull();
    expect(splitTrailingNickname("Joa @DiArt")).toBeNull();
  });

  it("deja en paz lo que no lleva apodo entre comillas", () => {
    expect(splitTrailingNickname("Tirone González")).toBeNull();
    expect(splitTrailingNickname("Luis Pérez (Caracas)")).toBeNull();
  });
});
