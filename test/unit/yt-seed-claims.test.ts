// A1 · La hoja maestra como discografía. Lo que se prueba es la semántica de
// la traducción, no que "haya muchos registros": qué fila produce disco, cuál
// no, y con qué evidencia se queda una fila que no tiene video.
import { describe, expect, it } from "vitest";
import { seedRecords, type SeedRow } from "../../src/youtube/seed-claims.js";
import type { RawRecord } from "../../src/adapters/contracts.js";

const base: SeedRow = {
  upload_order: 1, artist_name_raw: "10MC", album_name_raw: "10 Minutos Cegado",
  album_year_raw: 2004, type_raw: "Studio Album", video_id: "UPW9WexiE5E",
  row_number: 2, content_kind: "release", normalized_type: "studio_album",
};
const row = (over: Partial<SeedRow>): SeedRow => ({ ...base, ...over });
const fieldsOf = (record: RawRecord): Record<string, unknown> =>
  Object.fromEntries(record.fields.map((f) => [f.field, f.value]));

describe("hoja maestra de YouTube -> registros crudos", () => {
  it("una fila release produce artista y disco con año, tipo y video", () => {
    const { records } = seedRecords([base]);
    expect(records.map((r) => r.entityKind)).toEqual(["artist", "album"]);
    expect(records[1]?.identity).toBe("10MC::10 Minutos Cegado");
    expect(fieldsOf(records[1]!)).toEqual({
      title: "10 Minutos Cegado", artist_name: "10MC", release_year: "2004",
      album_type: "studio_album", youtube_url: "https://www.youtube.com/watch?v=UPW9WexiE5E",
    });
  });

  it("un audiovisual deja al artista pero NO inventa una publicación", () => {
    const { records, mediaOnly } = seedRecords([
      row({ type_raw: "Documentary", content_kind: "media", normalized_type: "documentary" }),
    ]);
    expect(mediaOnly).toBe(1);
    expect(records.map((r) => r.entityKind)).toEqual(["artist"]);
  });

  it("un tipo compuesto sí produce disco, pero sin album_type", () => {
    // La hoja afirma que el disco existe; lo ambiguo es sólo su tipo, y esa
    // ambigüedad ya tiene su manual_review abierta desde la importación.
    const { records, albumsSinTipo } = seedRecords([
      row({ type_raw: "Solo Artist, Studio Album", content_kind: "review", normalized_type: null }),
    ]);
    expect(albumsSinTipo).toBe(1);
    const album = records.find((r) => r.entityKind === "album");
    expect(album).toBeDefined();
    expect(Object.keys(fieldsOf(album!))).not.toContain("album_type");
    expect(fieldsOf(album!)["title"]).toBe("10 Minutos Cegado");
  });

  it("una fila sin video se apoya en el propio libro, no en una URL inventada", () => {
    const { records } = seedRecords([row({ video_id: null, row_number: 20 })]);
    const album = records.find((r) => r.entityKind === "album")!;
    const evidencia = album.fields[0]!.evidence;
    expect(evidencia.url.startsWith("file://")).toBe(true);
    expect(evidencia.url).toMatch(/#row=20$/);
    expect(Object.keys(fieldsOf(album))).not.toContain("youtube_url");
  });

  it("el artista se afirma una sola vez aunque tenga varios discos", () => {
    const { records } = seedRecords([
      base,
      row({ upload_order: 2, album_name_raw: "Otro", video_id: null }),
      row({ upload_order: 3, artist_name_raw: "10mc", album_name_raw: "Tercero", video_id: null }),
    ]);
    expect(records.filter((r) => r.entityKind === "artist")).toHaveLength(1);
    expect(records.filter((r) => r.entityKind === "album")).toHaveLength(3);
  });

  it("una fila sin artista o sin disco no afirma nada", () => {
    const { records, skipped } = seedRecords([
      row({ artist_name_raw: null }), row({ album_name_raw: "   " }),
    ]);
    expect(skipped).toBe(2);
    expect(records).toHaveLength(0);
  });
});
