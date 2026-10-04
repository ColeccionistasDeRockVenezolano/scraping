// CRV · Artistas relacionados y similares por reglas (2026-10-04) contra
// Postgres real: orden de las reglas, un artista una sola vez, los
// relacionados no se repiten en similares, el músico de sesión que aparece
// en más de 15 artistas no une nada y «Various Artists» nunca es vecino.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { applyTaxonomyOperations, planTaxonomyFile } from "../../src/genres/admin.js";

interface Detail {
  related: Array<{ id: number; rule: string; sharedMembers: number; bridges: Array<{ person: string | null; album: string | null }> }>;
  similar: Array<{ id: number; rule: string; evidence: string[] }>;
}

describe("API: artistas relacionados y similares por reglas", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  const ids: Record<string, number> = {};

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const artist = (name: string, formedYear: number | null = null, artistType = "band") =>
    one("INSERT INTO public.artists(name, formed_year, artist_type, origin_city) VALUES($1, $2, $3, 'Caracas') RETURNING id", [name, formedYear, artistType]);
  const album = (artistId: number, title: string, albumType = "studio_album") =>
    one("INSERT INTO public.albums(artist_id, title, album_type) VALUES($1, $2, $3) RETURNING id", [artistId, title, albumType]);
  const person = (name: string) => one("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [name]);
  const member = (artistId: number, personId: number, role = "Integrante") =>
    getPool().query("INSERT INTO public.artist_members(artist_id, person_id, role) VALUES($1, $2, $3)", [artistId, personId, role]);
  const credit = (albumId: number, who: { personId?: number; artistId?: number }, creditType = "musician") =>
    getPool().query("INSERT INTO public.album_credits(album_id, person_id, artist_id, credit_type, role) VALUES($1, $2, $3, $4, $5)",
      [albumId, who.personId ?? null, who.artistId ?? null, creditType, creditType]);
  async function genre(artistId: number, slug: string) {
    await getPool().query(`
      INSERT INTO ingest.artist_genres(artist_id, genre_id, role, status, source_kind, decided_by, decision_rule, decision_kind)
      SELECT $1, id, 'primary', 'confirmed', 'editorial', 'prueba', 'prueba', 'human' FROM ingest.genres WHERE slug = $2`, [artistId, slug]);
  }

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "taxonomía aprobada" }, { confirm: true });

    ids["a"] = await artist("Banda A", 1990);
    const discoA = await album(ids["a"], "Disco A");
    await genre(ids["a"], "thrash-metal");

    // R2: dos integrantes en común (y mismo estilo: no debe repetirse en similares).
    ids["b"] = await artist("Banda B", 1991);
    await genre(ids["b"], "thrash-metal");
    for (const name of ["Uno", "Dos"]) {
      const id = await person(name);
      await member(ids["a"], id);
      await member(ids["b"], id);
    }
    // R3: el titular de un proyecto solista es integrante de A.
    ids["c"] = await artist("Solista C", null, "solo_artist");
    const tres = await person("Tres");
    await member(ids["a"], tres);
    await member(ids["c"], tres, "Titular del proyecto");
    // R6: un integrante de D tocó en un disco de A.
    ids["d"] = await artist("Banda D");
    const cuatro = await person("Cuatro");
    await member(ids["d"], cuatro);
    await credit(discoA, { personId: cuatro });
    // R5: E acreditado como artista en un disco de A.
    ids["e"] = await artist("Banda E");
    await credit(discoA, { artistId: ids["e"] }, "guest");
    // Músico de sesión de F que toca en A y en 15 artistas más: no une nada.
    ids["f"] = await artist("Banda F");
    const sesion = await person("Sesión");
    await member(ids["f"], sesion);
    await credit(discoA, { personId: sesion });
    for (let i = 1; i <= 15; i++) await credit(await album(await artist(`Cliente ${i}`), `Disco Cliente ${i}`), { personId: sesion });

    // Similares.
    ids["g"] = await artist("Banda G", 1992);
    await genre(ids["g"], "thrash-metal");
    ids["h"] = await artist("Banda H", 1995);
    await genre(ids["h"], "death-metal");
    ids["i"] = await artist("Banda I", 1975);
    await genre(ids["i"], "thrash-metal");
    ids["j"] = await artist("Banda J", 2003);
    await genre(ids["j"], "thrash-metal");
    // S3: A y H en una recopilación de Various Artists (que tampoco cuenta como colaboración).
    ids["va"] = await artist("Various Artists");
    await genre(ids["va"], "thrash-metal");
    const recopilacion = await album(ids["va"], "Recopilación Metal", "compilation");
    for (const [n, who] of [[1, ids["a"]], [2, ids["h"]]] as const) {
      const track = await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES($1, 1, $2, $3) RETURNING id",
        [recopilacion, n, `Tema ${n}`]);
      await getPool().query("INSERT INTO public.track_credits(track_id, artist_id, credit_type, role) VALUES($1, $2, 'musician', 'Intérprete')", [track, who]);
    }

    app = await buildApp();
  }, 180_000);

  afterAll(async () => { await app?.close(); await closeDb(); await container?.stop(); }, 60_000);

  it("ordena los relacionados por regla y descarta al músico de sesión y a Various Artists", async () => {
    const detail = (await app.inject({ method: "GET", url: `/artists/${ids["a"]}` })).json() as Detail;
    expect(detail.related.map((item) => [item.id, item.rule])).toEqual([
      [ids["b"], "shared_members"],
      [ids["c"], "solo_project"],
      [ids["e"], "collaboration"],
      [ids["d"], "guest_member"],
    ]);
    expect(detail.related.find((item) => item.id === ids["d"])!.bridges).toEqual([{ person: "Cuatro", album: "Disco A" }]);
    expect(detail.related.find((item) => item.id === ids["e"])!.bridges).toEqual([{ person: null, album: "Disco A" }]);
  });

  it("ordena los similares por regla sin repetir relacionados", async () => {
    const detail = (await app.inject({ method: "GET", url: `/artists/${ids["a"]}` })).json() as Detail;
    expect(detail.similar.map((item) => [item.id, item.rule])).toEqual([
      [ids["g"], "same_style"],
      [ids["h"], "same_compilation"],
      [ids["j"], "near_decade"],
      [ids["i"], "same_genre"],
    ]);
    expect(detail.similar.find((item) => item.id === ids["h"])!.evidence).toEqual(["Recopilación Metal"]);
  });

  it("Various Artists no tiene vecinos", async () => {
    const detail = (await app.inject({ method: "GET", url: `/artists/${ids["va"]}` })).json() as Detail;
    expect(detail.related).toEqual([]);
    expect(detail.similar).toEqual([]);
  });
});
