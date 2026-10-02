// CRV · Géneros que el artista recibe de sus discos (0036) contra Postgres
// real: complemento autoajustable, principal por frecuencia y fecha, familias
// redundantes, Various Artists, Laya, decisiones humanas, cambios de disco
// (borrar, mover de artista), deshacer con el diario y reconciliación.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { applyTaxonomyOperations, planTaxonomyFile } from "../../src/genres/admin.js";
import { confirmGenre, rejectGenre } from "../../src/genres/human.js";
import { lockGenres } from "../../src/genres/store.js";
import { layaDecidedIds } from "../../src/genres/public.js";
import { derivedDrift, runDeriveArtistGenres } from "../../src/genres/derived.js";
import { withOperatorRun } from "../../src/merge/operator.js";
import { undoRunWithJournal } from "../../src/merge/journal-undo.js";

interface ArtistGenreRow { slug: string; role: string; status: string; source_kind: string; decision_kind: string; decision_rule: string }

describe("géneros: el artista suma los de sus discos (0036)", () => {
  let container: PgContainer;

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const artist = (name: string) => one("INSERT INTO public.artists(name) VALUES($1) RETURNING id", [name]);
  const album = (artistId: number, title: string, year: number | null = null) =>
    one("INSERT INTO public.albums(artist_id, title, release_year) VALUES($1, $2, $3) RETURNING id", [artistId, title, year]);

  async function albumGenre(albumId: number, slug: string, role: "primary" | "secondary", decidedBy = "prueba") {
    await getPool().query(`
      INSERT INTO ingest.album_genres(album_id, genre_id, role, status, source_kind, decided_by, decision_rule, decision_kind)
      SELECT $1, id, $3, 'confirmed', 'editorial', $4, 'prueba', 'human' FROM ingest.genres WHERE slug = $2`,
    [albumId, slug, role, decidedBy]);
  }
  async function ownArtistGenre(artistId: number, slug: string, role: "primary" | "secondary") {
    await getPool().query(`
      INSERT INTO ingest.artist_genres(artist_id, genre_id, role, status, source_kind, decided_by, decision_rule, decision_kind)
      SELECT $1, id, $3, 'confirmed', 'editorial', 'prueba', 'prueba', 'human' FROM ingest.genres WHERE slug = $2`,
    [artistId, slug, role]);
  }
  const removeAlbumGenre = (albumId: number, slug: string) => getPool().query(
    "DELETE FROM ingest.album_genres WHERE album_id = $1 AND genre_id = (SELECT id FROM ingest.genres WHERE slug = $2)", [albumId, slug]);

  const genresOf = async (artistId: number): Promise<ArtistGenreRow[]> => (await getPool().query<ArtistGenreRow>(`
    SELECT g.slug, x.role, x.status, x.source_kind, x.decision_kind, x.decision_rule
      FROM ingest.artist_genres x JOIN ingest.genres g ON g.id = x.genre_id
     WHERE x.artist_id = $1 ORDER BY (x.role = 'primary') DESC, g.slug`, [artistId])).rows;
  /** Lo que el artista recibe de sus discos, como «slug» o «slug*» si es el principal. */
  const derived = async (artistId: number) => (await genresOf(artistId))
    .filter((row) => row.source_kind === "albums" && row.decision_kind === "rule")
    .map((row) => `${row.slug}${row.role === "primary" ? "*" : ""}`);

  async function asHuman(work: (client: PoolClient) => Promise<unknown>) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await lockGenres(client);
      await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "taxonomía aprobada" }, { confirm: true });
  }, 180_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("un artista sin género recibe los de sus discos; el principal es el más frecuente", async () => {
    const band = await artist("Banda de Discos");
    const a = await album(band, "Uno", 2010);
    const b = await album(band, "Dos", 2012);
    const c = await album(band, "Tres", 2020);
    await albumGenre(a, "thrash-metal", "primary");
    await albumGenre(b, "thrash-metal", "primary");
    await albumGenre(c, "death-metal", "primary");
    await albumGenre(c, "heavy-metal", "secondary");
    expect(await derived(band)).toEqual(["thrash-metal*", "death-metal", "heavy-metal"]);
    const [row] = (await genresOf(band));
    expect(row).toMatchObject({ status: "confirmed", decision_rule: "de_sus_discos" });

    // Autoajustable: el disco pierde un género que ningún otro tiene → el artista lo pierde.
    await removeAlbumGenre(c, "heavy-metal");
    expect(await derived(band)).toEqual(["thrash-metal*", "death-metal"]);
    // Uno que otro disco conserva se queda.
    await removeAlbumGenre(a, "thrash-metal");
    // Empate 1–1 en principales: gana el disco más reciente (2020, death metal).
    expect(await derived(band)).toEqual(["death-metal*", "thrash-metal"]);
    expect(await getPool().query("SELECT 1 FROM ingest.artist_genres_pending")).toMatchObject({ rowCount: 0 });
  });

  it("en empate de principales gana el disco más reciente", async () => {
    const band = await artist("Banda Empate");
    await albumGenre(await album(band, "Viejo", 1998), "punk-rock", "primary");
    await albumGenre(await album(band, "Nuevo", 2015), "ska", "primary");
    expect(await derived(band)).toEqual(["ska*", "punk-rock"]);
  });

  it("con género propio es complemento: el principal propio se respeta y lo propio no se duplica", async () => {
    const band = await artist("Banda con Género");
    await ownArtistGenre(band, "rock", "primary");
    await ownArtistGenre(band, "hard-rock", "secondary");
    const x = await album(band, "Disco", 2001);
    await albumGenre(x, "hard-rock", "primary");
    await albumGenre(x, "blues-rock", "secondary");
    expect(await derived(band)).toEqual(["blues-rock"]);
    expect((await genresOf(band)).find((row) => row.slug === "rock")).toMatchObject({ role: "primary", source_kind: "editorial" });
  });

  it("una familia no se deriva si hay un subgénero suyo", async () => {
    const band = await artist("Banda Familia");
    await albumGenre(await album(band, "Familia"), "metal", "primary");
    await albumGenre(await album(band, "Hijo"), "death-metal", "primary");
    expect(await derived(band)).toEqual(["death-metal*"]);
  });

  it("Various Artists no recibe géneros de sus recopilatorios", async () => {
    const various = await artist("Various Artists");
    await albumGenre(await album(various, "Recopilatorio"), "rock", "primary");
    expect(await genresOf(various)).toEqual([]);
  });

  it("los géneros de disco elegidos por Laya pasan y marcan al artista", async () => {
    const band = await artist("Banda Laya");
    await albumGenre(await album(band, "Por Laya"), "pop-rock", "primary", "auto:laya");
    expect((await genresOf(band))[0]).toMatchObject({ slug: "pop-rock", role: "primary", decision_rule: "de_sus_discos_laya" });
    expect((await layaDecidedIds("artist", [band])).has(band)).toBe(true);
    // Si otro disco con fuente lo confirma, deja de ser solo de Laya.
    await albumGenre(await album(band, "Con fuente"), "pop-rock", "primary");
    expect((await genresOf(band))[0]).toMatchObject({ decision_rule: "de_sus_discos" });
    expect((await layaDecidedIds("artist", [band])).has(band)).toBe(false);
  });

  it("borrar un disco o pasarlo a otro artista recalcula a los dos", async () => {
    const first = await artist("Banda Origen");
    const second = await artist("Banda Destino");
    const moving = await album(first, "Viajero");
    await albumGenre(moving, "grunge", "primary");
    expect(await derived(first)).toEqual(["grunge*"]);
    await getPool().query("UPDATE public.albums SET artist_id = $2 WHERE id = $1", [moving, second]);
    expect(await derived(first)).toEqual([]);
    expect(await derived(second)).toEqual(["grunge*"]);
    // Retirar un disco: el core no borra en cascada sus géneros; la app los
    // quita en la misma transacción que el disco.
    await asHuman(async (client) => {
      await client.query("DELETE FROM ingest.album_genres WHERE album_id = $1", [moving]);
      await client.query("DELETE FROM public.albums WHERE id = $1", [moving]);
    });
    expect(await derived(second)).toEqual([]);
  });

  it("una persona manda: un rechazo no se vuelve a derivar y una confirmación se queda aunque el disco lo pierda", async () => {
    const band = await artist("Banda Humana");
    const x = await album(band, "Disco");
    await albumGenre(x, "reggae", "primary");
    await albumGenre(x, "ska", "secondary");
    expect(await derived(band)).toEqual(["reggae*", "ska"]);

    await asHuman((client) => rejectGenre(client, { kind: "artist", entityId: band, genreSlug: "ska", actor: "prueba", reason: "no es ska" }));
    expect(await derived(band)).toEqual(["reggae*"]);
    expect((await genresOf(band)).find((row) => row.slug === "ska")).toMatchObject({ status: "rejected", decision_kind: "human" });

    // Confirmar como propio un principal distinto: el derivado cede sin chocar con el índice único.
    await asHuman((client) => confirmGenre(client, { kind: "artist", entityId: band, genreSlug: "rocksteady", actor: "prueba", reason: "propio", role: "primary" }));
    expect(await derived(band)).toEqual(["reggae"]);
    expect((await genresOf(band))[0]).toMatchObject({ slug: "rocksteady", role: "primary", decision_kind: "human" });

    // Confirmar el derivado lo vuelve humano: ya no depende del disco.
    await asHuman((client) => confirmGenre(client, { kind: "artist", entityId: band, genreSlug: "reggae", actor: "prueba", reason: "propio", role: "secondary" }));
    await removeAlbumGenre(x, "reggae");
    expect((await genresOf(band)).find((row) => row.slug === "reggae")).toMatchObject({ status: "confirmed", decision_kind: "human" });
  });

  it("deshacer un run devuelve lo que el artista tenía por sus discos", async () => {
    const band = await artist("Banda Diario");
    const x = await album(band, "Disco");
    await albumGenre(x, "nu-metal", "primary");
    expect(await derived(band)).toEqual(["nu-metal*"]);

    const { runId } = await withOperatorRun({ name: "prueba:quitar-genero", operator: "prueba", note: "quitar género" },
      async ({ client }) => client.query(
        "DELETE FROM ingest.album_genres WHERE album_id = $1", [x]));
    expect(await derived(band)).toEqual([]);
    const changed = await getPool().query("SELECT 1 FROM ingest.change_journal WHERE run_id = $1 AND table_name = 'ingest.artist_genres'", [runId]);
    expect(changed.rowCount).toBe(1);

    await withOperatorRun({ name: "prueba:deshacer", operator: "prueba", note: "deshacer" },
      (context) => undoRunWithJournal(context, runId));
    expect(await derived(band)).toEqual(["nu-metal*"]);
  });

  it("con la regla apagada nada se recalcula; la reconciliación y doctor lo arreglan", async () => {
    const band = await artist("Banda Mantenimiento");
    const x = await album(band, "Disco");
    await asHuman(async (client) => {
      await client.query("SELECT set_config('crv.artist_genres_from_albums', 'off', true)");
      await client.query(`
        INSERT INTO ingest.album_genres(album_id, genre_id, role, status, source_kind, decided_by, decision_rule, decision_kind)
        SELECT $1, id, 'primary', 'confirmed', 'editorial', 'prueba', 'prueba', 'human' FROM ingest.genres WHERE slug = 'shoegaze'`, [x]);
    });
    expect(await derived(band)).toEqual([]);
    expect(await derivedDrift(getPool())).toEqual([band]);

    const dry = await runDeriveArtistGenres({ confirm: false, actor: "prueba" });
    expect(dry).toMatchObject({ mode: "dry-run", artistsChanged: 1 });
    expect(await derived(band)).toEqual([]);
    const done = await runDeriveArtistGenres({ confirm: true, actor: "prueba" });
    expect(done).toMatchObject({ mode: "confirm", artistsChanged: 1, rowsChanged: 1 });
    expect(await derived(band)).toEqual(["shoegaze*"]);
    expect(await derivedDrift(getPool())).toEqual([]);
  });

  it("la migración se revierte (sin filas derivadas ni disparadores) y se vuelve a aplicar", async () => {
    await getPool().query("DELETE FROM ingest.schema_migrations WHERE version = '0036_artist_genres_from_albums'");
    await getPool().query(await readFile(path.resolve("migrations", "0036_artist_genres_from_albums.down.sql"), "utf8"));
    const left = await getPool().query("SELECT 1 FROM ingest.artist_genres WHERE source_kind = 'albums'");
    expect(left.rowCount).toBe(0);
    const triggers = await getPool().query("SELECT 1 FROM pg_trigger WHERE tgname = 'crv_artist_genres_from_albums'");
    expect(triggers.rowCount).toBe(0);
    await migrateUp();
    await runDeriveArtistGenres({ confirm: true, actor: "prueba" });
    expect(await derivedDrift(getPool())).toEqual([]);
  });
});
