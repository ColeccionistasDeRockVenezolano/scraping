// CRV · Filtros por género de las listas de discos y artistas contra Postgres
// real: conteos de familias y subgéneros (/genres/facets), «sin género» y la
// ampliación de discos por el género de su artista, que solo suma discos sin
// género propio y nunca asigna nada.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { applyTaxonomyOperations, planTaxonomyFile } from "../../src/genres/admin.js";

interface Facet { slug: string; name: string; count: number; relatedCount: number }
interface Facets { total: number; withoutGenre: number; families: Array<Facet & { genres: Facet[] }> }
interface ListPage { data: Array<{ id: number; hasOwnGenre?: boolean; primaryGenre: { slug: string } | null }>; pagination: { total: number } }

describe("API: filtros por género y subgénero en discos y artistas", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  const ids: Record<string, number> = {};

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);

  async function assign(kind: "album" | "artist", entityId: number, slug: string, role: "primary" | "secondary", status = "confirmed") {
    await getPool().query(`
      INSERT INTO ingest.${kind}_genres(${kind}_id, genre_id, role, status, source_kind, decided_by, decision_rule, decision_kind)
      SELECT $1, id, $3, $4, 'editorial', 'prueba', 'prueba', 'human' FROM ingest.genres WHERE slug = $2`,
    [entityId, slug, role, status]);
  }

  const get = async <T>(url: string): Promise<T> => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode, url).toBe(200);
    return response.json() as T;
  };
  const listIds = (page: ListPage) => page.data.map((row) => row.id).sort((a, b) => a - b);
  const sorted = (...values: number[]) => [...values].sort((a, b) => a - b);

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "taxonomía aprobada" }, { confirm: true });

    const artist = (name: string) => one("INSERT INTO public.artists(name) VALUES($1) RETURNING id", [name]);
    const album = (artistId: number, title: string) =>
      one("INSERT INTO public.albums(artist_id, title) VALUES($1, $2) RETURNING id", [artistId, title]);

    ids["metalBand"] = await artist("Banda Thrash");
    ids["rockBand"] = await artist("Banda Rock");
    ids["noGenreWithAlbums"] = await artist("Banda Sin Género Con Discos");
    ids["empty"] = await artist("Banda Vacía");
    await assign("artist", ids["metalBand"], "thrash-metal", "primary");
    await assign("artist", ids["rockBand"], "rock", "primary");

    ids["thrashAlbum"] = await album(ids["metalBand"], "Disco Thrash");
    ids["bareMetalAlbum"] = await album(ids["metalBand"], "Disco sin género de banda thrash");
    ids["rockAlbum"] = await album(ids["rockBand"], "Disco Hard Rock");
    ids["deathAlbum"] = await album(ids["noGenreWithAlbums"], "Disco Death");
    ids["bareAlbum"] = await album(ids["empty"], "Disco sin nada");
    ids["suggestedAlbum"] = await album(ids["empty"], "Disco con sugerencia");
    await assign("album", ids["thrashAlbum"], "thrash-metal", "primary");
    await assign("album", ids["rockAlbum"], "hard-rock", "primary");
    await assign("album", ids["deathAlbum"], "death-metal", "primary");
    // Una sugerencia no es un género: el disco sigue contando como «sin género».
    await assign("album", ids["suggestedAlbum"], "heavy-metal", "secondary", "suggested");

    app = await buildApp();
  }, 180_000);

  afterAll(async () => { await app?.close(); await closeDb(); await container?.stop(); }, 60_000);

  it("los conteos de discos agrupan subgéneros en su familia y separan lo que entra por el artista", async () => {
    const facets = await get<Facets>("/genres/facets?kind=album");
    expect(facets.total).toBe(6);
    expect(facets.withoutGenre).toBe(3);
    const metal = facets.families.find((family) => family.slug === "metal")!;
    expect(metal).toMatchObject({ count: 2, relatedCount: 1 });
    expect(metal.genres.find((genre) => genre.slug === "thrash-metal")).toMatchObject({ count: 1, relatedCount: 1 });
    expect(metal.genres.find((genre) => genre.slug === "death-metal")).toMatchObject({ count: 1, relatedCount: 0 });
    // Sin fichas, ni la familia ni el subgénero se ofrecen.
    expect(metal.genres.find((genre) => genre.slug === "heavy-metal")).toBeUndefined();
    expect(facets.families.find((family) => family.slug === "jazz")).toBeUndefined();
    // La familia va primero cuando tiene más fichas.
    expect(facets.families[0]!.slug).toBe("metal");
    expect(facets.families.find((family) => family.slug === "rock")).toMatchObject({ count: 1, relatedCount: 0 });
  });

  it("filtra discos por familia, por subgénero, sin género y sumando por el género del artista", async () => {
    expect(listIds(await get<ListPage>("/albums?genre=metal"))).toEqual(sorted(ids["thrashAlbum"]!, ids["deathAlbum"]!));
    expect(listIds(await get<ListPage>("/albums?genre=thrash-metal"))).toEqual([ids["thrashAlbum"]]);

    const widened = await get<ListPage>("/albums?genre=thrash-metal&relatedGenre=true");
    expect(listIds(widened)).toEqual(sorted(ids["thrashAlbum"]!, ids["bareMetalAlbum"]!));
    expect(widened.data.find((row) => row.id === ids["bareMetalAlbum"])).toMatchObject({ hasOwnGenre: false, primaryGenre: null });
    expect(widened.data.find((row) => row.id === ids["thrashAlbum"])).toMatchObject({ hasOwnGenre: true });
    expect((await get<ListPage>("/albums?genre=metal&relatedGenre=true")).pagination.total).toBe(3);

    const without = await get<ListPage>("/albums?withoutGenre=true");
    expect(listIds(without)).toEqual(sorted(ids["bareMetalAlbum"]!, ids["bareAlbum"]!, ids["suggestedAlbum"]!));
    expect(without.pagination.total).toBe(3);
    // Combinado con el título sigue siendo un filtro más.
    expect(listIds(await get<ListPage>("/albums?withoutGenre=true&q=nada"))).toEqual([ids["bareAlbum"]]);
    // `relatedGenre` sin `genre` no cambia nada.
    expect((await get<ListPage>("/albums?relatedGenre=true")).pagination.total).toBe(6);
  });

  it("filtra artistas por su género, que incluye el que reciben de sus discos (0036)", async () => {
    const facets = await get<Facets>("/genres/facets?kind=artist");
    // «Banda Vacía» solo tiene un disco sin género y otro con una sugerencia: sigue sin género.
    expect(facets).toMatchObject({ total: 4, withoutGenre: 1 });
    expect(facets.families.find((family) => family.slug === "metal")).toMatchObject({ count: 2, relatedCount: 0 });

    const metal = await get<ListPage>("/artists?genre=metal");
    expect(listIds(metal)).toEqual(sorted(ids["metalBand"]!, ids["noGenreWithAlbums"]!));
    expect(metal.data.find((row) => row.id === ids["noGenreWithAlbums"])).toMatchObject({ primaryGenre: { slug: "death-metal" } });
    // Complemento: la banda de rock suma el hard rock de su disco sin perder su principal.
    const rock = await get<ListPage>("/artists?genre=hard-rock");
    expect(rock.data).toEqual([expect.objectContaining({ id: ids["rockBand"], primaryGenre: expect.objectContaining({ slug: "rock" }) })]);
    expect(listIds(await get<ListPage>("/artists?withoutGenre=true"))).toEqual([ids["empty"]]);
  });

  it("rechaza valores inválidos en los filtros", async () => {
    for (const url of ["/albums?withoutGenre=si", "/albums?relatedGenre=1", "/albums?genre=No%20Slug", "/genres/facets?kind=track"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
  });
});
