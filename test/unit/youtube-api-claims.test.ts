import { describe, expect, it } from "vitest";
import { recordsForVideo } from "../../src/youtube/api-claims.js";
import { parseYouTubeDescription } from "../../src/youtube/parsers.js";

function creditRecords(description: string) {
  const parsed = parseYouTubeDescription(description);
  return recordsForVideo(
    { video_id: "0EDnetbiEwA", title: "Caramelos De Cianuro - Harakiri City (1996) || Full Album ||", description, duration_seconds: 3300, publication_status: "public" },
    [], parsed.sections, parsed.credits, new Set(), new Set(), new Set(),
  ).records.filter((record) => record.entityKind === "album_credit" || record.entityKind === "track_credit");
}
const field = (record: { fields: Array<{ field: string; value?: unknown }> }, name: string) =>
  record.fields.find((item) => item.field === name)?.value;

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

  it("declara el bloque del que sale cada músico y acota los créditos por pista", () => {
    const records = creditRecords([
      "Musicians", "", "Drums: Pablo Martínez", "",
      "Guest Musicians", "", "Keyboards: Jonattan Humpierrez (tracks 01, 03, 05, 10)", "",
      "Other Credits", "", "Tracks 02, 04, 09 composed by Asier Cazalis", "Graphic Design: Pablo Martinez",
    ].join("\n"));
    expect(records.map((record) => [record.entityKind, field(record, "credited_name"), field(record, "credit_role"),
      field(record, "credit_section") ?? null, field(record, "track_numbers") ?? null])).toEqual([
      ["album_credit", "Pablo Martínez", "Drums", "musicians", null],
      ["track_credit", "Jonattan Humpierrez", "Keyboards", "guest_musicians", "1,3,5,10"],
      ["track_credit", "Asier Cazalis", "composed", null, "2,4,9"],
      ["album_credit", "Pablo Martinez", "graphic design", null, null],
    ]);
  });
});
