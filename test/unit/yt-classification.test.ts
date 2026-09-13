import { describe, expect, it } from "vitest";
import { classifySheetRow, collectReleaseYears, inferSheetType, releaseIdentity } from "../../src/youtube/normalization.js";
import { rowClassifications } from "../../src/youtube/classifications.js";

describe("tipos de la hoja", () => {
  it("el tipo escrito manda y uno vacío se infiere marcado", () => {
    expect(classifySheetRow({ type: "Live Album", artistName: "Various Artists", albumName: "X" }).normalizedType).toBe("live_album");
    const inferred = classifySheetRow({ type: null, artistName: "Tulio Chuecos", albumName: "EP" });
    expect(inferred).toMatchObject({ kind: "release", normalizedType: "ep" });
    expect(inferred.reason).toMatch(/^tipo inferido/);
    expect(classifySheetRow({ type: "EMPTY", artistName: "EMPTY", albumName: "EMPTY" }).kind).toBe("review");
  });

  it.each([
    ["Various Artists", "Venezuela Electrónica Vol. 1", "compilation"],
    ["Psh Psh", "Demos", "demo"],
    ["La Vida Bohème", "En Vivo Plaza Alfredo Sadel", "live_album"],
    ["Pablo Gill", "Suka Jazz En Directo", "live_album"],
    ["Damper", "Damper", "studio_album"],
  ])("infiere %s — %s como %s", (artist, album, type) => {
    expect(inferSheetType(artist, album)).toBe(type);
  });

  it("guarda todas las clasificaciones de la celda en orden", () => {
    expect(rowClassifications({ type_raw: "Solo Artist, Studio Album", artist_name_raw: "Yátu", album_name_raw: "Inmortal" }))
      .toEqual([{ classification: "Solo Artist", inferred: false }, { classification: "Studio Album", inferred: false }]);
    expect(rowClassifications({ type_raw: null, artist_name_raw: "Damper", album_name_raw: "Damper" }))
      .toEqual([{ classification: "Studio Album", inferred: true }]);
  });
});

describe("identidad de discos homónimos", () => {
  it("el más antiguo conserva la identidad y el otro lleva el año", () => {
    const years = collectReleaseYears([
      { artist: "Spiteri", album: "Spiteri", year: 1973 },
      { artist: "Spiteri", album: "Spiteri", year: 1981 },
      { artist: "Damper", album: "Damper", year: 2006 },
    ]);
    expect(releaseIdentity("Spiteri", "Spiteri", 1973, years)).toBe("Spiteri::Spiteri");
    expect(releaseIdentity("Spiteri", "Spiteri", 1981, years)).toBe("Spiteri::Spiteri (1981)");
    expect(releaseIdentity("Damper", "Damper", 2006, years)).toBe("Damper::Damper");
    expect(releaseIdentity("Damper", "Damper", null, years)).toBe("Damper::Damper");
  });
});
