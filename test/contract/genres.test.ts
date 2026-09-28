// CRV · PLAN_GENEROS etapa 2 contra Postgres real: taxonomía aprobada,
// backfill reproducible, proyección `albums.genre`, prioridad humana,
// fusión y reversión de discos, cambios de alias acotados, interruptor
// GENRES_PROJECTION_ENABLED y migración reversible.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateDownAll, migrateUp } from "../../src/db/migrate.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim, type ClaimToPersist } from "../../src/claims/persistence.js";
import { mergeClaim } from "../../src/merge/engine.js";
import { applyTaxonomyOperations, planTaxonomyFile } from "../../src/genres/admin.js";
import { runGenreBackfill } from "../../src/genres/backfill.js";
import { confirmGenre } from "../../src/genres/human.js";
import { lockGenres } from "../../src/genres/store.js";
import { withOperatorRun } from "../../src/merge/operator.js";
import { mergeAlbums, previewAlbumMerge } from "../../src/merge/album-merge.js";
import { undoMergeRun } from "../../src/merge/unmerge.js";
import { getAlbumDetail } from "../../src/api/repositories/albums.js";
import { runDoctor } from "../../src/doctor/index.js";

describe("géneros: taxonomía, backfill, proyección y fusiones (PLAN_GENEROS etapa 2)", () => {
  let container: PgContainer;
  let artist: number;
  let high: number;
  let medium: number;
  let evidence = 0;
  const albums: Record<string, number> = {};

  const pool = () => getPool();
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await pool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool().query(sql, params)).rows as T[];

  function setProjection(enabled: boolean): void {
    process.env["GENRES_PROJECTION_ENABLED"] = enabled ? "true" : "false";
    resetEnvCache();
  }

  async function album(title: string): Promise<number> {
    const id = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,$2) RETURNING id", [artist, title]);
    albums[title] = id;
    return id;
  }

  /** Claim `genre` de una fuente, pasado por el motor igual que en una ingesta. */
  async function genreClaim(sourceId: number, albumId: number, value: string) {
    evidence += 1;
    const normalized = normalizeRecord({
      entityKind: "album", identity: `Generos QA::disco ${albumId}`, extractor: "genres-fixture", extractorVersion: "1",
      fields: [{ field: "genre", value, evidence: { url: `https://fixture.invalid/genres/${evidence}` } }],
    })[0]!;
    const input: ClaimToPersist = { ...normalized, sourceId, confidence: "high", albumId };
    const persisted = await persistClaim(input);
    return mergeClaim(input, persisted);
  }

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await lockGenres(client);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const assignments = (albumId: number) => rows<{ slug: string; role: string; status: string; decision_kind: string }>(`
    SELECT g.slug, ag.role, ag.status, ag.decision_kind FROM ingest.album_genres ag JOIN ingest.genres g ON g.id = ag.genre_id
     WHERE ag.album_id = $1 ORDER BY g.slug`, [albumId]);
  const albumGenre = async (albumId: number) =>
    (await rows<{ genre: string | null }>("SELECT genre FROM public.albums WHERE id=$1", [albumId]))[0]!.genre;
  const genreName = async (slug: string) => (await rows<{ name: string }>("SELECT name FROM ingest.genres WHERE slug=$1", [slug]))[0]!.name;
  /** Filas de géneros de todo el catálogo sin los sellos de tiempo. */
  const allRows = () => rows(`
    SELECT to_jsonb(x) - 'updated_at' - 'created_at' - 'decided_at' AS row FROM (
      SELECT 'album' AS kind, album_id AS entity_id, * FROM ingest.album_genres
      UNION ALL SELECT 'artist', artist_id, * FROM ingest.artist_genres
    ) x ORDER BY kind, id`);

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    setProjection(false);
    await applyCore(container.name);
    await migrateUp();
    artist = await one("INSERT INTO public.artists(name) VALUES('Banda Géneros QA') RETURNING id");
    high = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('generos-alta','Géneros alta','website','high',true) RETURNING id");
    medium = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('generos-media','Géneros media','blogspot','medium',true) RETURNING id");

    // Con la proyección apagada el motor escribe `albums.genre` como siempre.
    await genreClaim(high, await album("Acuerdo"), "Hard Rock");
    await genreClaim(medium, albums["Acuerdo"]!, "Rock duro");
    await genreClaim(high, await album("Solo familia"), "Rock");
    await genreClaim(high, await album("Pop guion"), "Pop-Rock");
    await genreClaim(high, await album("Rock guion"), "Rock-Pop");
    await genreClaim(high, await album("Melódico"), "Melodic Death Metal");
    await genreClaim(high, await album("Desacuerdo"), "Jazz");
    await genreClaim(medium, albums["Desacuerdo"]!, "Thrash Metal");
    await genreClaim(high, await album("Alias regla"), "Rock duro");
    await genreClaim(high, await album("Alias humano"), "Rock duro");
    await album("Sin género");

    const report = await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "taxonomía aprobada" }, { confirm: true });
    expect(report.mode).toBe("confirm");
  }, 180_000);

  afterAll(async () => {
    setProjection(false);
    await closeDb();
    await container?.stop();
  }, 60_000);

  it("la taxonomía queda en dos niveles con slugs estables y es idempotente", async () => {
    const [counts] = await rows<{ families: string; genres: string; orphans: string }>(`
      SELECT count(*) FILTER (WHERE level='family')::text AS families,
             count(*) FILTER (WHERE level='genre')::text AS genres,
             count(*) FILTER (WHERE level='genre' AND parent_genre_id IS NULL)::text AS orphans
        FROM ingest.genres`);
    expect(Number(counts!.families)).toBe(16);
    expect(Number(counts!.genres)).toBeGreaterThan(80);
    expect(Number(counts!.orphans)).toBe(0);
    expect(await planTaxonomyFile()).toEqual([]);
    const logged = await rows("SELECT 1 FROM ingest.genre_taxonomy_changes WHERE actor='prueba'");
    expect(logged.length).toBeGreaterThan(0);
  });

  it("el backfill aplica las reglas, es reproducible y no toca albums.genre con la proyección apagada", async () => {
    const before = await rows("SELECT id, genre FROM public.albums ORDER BY id");
    // La carga de la taxonomía ya recalculó lo que sus alias tocan; el
    // backfill completa el resto.
    await runGenreBackfill({ confirm: true, actor: "prueba" });
    expect(await rows("SELECT id, genre FROM public.albums ORDER BY id")).toEqual(before);

    expect(await assignments(albums["Acuerdo"]!)).toEqual([{ slug: "hard-rock", role: "primary", status: "confirmed", decision_kind: "rule" }]);
    expect(await assignments(albums["Solo familia"]!)).toEqual([{ slug: "rock", role: "primary", status: "confirmed", decision_kind: "rule" }]);
    expect(await assignments(albums["Pop guion"]!)).toEqual(await assignments(albums["Rock guion"]!));
    expect((await assignments(albums["Pop guion"]!)).map((row) => row.slug)).toEqual(["pop-rock"]);
    expect((await assignments(albums["Melódico"]!)).map((row) => row.slug)).toEqual(["death-metal-melodico"]);
    const disagreement = await assignments(albums["Desacuerdo"]!);
    expect(disagreement.every((row) => row.status === "suggested" && row.role === "secondary")).toBe(true);
    const cases = await rows<{ genre_case: string }>(
      "SELECT payload->>'genreCase' AS genre_case FROM ingest.review_queue WHERE album_id=$1 AND payload->>'origin'='genres' AND status='open'",
      [albums["Desacuerdo"]!]);
    expect(cases.map((row) => row.genre_case)).toEqual(["source_disagreement"]);

    const snapshot = await allRows();
    const reviews = await rows("SELECT id FROM ingest.review_queue ORDER BY id");
    const second = await runGenreBackfill({ confirm: true, actor: "prueba" });
    expect(second.writes).toMatchObject({ inserted: 0, updated: 0, deleted: 0, reviewsOpened: 0, reviewsClosed: 0 });
    expect(await allRows()).toEqual(snapshot);
    expect(await rows("SELECT id FROM ingest.review_queue ORDER BY id")).toEqual(reviews);

    const dry = await runGenreBackfill({ confirm: false, actor: "prueba" });
    expect(dry.mode).toBe("dry-run");
    expect(await allRows()).toEqual(snapshot);
  });

  it("con la proyección encendida albums.genre sigue al principal o al texto de la fuente de mayor rango", async () => {
    setProjection(true);
    const notNullBefore = (await rows("SELECT 1 FROM public.albums WHERE genre IS NOT NULL")).length;
    const report = await runGenreBackfill({ confirm: true, actor: "prueba" });
    expect(report.projectionEnabled).toBe(true);
    expect(await albumGenre(albums["Acuerdo"]!)).toBe(await genreName("hard-rock"));
    expect(await albumGenre(albums["Solo familia"]!)).toBe(await genreName("rock"));
    // Sin principal: el texto literal de la fuente de mayor rango, marcado pendiente.
    expect(await albumGenre(albums["Desacuerdo"]!)).toBe("Jazz");
    expect((await getAlbumDetail(albums["Desacuerdo"]!))!.genreStatus).toBe("pending");
    expect((await getAlbumDetail(albums["Acuerdo"]!))!.genreStatus).toBe("confirmed");
    expect((await getAlbumDetail(albums["Sin género"]!))!.genreStatus).toBe("unclassified");
    expect((await rows("SELECT 1 FROM public.albums WHERE genre IS NOT NULL")).length).toBeGreaterThanOrEqual(notNullBefore);

    // Un disco nuevo: el motor ya no escribe la columna, la escribe la proyección.
    const fresh = await album("Nuevo desconocido");
    await genreClaim(high, fresh, "Zorro Gaita");
    expect(await albumGenre(fresh)).toBe("Zorro Gaita");
    expect((await getAlbumDetail(fresh))!.genreStatus).toBe("pending");
    const known = await album("Nuevo conocido");
    await genreClaim(high, known, "Heavy Metal");
    expect(await assignments(known)).toEqual([{ slug: "heavy-metal", role: "primary", status: "confirmed", decision_kind: "rule" }]);
    expect(await albumGenre(known)).toBe(await genreName("heavy-metal"));

    const doctor = await runDoctor();
    expect(doctor.checks.find((item) => item.name === "genres.assignments")).toMatchObject({ status: "ok" });
  });

  it("una decisión humana no la cambia ningún recálculo; la evidencia que la contradice avisa", async () => {
    const target = albums["Desacuerdo"]!;
    await inTransaction((client) => confirmGenre(client, {
      kind: "album", entityId: target, genreSlug: "thrash-metal", role: "primary", actor: "brian", reason: "escuchado el disco",
    }));
    expect(await albumGenre(target)).toBe(await genreName("thrash-metal"));
    const human = await rows("SELECT * FROM ingest.album_genres WHERE album_id=$1 AND decision_kind='human'", [target]);
    expect(human).toHaveLength(1);
    expect(await rows("SELECT 1 FROM ingest.genre_assignment_log WHERE entity_id=$1 AND action='confirm_primary'", [target])).toHaveLength(1);

    await runGenreBackfill({ confirm: true, actor: "prueba" });
    await genreClaim(high, target, "Blues");
    const after = await rows("SELECT * FROM ingest.album_genres WHERE album_id=$1 AND decision_kind='human'", [target]);
    expect(after.map((row) => ({ ...row, updated_at: null, evidence: null, claim_ids: null })))
      .toEqual(human.map((row) => ({ ...row, updated_at: null, evidence: null, claim_ids: null })));
    expect(await albumGenre(target)).toBe(await genreName("thrash-metal"));

    // Una fuente nueva afirma otro principal: la decisión sigue y hay aviso.
    const decided = await album("Contradicho");
    await inTransaction((client) => confirmGenre(client, {
      kind: "album", entityId: decided, genreSlug: "thrash-metal", role: "primary", actor: "brian", reason: "escuchado",
    }));
    await genreClaim(high, decided, "Heavy Metal");
    expect(await assignments(decided)).toEqual([
      { slug: "heavy-metal", role: "secondary", status: "confirmed", decision_kind: "rule" },
      { slug: "thrash-metal", role: "primary", status: "confirmed", decision_kind: "human" },
    ]);
    expect(await albumGenre(decided)).toBe(await genreName("thrash-metal"));
    const warnings = await rows(
      "SELECT 1 FROM ingest.review_queue WHERE album_id=$1 AND payload->>'genreCase'='human_contradiction' AND status='open'", [decided]);
    expect(warnings).toHaveLength(1);
  });

  it("fusionar discos traslada sus géneros y deshacer la fusión los devuelve", async () => {
    const keep = await album("Fusión queda");
    const drop = await album("Fusión se va");
    await genreClaim(high, keep, "Rock");
    await genreClaim(high, drop, "Hard Rock / Blues");
    const before = await allRows();

    const preview = await previewAlbumMerge(pool(), keep, drop);
    expect(preview.fieldConflicts.map((item) => item.field)).not.toContain("genre");
    const merged = await withOperatorRun({ name: "test:genres:merge", operator: "prueba", note: "mismo disco" },
      (context) => mergeAlbums(context, { keepId: keep, dropId: drop, previewHash: preview.previewHash }));
    const moved = await assignments(keep);
    expect(moved).toEqual([
      { slug: "blues", role: "secondary", status: "confirmed", decision_kind: "rule" },
      { slug: "hard-rock", role: "primary", status: "confirmed", decision_kind: "rule" },
      { slug: "rock", role: "secondary", status: "superseded", decision_kind: "rule" },
    ]);
    expect(await albumGenre(keep)).toBe(await genreName("hard-rock"));
    // «Rock» es la familia de «Hard rock»: no discrepan, queda el término preciso y no se abre caso.
    expect(await rows("SELECT 1 FROM ingest.review_queue WHERE album_id=$1 AND payload->>'origin'='genres-merge'", [keep])).toHaveLength(0);

    await withOperatorRun({ name: "test:genres:undo", operator: "prueba", note: "deshacer" },
      (context) => undoMergeRun(context, merged.runId));
    expect(await allRows()).toEqual(before);
    expect(await albumGenre(keep)).toBe(await genreName("rock"));
    expect(await albumGenre(drop)).toBe(await genreName("hard-rock"));
  });

  it("fusionar discos con principales de familias distintas abre un caso de revisión", async () => {
    const keep = await album("Discrepa queda");
    const drop = await album("Discrepa se va");
    await genreClaim(high, keep, "Jazz");
    await genreClaim(high, drop, "Hard Rock");

    const preview = await previewAlbumMerge(pool(), keep, drop);
    await withOperatorRun({ name: "test:genres:merge-disagree", operator: "prueba", note: "mismo disco" },
      (context) => mergeAlbums(context, { keepId: keep, dropId: drop, previewHash: preview.previewHash }));
    expect(await albumGenre(keep)).toBe(await genreName("jazz"));
    expect(await rows(
      "SELECT 1 FROM ingest.review_queue WHERE album_id=$1 AND payload->>'origin'='genres-merge' AND payload->>'genreCase'='primary_disagreement'",
      [keep])).toHaveLength(1);
  });

  it("quitar un alias recalcula solo las filas de reglas que dependían de él", async () => {
    const human = albums["Alias humano"]!;
    const rule = albums["Alias regla"]!;
    await inTransaction((client) => confirmGenre(client, {
      kind: "album", entityId: human, genreSlug: "hard-rock", role: "primary", actor: "brian", reason: "confirmado",
    }));
    const untouched = await rows("SELECT * FROM ingest.album_genres WHERE album_id=$1", [albums["Melódico"]!]);
    const humanBefore = await rows("SELECT * FROM ingest.album_genres WHERE album_id=$1 AND decision_kind='human'", [human]);

    const report = await applyTaxonomyOperations([{ op: "remove_alias", alias: "rock duro" }],
      { actor: "prueba", reason: "alias demasiado amplio" }, { confirm: true });
    expect(report.affected.album).toBe(3); // Acuerdo, Alias regla y Alias humano usan «Rock duro».
    expect(await assignments(rule)).toEqual([]);
    expect(await rows(
      "SELECT 1 FROM ingest.review_queue WHERE album_id=$1 AND payload->>'genreCase'='unknown_value' AND status='open'", [rule])).toHaveLength(1);
    expect(await rows("SELECT * FROM ingest.album_genres WHERE album_id=$1 AND decision_kind='human'", [human])).toEqual(humanBefore);
    expect(await rows(
      "SELECT 1 FROM ingest.review_queue WHERE album_id=$1 AND payload->>'origin'='genres-taxonomy'", [human])).toHaveLength(1);
    expect(await rows("SELECT * FROM ingest.album_genres WHERE album_id=$1", [albums["Melódico"]!])).toEqual(untouched);
    // «Acuerdo» conserva hard-rock por su otra fuente.
    expect((await assignments(albums["Acuerdo"]!)).map((row) => row.slug)).toEqual(["hard-rock"]);
  });

  it("apagar el interruptor devuelve la escritura de albums.genre al motor sin perder asignaciones", async () => {
    const kept = await allRows();
    setProjection(false);
    const legacy = await album("Motor de nuevo");
    await genreClaim(high, legacy, "Punk");
    expect(await albumGenre(legacy)).toBe("Punk");
    expect(await assignments(legacy)).toEqual([]);
    expect(await allRows()).toEqual(kept);
  });

  it("la migración 0027 se revierte y se vuelve a aplicar; con el interruptor encendido no se revierte", async () => {
    setProjection(true);
    // El guardia actúa antes de revertir nada.
    await expect(migrateDownAll()).rejects.toThrow(/GENRES_PROJECTION_ENABLED/);
    expect(await rows("SELECT to_regclass('ingest.album_genres')::text AS t")).toEqual([{ t: "ingest.album_genres" }]);
    setProjection(false);

    const albumsBefore = await rows("SELECT id, genre FROM public.albums ORDER BY id");
    const down = await readFile(path.resolve("migrations", "0027_genre_taxonomy.down.sql"), "utf8");
    await pool().query("DELETE FROM ingest.schema_migrations WHERE version = '0027_genre_taxonomy'");
    await pool().query(down);
    expect(await rows("SELECT to_regclass('ingest.album_genres') AS t")).toEqual([{ t: null }]);
    expect(await rows("SELECT 1 FROM ingest.review_queue WHERE payload->>'origin' LIKE 'genres%'")).toEqual([]);
    // El core no se toca: `albums.genre` conserva el último texto proyectado.
    expect(await rows("SELECT id, genre FROM public.albums ORDER BY id")).toEqual(albumsBefore);

    await migrateUp();
    expect(await rows("SELECT to_regclass('ingest.album_genres')::text AS t")).toEqual([{ t: "ingest.album_genres" }]);
    const report = await applyTaxonomyOperations(await planTaxonomyFile(), { actor: "prueba", reason: "recarga" }, { confirm: true });
    expect(report.operations.length).toBeGreaterThan(0);
    const backfill = await runGenreBackfill({ confirm: true, actor: "prueba" });
    expect(backfill.after.albums.withConfirmedPrimary).toBeGreaterThan(0);
  }, 120_000);
});
