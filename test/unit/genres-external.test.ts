// PLAN_GENEROS etapa 4: resolución de identidad contra una fuente externa,
// mapeo de sus etiquetas contra la taxonomía aprobada y lectura de las fichas
// de evaluación. Todo sin base de datos ni red: son funciones puras.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resetEnvCache } from "../../src/config/env.js";
import { desiredFromFile, DEFAULT_TAXONOMY_FILE } from "../../src/genres/admin.js";
import { discogsAdapter, musicbrainzAdapter, sourceAuthHeaders } from "../../src/genres/external/adapters.js";
import {
  decideMatch, resolveAlbumIdentity, resolveArtistIdentity, scoreAlbumCandidate, scoreArtistCandidate,
  type ExternalCandidate,
} from "../../src/genres/external/identity.js";
import { precisionOf } from "../../src/genres/external/import.js";
import { mapExternalValues, parseTagPolicy, type CrvGenreState, type ExternalGenreValue } from "../../src/genres/external/mapping.js";
import { loadSheetsFile, parseSheet } from "../../src/genres/external/sheets.js";
import { buildTaxonomy, type AliasTarget, type GenreNode, type Taxonomy } from "../../src/genres/taxonomy.js";

function realTaxonomy(): Taxonomy {
  const desired = desiredFromFile(JSON.parse(readFileSync(DEFAULT_TAXONOMY_FILE, "utf8")));
  const ids = new Map(desired.genres.map((genre, index) => [genre.slug, index + 1]));
  const nodes: GenreNode[] = desired.genres.map((genre) => ({
    id: ids.get(genre.slug)!, slug: genre.slug, name: genre.name, level: genre.level,
    parentId: genre.parentSlug ? ids.get(genre.parentSlug)! : null, active: true, replacedById: null,
  }));
  const aliases: Array<[string, AliasTarget]> = [...desired.aliases].map(([key, value]) => [
    key, value.target === "not_a_genre" ? { kind: "not_a_genre" } : { kind: "genre", genreId: ids.get(value.target)! },
  ]);
  return buildTaxonomy(nodes, aliases);
}

const taxonomy = realTaxonomy();
const id = (slug: string) => taxonomy.bySlug.get(slug)!.id;
const emptyState: CrvGenreState = { primaryGenreId: null, confirmedGenreIds: [], suggestedGenreIds: [], rejectedGenreIds: [] };

const artist = (over: Partial<ExternalCandidate> = {}): ExternalCandidate => ({
  externalId: "mbid-1", name: "Sentimiento Muerto", country: "VE", areaName: "Venezuela",
  releaseTitles: ["Sin Sombra", "Vamos a la Playa"], memberNames: [], ...over,
});

describe("identidad externa: artista", () => {
  it("el nombre solo no basta, aunque sea exacto", () => {
    const scored = scoreArtistCandidate({ name: "Sentimiento Muerto" },
      artist({ country: null, areaName: null, releaseTitles: [] }));
    expect(scored.blocked).toBe("solo coincide el nombre");
    expect(decideMatch([scored]).status).not.toBe("matched");
  });

  it("nombre + país + discografía coincidente sí alcanzan", () => {
    const outcome = resolveArtistIdentity(
      { name: "Sentimiento Muerto", albumTitles: ["Sin Sombra", "Sentimiento Muerto"] }, [artist()]);
    expect(outcome.status).toBe("matched");
    expect(outcome.best!.signals.map((signal) => signal.name)).toContain("country_ve");
  });

  it("un nombre distinto no es candidato", () => {
    const outcome = resolveArtistIdentity({ name: "Zapato 3" }, [artist()]);
    expect(outcome.status).toBe("none");
    expect(outcome.best).toBeNull();
  });

  it("dos homónimos igual de buenos quedan ambiguos, no se elige el primero", () => {
    const outcome = resolveArtistIdentity(
      { name: "Los Amigos Invisibles", albumTitles: ["Arepa 3000"] },
      [
        artist({ externalId: "a", name: "Los Amigos Invisibles", releaseTitles: ["Arepa 3000"] }),
        artist({ externalId: "b", name: "Los Amigos Invisibles", releaseTitles: ["Arepa 3000"] }),
      ]);
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.reason).toMatch(/casi iguales/u);
  });

  it("un alias del catálogo vale como nombre, con otra señal encima", () => {
    const outcome = resolveArtistIdentity(
      { name: "Desorden Público", aliases: ["Desorden Publico Ska"], albumTitles: ["Plomo Revienta", "Canto Popular"] },
      [artist({ name: "Desorden Publico Ska", releaseTitles: ["Plomo Revienta", "Canto Popular"], country: "VE" })]);
    expect(outcome.status).toBe("matched");
    expect(outcome.best!.signals.map((signal) => signal.name)).toContain("name_alias");
  });

  it("un solo título coincidente cuenta como prueba independiente (regla del 2026-09-26)", () => {
    // Con un único acierto la señal sigue siendo parcial, pero ya basta: el
    // nombre más una prueba independiente y ningún rival cerca.
    const outcome = resolveArtistIdentity(
      { name: "Desorden Público", aliases: ["Desorden Publico Ska"], albumTitles: ["Plomo Revienta"] },
      [artist({ name: "Desorden Publico Ska", releaseTitles: ["Plomo Revienta"], country: "VE" })]);
    expect(outcome.status).toBe("matched");
    expect(outcome.best!.signals.map((signal) => signal.name)).toContain("discography_partial");
  });

  it("el disco homónimo no cuenta como discografía: el nombre ya se cobró", () => {
    // «Almendra» con un disco «Almendra» es el nombre repetido, no evidencia
    // nueva. Es exactamente la forma que toman los homónimos famosos.
    const homonimo = resolveArtistIdentity(
      { name: "Almendra", albumTitles: ["Almendra"] },
      [artist({ name: "Almendra", releaseTitles: ["Almendra"], country: null, areaName: null })]);
    expect(homonimo.status).not.toBe("matched");
    expect(homonimo.best?.signals.map((signal) => signal.name) ?? []).not.toContain("discography_strong");

    // Con tres títulos propios sí se resuelve sola, sin país ni miembros: es el
    // caso que Discogs no podía aprobar nunca por su techo de 0,75.
    const real = resolveArtistIdentity(
      { name: "Agresión", albumTitles: ["Cultura 3", "Guerra Santa", "Sur"] },
      [artist({ name: "Agresión", releaseTitles: ["Cultura 3", "Guerra Santa", "Sur"] })]);
    expect(real.status).toBe("matched");
    expect(real.best!.score).toBeGreaterThanOrEqual(0.85);
  });
});

describe("identidad externa: lanzamiento", () => {
  const album = (over: Partial<ExternalCandidate> = {}): ExternalCandidate => ({
    externalId: "rg-1", name: "Sin Sombra", artistExternalId: "mbid-1", year: 1987,
    trackTitles: [], labelNames: [], catalogNumbers: [], ...over,
  });

  it("un lanzamiento de otro artista no se mira siquiera", () => {
    const scored = scoreAlbumCandidate({ title: "Sin Sombra", artistExternalId: "mbid-1" }, album({ artistExternalId: "otro" }));
    expect(scored.blocked).toMatch(/no cuelga del artista/u);
  });

  it("artista y título solos no bastan: hace falta año, pistas, sello o catálogo", () => {
    const outcome = resolveAlbumIdentity(
      { title: "Sin Sombra", year: null, artistExternalId: "mbid-1" }, [album({ year: null })]);
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.reason).toMatch(/solo coinciden artista y título/u);
  });

  it("con el año exacto la identidad se acepta", () => {
    const outcome = resolveAlbumIdentity({ title: "Sin Sombra", year: 1987, artistExternalId: "mbid-1" }, [album()]);
    expect(outcome.status).toBe("matched");
  });

  it("un año muy distinto resta y deja el caso a revisión", () => {
    const outcome = resolveAlbumIdentity({ title: "Sin Sombra", year: 1987, artistExternalId: "mbid-1" },
      [album({ year: 1995 })]);
    expect(outcome.status).not.toBe("matched");
  });
});

describe("mapeo de etiquetas externas", () => {
  const values = (...items: Array<[string, ExternalGenreValue["kind"], number?]>): ExternalGenreValue[] =>
    items.map(([value, kind, count]) => ({ value, kind, count: count ?? null }));

  it("resuelve por alias aprobado y propone lo que CRV no tiene", () => {
    const result = mapExternalValues(taxonomy, values(["Hard Rock", "editorial_genre"]), emptyState);
    expect(result.proposals.map((proposal) => proposal.genreId)).toEqual([id("hard-rock")]);
    expect(result.values[0]!.status).toBe("proposed");
  });

  it("no propone un término sin equivalencia: lo manda a revisión", () => {
    const result = mapExternalValues(taxonomy, values(["Vaporwave Andino", "editorial_genre"]), emptyState);
    expect(result.proposals).toHaveLength(0);
    expect(result.unmapped).toEqual(["Vaporwave Andino"]);
  });

  it("descarta las clases de etiqueta que la ficha no acepta", () => {
    const result = mapExternalValues(taxonomy, values(["Hard Rock", "community_tag", 9]), emptyState);
    expect(result.values[0]!.status).toBe("ignored_kind");
    expect(result.proposals).toHaveLength(0);
  });

  it("acepta etiquetas comunitarias solo con votos suficientes", () => {
    const policy = parseTagPolicy({ acceptKinds: ["editorial_genre", "community_tag"], minTagCount: 3, maxValues: 3 });
    const pocos = mapExternalValues(taxonomy, values(["Hard Rock", "community_tag", 1]), emptyState, policy);
    expect(pocos.values[0]!.status).toBe("below_min_count");
    const bastantes = mapExternalValues(taxonomy, values(["Hard Rock", "community_tag", 5]), emptyState, policy);
    expect(bastantes.values[0]!.status).toBe("proposed");
  });

  it("no repite lo que CRV ya tiene ni revive lo que rechazó", () => {
    const state: CrvGenreState = {
      primaryGenreId: id("hard-rock"), confirmedGenreIds: [id("hard-rock")],
      suggestedGenreIds: [], rejectedGenreIds: [id("pop-rock")],
    };
    const result = mapExternalValues(taxonomy, values(["Hard Rock", "editorial_genre"], ["Pop Rock", "editorial_genre"]), state);
    expect(result.proposals).toHaveLength(0);
    expect(result.values.map((value) => value.status)).toEqual(["already_known", "contradicts"]);
    expect(result.agreement).toBe("agree");
  });

  it("una etiqueta que solo dice la familia de lo ya precisado no aporta", () => {
    const state: CrvGenreState = {
      primaryGenreId: id("hard-rock"), confirmedGenreIds: [id("hard-rock")], suggestedGenreIds: [], rejectedGenreIds: [],
    };
    const result = mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), state);
    expect(result.values[0]!.status).toBe("too_generic");
    expect(result.agreement).toBe("family_agree");
  });

  it("marca el desacuerdo cuando la fuente propone algo ajeno al principal confirmado", () => {
    const state: CrvGenreState = {
      primaryGenreId: id("hard-rock"), confirmedGenreIds: [id("hard-rock")], suggestedGenreIds: [], rejectedGenreIds: [],
    };
    const result = mapExternalValues(taxonomy, values(["Salsa", "editorial_genre"]), state);
    expect(result.agreement).toBe("disagree");
    expect(result.proposals).toHaveLength(1);
  });

  // Decisión editorial de Brian del 2026-09-24: el cajón «Rock» de Discogs
  // abarca rock, metal y punk, que en CRV son familias hermanas.
  describe("cajones de la fuente", () => {
    const discogs = parseTagPolicy({
      acceptKinds: ["editorial_genre"], minTagCount: 1, maxValues: 3,
      buckets: { Rock: ["rock", "metal", "punk"] },
    });

    it("el cajón que abarca la familia del principal no es desacuerdo", () => {
      const state: CrvGenreState = {
        primaryGenreId: id("nu-metal"), confirmedGenreIds: [id("nu-metal")], suggestedGenreIds: [], rejectedGenreIds: [],
      };
      const sin = mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), state);
      expect(sin.agreement).toBe("disagree");
      const con = mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), state, discogs);
      expect(con.agreement).toBe("family_agree");
      expect(con.agreementDetail).toContain("cajón");
    });

    it("el cajón tampoco propone un género de más", () => {
      const state: CrvGenreState = {
        primaryGenreId: id("nu-metal"), confirmedGenreIds: [id("nu-metal")], suggestedGenreIds: [], rejectedGenreIds: [],
      };
      const result = mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), state, discogs);
      expect(result.values[0]!.status).toBe("too_generic");
      expect(result.proposals).toHaveLength(0);
    });

    it("cubre también al punk, que Discogs mete en el mismo cajón", () => {
      const state: CrvGenreState = {
        primaryGenreId: id("hardcore-punk"), confirmedGenreIds: [id("hardcore-punk")], suggestedGenreIds: [], rejectedGenreIds: [],
      };
      const result = mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), state, discogs);
      expect(result.agreement).toBe("family_agree");
    });

    it("el cajón no tapa un desacuerdo de verdad", () => {
      const state: CrvGenreState = {
        primaryGenreId: id("nu-metal"), confirmedGenreIds: [id("nu-metal")], suggestedGenreIds: [], rejectedGenreIds: [],
      };
      const result = mapExternalValues(taxonomy, values(["Salsa", "editorial_genre"]), state, discogs);
      expect(result.agreement).toBe("disagree");
    });

    it("un cajón sin nada confirmado dentro sigue proponiendo su género", () => {
      const result = mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), emptyState, discogs);
      expect(result.values[0]!.status).toBe("proposed");
      expect(result.proposals).toHaveLength(1);
    });

    it("una familia que no existe en la taxonomía se ignora", () => {
      const inventada = parseTagPolicy({
        acceptKinds: ["editorial_genre"], minTagCount: 1, maxValues: 3,
        buckets: { Rock: ["rock", "cumbia-sideral"] },
      });
      const state: CrvGenreState = {
        primaryGenreId: id("nu-metal"), confirmedGenreIds: [id("nu-metal")], suggestedGenreIds: [], rejectedGenreIds: [],
      };
      expect(mapExternalValues(taxonomy, values(["Rock", "editorial_genre"]), state, inventada).agreement).toBe("disagree");
    });

    it("un término ignorado por la ficha no propone ni va a revisión", () => {
      const conIgnore = parseTagPolicy({
        acceptKinds: ["editorial_genre"], minTagCount: 1, maxValues: 3, ignore: ["Latin"],
      });
      const sin = mapExternalValues(taxonomy, values(["Latin", "editorial_genre"]), emptyState);
      expect(sin.proposals).toHaveLength(1);
      const con = mapExternalValues(taxonomy, values(["Latin", "editorial_genre"]), emptyState, conIgnore);
      expect(con.values[0]!.status).toBe("ignored_value");
      expect(con.proposals).toHaveLength(0);
      expect(con.unmapped).toHaveLength(0);
    });

    it("ignorar «Latin» en Discogs no toca el alias de la taxonomía", () => {
      // La misma palabra, leída de una fuente sin esa regla, sigue resolviendo.
      const otra = mapExternalValues(taxonomy, values(["latin", "editorial_genre"]), emptyState);
      expect(otra.values[0]!.genreSlug).toBe("fusion-latina");
    });

    it("la ficha de Discogs declara el cajón «Rock» y el término ignorado", async () => {
      const sheets = await loadSheetsFile();
      const sheet = sheets.find((entry) => entry.slug === "discogs")!;
      expect(sheet.tagPolicy.buckets["rock"]).toEqual(["rock", "metal", "punk"]);
      expect(sheet.tagPolicy.ignore).toEqual(["latin"]);
      const otras = sheets.filter((entry) => entry.slug !== "discogs");
      expect(otras.every((entry) => Object.keys(entry.tagPolicy.buckets).length === 0)).toBe(true);
    });
  });

  it("respeta el tope de valores de la ficha", () => {
    const policy = parseTagPolicy({ acceptKinds: ["editorial_genre"], minTagCount: 1, maxValues: 1 });
    const result = mapExternalValues(taxonomy,
      values(["Hard Rock", "editorial_genre"], ["Pop Rock", "editorial_genre"]), emptyState, policy);
    expect(result.proposals).toHaveLength(1);
  });
});

describe("precisión de la muestra", () => {
  it("cuenta acuerdos exactos y de familia sobre lo comparable", () => {
    expect(precisionOf({ agree: 8, family_agree: 1, disagree: 1, no_reference: 30 })).toBe(0.9);
  });

  it("sin nada comparable no inventa una cifra", () => {
    expect(precisionOf({ agree: 0, family_agree: 0, disagree: 0, no_reference: 12 })).toBeNull();
  });
});

describe("adaptador de Discogs", () => {
  /** Contexto de adaptador sin red ni base: responde por URL y anota lo pedido. */
  function fakeContext(payloads: Record<string, unknown>) {
    const asked: string[] = [];
    return {
      asked,
      context: {
        fetch: async (_key: string, url: string) => {
          asked.push(url);
          const match = Object.keys(payloads).find((part) => url.includes(part));
          if (!match) throw new Error(`URL inesperada: ${url}`);
          return { url, status: 200, payload: payloads[match], fetchedAt: new Date(), cached: false };
        },
      },
    };
  }

  const payloads = {
    "database/search": { results: [{ id: 42, title: "Sentimiento Muerto", type: "artist" }] },
    "artists/42/releases": {
      releases: [
        { id: 7, type: "master", title: "Sin Sombra", year: 1987, role: "Main" },
        { id: 8, type: "release", title: "Recopilado Ajeno", year: 1999, role: "TrackAppearance" },
      ],
    },
    "artists/42": { id: 42, name: "Sentimiento Muerto", members: [{ name: "Pablo Dagnino" }] },
    "masters/7": { id: 7, genres: ["Rock"], styles: ["Post-Punk", "New Wave"] },
  };

  it("busca artistas y los completa con miembros y discografía", async () => {
    const { context, asked } = fakeContext(payloads);
    const candidates = await discogsAdapter.searchArtists(context, "Sentimiento Muerto");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ externalId: "42", name: "Sentimiento Muerto" });
    expect(candidates[0]!.memberNames).toEqual(["Pablo Dagnino"]);
    // Discogs no declara país: la identidad se apoya en discografía y miembros.
    expect(candidates[0]!.country).toBeNull();
    expect(asked.every((url) => !url.includes("token="))).toBe(true);
  });

  it("solo toma la discografía propia de la banda, no las apariciones ajenas", async () => {
    const { context } = fakeContext(payloads);
    const candidates = await discogsAdapter.albumCandidates(context, "42");
    expect(candidates.map((candidate) => candidate.externalId)).toEqual(["master:7"]);
    expect(candidates[0]).toMatchObject({ name: "Sin Sombra", year: 1987, artistExternalId: "42" });
  });

  it("ofrece primero el detalle (styles) y después lo ancho (genres)", async () => {
    const { context } = fakeContext(payloads);
    const ficha = await discogsAdapter.albumGenres(context, "master:7");
    expect(ficha.values.map((value) => value.value)).toEqual(["Post-Punk", "New Wave", "Rock"]);
    expect(ficha.values.every((value) => value.kind === "editorial_genre")).toBe(true);
  });

  it("no inventa géneros de artista: Discogs no los publica", async () => {
    const { context, asked } = fakeContext(payloads);
    const ficha = await discogsAdapter.artistGenres(context, "42");
    expect(ficha.values).toEqual([]);
    expect(asked).toEqual([]);
    expect(discogsAdapter.levels).toBe("album");
  });

  it("el token va en la cabecera, nunca en la URL, y sin token falla claro", async () => {
    process.env["DISCOGS_TOKEN"] = "secreto-de-prueba";
    resetEnvCache();
    expect(sourceAuthHeaders("discogs")).toEqual({ authorization: "Discogs token=secreto-de-prueba" });
    expect(sourceAuthHeaders("musicbrainz")).toEqual({});
    delete process.env["DISCOGS_TOKEN"];
    resetEnvCache();
    expect(() => sourceAuthHeaders("discogs")).toThrow(/DISCOGS_TOKEN/u);
  });
});

describe("fichas de evaluación", () => {
  it("el archivo del repositorio trae las fuentes evaluadas, ninguna autorizada de entrada", async () => {
    const sheets = await loadSheetsFile();
    expect(sheets.map((sheet) => sheet.slug).sort()).toEqual(["discogs", "itunes", "musicbrainz", "theaudiodb", "venciclopedia", "wikidata"]);
    expect(sheets.every((sheet) => sheet.status === "evaluating")).toBe(true);
    // Licencia, atribución, límite y cobertura: sin eso no es una evaluación.
    for (const sheet of sheets) {
      expect(sheet.license).not.toBe("");
      expect(sheet.attribution).not.toBe("");
      expect(sheet.rateLimitPerMinute).toBeGreaterThan(0);
      expect(sheet.coverageNote.length).toBeGreaterThan(20);
      expect(sheet.identifierStability.length).toBeGreaterThan(10);
    }
  });

  it("una ficha sin licencia o sin nota de acceso no se carga", () => {
    expect(() => parseSheet({ slug: "x", name: "X", accessMode: "api", levels: "both" })).toThrow(/accessNote/u);
  });

  it("MusicBrainz y Discogs tienen adaptador; Wikidata espera código", async () => {
    const { adapterFor } = await import("../../src/genres/external/adapters.js");
    expect(adapterFor("musicbrainz")).toBe(musicbrainzAdapter);
    expect(adapterFor("discogs")).toBe(discogsAdapter);
    expect(adapterFor("wikidata")).toBeUndefined();
  });

  it("cada ficha declara el nivel que su fuente publica de verdad", async () => {
    const sheets = await loadSheetsFile();
    const bySlug = new Map(sheets.map((sheet) => [sheet.slug, sheet]));
    // Discogs no publica géneros de artista; Wikidata casi solo de artista.
    expect(bySlug.get("discogs")!.levels).toBe("album");
    expect(bySlug.get("musicbrainz")!.levels).toBe("both");
    for (const slug of ["musicbrainz", "discogs"]) {
      const adapter = (await import("../../src/genres/external/adapters.js")).adapterFor(slug)!;
      expect(adapter.levels).toBe(bySlug.get(slug)!.levels);
    }
  });
});
