import { describe, expect, it } from "vitest";
import { recordsForVideo } from "../../src/youtube/api-claims.js";
import { parseYouTubeDescription } from "../../src/youtube/parsers.js";

function creditRoles(description: string): Array<[string, string]> {
  const parsed = parseYouTubeDescription(description);
  const { records } = recordsForVideo(
    { video_id: "Q-pRpO2sYSI", title: "Caramelos De Cianuro - Las Paticas De La Abuela (1992) || Full Album ||", description, duration_seconds: 940, publication_status: "public" },
    [], parsed.sections, parsed.credits, new Set(), new Set(), new Set(),
  );
  return records.filter((record) => record.entityKind === "album_credit").map((record): [string, string] => [
    String(record.fields.find((field) => field.field === "credited_name")!.value),
    String(record.fields.find((field) => field.field === "credit_role")!.value),
  ]);
}

describe("créditos del canal", () => {
  it("un arte con dos sustantivos es un solo crédito; la foto también entra", () => {
    expect(creditRoles("Other Credits\n\nArtwork & Illustration by Pablo Martínez\nPhotography by Carlos Rondon")).toEqual([
      ["Pablo Martínez", "artwork & illustration"], ["Carlos Rondon", "photography"],
    ]);
  });

  it("los demás verbos compuestos siguen dando un crédito por verbo, como antes", () => {
    expect(creditRoles("Other Credits\n\nRecorded & Engineered by Boris Milan\nRecorded & Mixed by Boris Milan")).toEqual([
      ["Boris Milan", "recorded"], ["Boris Milan", "engineered"], ["Boris Milan", "recorded"], ["Boris Milan", "mixed"],
    ]);
  });
});
