// Etapa 1 del nuevo lote (2026-10-02): del JSON de investigación a hechos con
// cita, y qué hechos pueden rellenar un hueco del core.
import { describe, expect, it } from "vitest";
import {
  artistFacts, artistTypeClash, cityOf, cleanMember, contextualGenreText, durationSeconds, fullDate,
  isVenezuelanPerLote, isVenezuelanPlace, loteArtistSchema, mapAlbumType, mapArtistType, parseYearsActive,
  releaseFacts, sameCity, sameName, sameTitle,
} from "../../src/ingest/lote-investigacion.js";

const base = {
  id: "x", artist_name: "X", real_name: null, aliases: [], entity_type: "solo", nationality_or_origin: "Venezuelan",
  birth: { date: null, place: null }, death: { date: null, place: null }, origin: null, years_active: null,
  genres: [], subgenres: [], roles: [], instruments: [], members: [], member_of: [], labels: [], bio: null,
  links: {}, discography: [], selected_works: [], sources: [{ url: "https://es.wikipedia.org/wiki/X", note: "Bio" }], verification_notes: [],
};
const artist = (extra: Record<string, unknown>) => loteArtistSchema.parse({ ...base, ...extra });
const fact = (facts: ReturnType<typeof artistFacts>, target: string, field: string) => facts.find((f) => f.target === target && f.field === field);

describe("normalizadores del lote", () => {
  it("fechas completas y años", () => {
    expect(fullDate("1928-08-08")).toBe("1928-08-08");
    expect(fullDate("1981")).toBeNull();
    expect(fullDate("1981-02-30")).toBeNull();
  });

  it("ciudad de un lugar, solo si hay ciudad", () => {
    expect(cityOf("Barbacoas, Aragua, Venezuela")).toBe("Barbacoas");
    expect(cityOf("Venezuela")).toBeNull();
    expect(cityOf("Raised in Mérida, Venezuela")).toBeNull();
    expect(cityOf("Venezuela / Mexico")).toBeNull();
    expect(isVenezuelanPlace("Maracaibo, Zulia, Venezuela")).toBe(true);
    expect(isVenezuelanPlace("Rome, Italy")).toBe(false);
  });

  it("años activos exactos; las décadas no se interpretan", () => {
    expect(parseYearsActive("1974–present")).toEqual({ text: "1974-present", from: 1974, to: null });
    expect(parseYearsActive("1981–1992")).toEqual({ text: "1981-1992", from: 1981, to: 1992 });
    expect(parseYearsActive("1970s–present")).toBeNull();
    expect(parseYearsActive("2007–2017; reunited by 2026")).toBeNull();
  });

  it("tipos de artista y de disco", () => {
    expect(mapArtistType("solo")).toBe("solo_artist");
    expect(mapArtistType("orchestra")).toBe("band");
    expect(artistTypeClash("solo_artist", "band")).toBe(true);
    expect(artistTypeClash("solo_artist", "project")).toBe(false);
    expect(artistTypeClash("band", "duo")).toBe(false);
    expect(mapAlbumType("EP")).toBe("ep");
    expect(mapAlbumType("opera recording")).toBeNull();
  });

  it("duraciones, nacionalidad y miembros", () => {
    expect(durationSeconds("03:05")).toBe(185);
    expect(durationSeconds("1:02:03")).toBe(3723);
    expect(durationSeconds("47 min")).toBeNull();
    expect(isVenezuelanPerLote("Venezuelan / Italian-born")).toBe(true);
    expect(isVenezuelanPerLote("Venezuelan (user-specified; independent open-source nationality confirmation not located)")).toBeNull();
    expect(cleanMember("Oscar D’León (early)")).toEqual({ name: "Oscar D’León", note: "early" });
    expect(cleanMember("others")).toBeNull();
    expect(cleanMember("multiple generations of vocalists")).toBeNull();
  });

  it("comparaciones tolerantes con el core", () => {
    expect(sameCity("Caracas", "Caracas - Distrito Capital")).toBe(true);
    expect(sameCity("Barquisimeto", "Barquisimeto- Lara")).toBe(true);
    expect(sameCity("Lara", "Barquisimeto")).toBe(false);
    expect(sameTitle("Flor de Fuego", "Flor De Fuego (CD/DVD)")).toBe(true);
    expect(sameTitle("Orígenes I", "Orígenes")).toBe(false);
    expect(sameName("Oscar D'León", "Oscar D' León")).toBe(true);
  });
});

describe("«Gothic» suelto según contexto", () => {
  it("metal → metal gótico; si no, rock gótico; las cadenas explícitas no cambian", () => {
    expect(contextualGenreText("Gothic", true)).toEqual({ text: "Gothic Metal", contextual: true });
    expect(contextualGenreText("Gothic", false)).toEqual({ text: "Gothic Rock", contextual: true });
    expect(contextualGenreText("Gothic Metal", false)).toEqual({ text: "Gothic Metal", contextual: false });
  });
});

describe("hechos de una ficha", () => {
  it("solista: persona titular con fechas completas; origen solo si es venezolano", () => {
    const facts = artistFacts(artist({
      real_name: "Giordano Di Marzo Migani", birth: { date: "1952-05-27", place: "Rome, Italy" }, death: { date: "2020", place: null },
    }));
    expect(fact(facts, "artist", "origin_city")).toBeUndefined();
    expect(fact(facts, "person", "birth_city")?.value).toBe("Rome");
    expect(fact(facts, "person", "birth_date")?.policy).toBe("fill");
    expect(fact(facts, "person", "death_date")).toBeUndefined();
    expect(fact(facts, "person", "death_year")?.policy).toBe("candidate");
    expect(fact(facts, "person", "is_deceased")?.value).toBe(true);
    expect(fact(facts, "person", "real_name")?.evidence[0]?.url).toBe("https://es.wikipedia.org/wiki/X");
  });

  it("conjunto: año de formación y separación, sin persona", () => {
    const facts = artistFacts(artist({ entity_type: "band", years_active: "1992–1998", origin: "Caracas, Venezuela", birth: null }));
    expect(fact(facts, "artist", "formed_year")?.value).toBe(1992);
    expect(fact(facts, "artist", "disbanded_year")?.value).toBe(1998);
    expect(fact(facts, "artist", "origin_city")?.value).toBe("Caracas");
    expect(facts.some((f) => f.target === "person")).toBe(false);
  });

  it("bio, géneros y miembros quedan como candidatos; sin fuentes no hay hechos", () => {
    const facts = artistFacts(artist({ bio: "Texto", genres: ["Salsa"], subgenres: ["salsa dura"], members: ["A B", "others"] }));
    expect(fact(facts, "artist", "biography")?.policy).toBe("candidate");
    expect(facts.filter((f) => f.field === "genre").map((f) => f.note)).toEqual(["orden 0", "orden 1"]);
    expect(facts.filter((f) => f.field === "member").map((f) => f.value)).toEqual(["A B"]);
    expect(artistFacts(artist({ sources: [], bio: "Texto" }))).toEqual([]);
  });

  it("disco: «album» genérico no rellena el tipo; un EP sí; pistas con duración", () => {
    const a = artist({});
    const generic = releaseFacts(a, { title: "T", year: 1990, type: "album", tracks: [] }, 0);
    expect(generic.album.find((f) => f.field === "album_type")?.policy).toBe("candidate");
    const ep = releaseFacts(a, { title: "T", year: 1990, type: "EP", source_urls: ["https://example.org/t"], tracks: [{ position: 1, title: "Uno", duration: "03:05", artists: [] }] }, 0);
    expect(ep.album.find((f) => f.field === "album_type")).toMatchObject({ value: "ep", policy: "fill" });
    expect(ep.album[0]?.evidence[0]?.url).toBe("https://example.org/t");
    expect(ep.tracks[0]?.facts.find((f) => f.field === "duration_seconds")?.value).toBe(185);
  });
});
