// Recopilatorios (C3). `albums.artist_id` es NOT NULL y un recopilatorio no
// tiene artista único: el marcador "Various Artists" ocupa esa columna y
// quien toca cada pista se afirma en track_credits.artist_id, una fila por
// pista. Se prueba contra una base real, sin red.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { sources } from "../../src/db/schema/ingest.js";
import { ingestRecords } from "../../src/ingest/runner.js";
import { VARIOUS_ARTISTS } from "../../src/adapters/shared.js";
import type { RawRecord } from "../../src/adapters/contracts.js";

const SOURCE = "fixture-va";
const POST = "https://fixture.invalid/va/recopilatorio";
const ALBUM = "Top Hits Fixture";
const BAND = "Azúcar, Cacao y Leche";
const TRACK = "Cosas";

const where = { url: POST, selector: "div", excerpt: "1. Azúcar, Cacao y Leche - Cosas" };

function record(entityKind: RawRecord["entityKind"], identity: string, fields: Array<[string, string]>): RawRecord {
  return {
    entityKind, identity, extractor: "fixture", extractorVersion: "1",
    fields: fields.map(([field, value]) => ({ field, value, evidence: where })),
  };
}

const marker = record("artist", VARIOUS_ARTISTS, [["name", VARIOUS_ARTISTS], ["artist_type", "other"]]);
const band = record("artist", BAND, [["name", BAND]]);
// Una persona con el MISMO nombre que la banda, para probar que el crédito no
// se la lleva por el orden de resolución por defecto.
const homonym = record("person", BAND, [["name", BAND]]);
const album = record("album", `${VARIOUS_ARTISTS}::${ALBUM}`, [
  ["title", ALBUM], ["artist_name", VARIOUS_ARTISTS], ["album_type", "compilation"], ["release_year", "1972"],
]);
const track = record("track", `${VARIOUS_ARTISTS}::${ALBUM}::${TRACK}`, [
  ["title", TRACK], ["track_number", "1"], ["album_title", ALBUM], ["artist_name", VARIOUS_ARTISTS],
]);
const credit = record("track_credit", `${ALBUM}::${TRACK}::${BAND}`, [
  ["album_title", ALBUM], ["track_title", TRACK], ["artist_name", VARIOUS_ARTISTS],
  ["credited_name", BAND], ["credited_kind", "artist"],
  ["credit_role", "intérprete"], ["credit_scope", "track"],
]);

describe("un recopilatorio relaciona a cada banda con su pista", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await getDb().insert(sources).values({
      slug: SOURCE, name: "Fixture de recopilatorios", url: "https://fixture.invalid",
      siteType: "website", trustLevel: "high", enabled: true,
    });
    await ingestRecords(SOURCE, [marker, band, homonym, album, track], { confidence: "high", createdBy: "human" });
    await ingestRecords(SOURCE, [credit], { confidence: "high", createdBy: "human" });
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("el disco cuelga del marcador y se declara recopilatorio", async () => {
    const { rows } = await getPool().query<{ title: string; album_type: string; artist: string }>(
      `SELECT b.title, b.album_type::text, a.name AS artist
         FROM public.albums b JOIN public.artists a ON a.id = b.artist_id`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: ALBUM, album_type: "compilation", artist: VARIOUS_ARTISTS });
  });

  it("el marcador no se disfraza de banda", async () => {
    const { rows } = await getPool().query<{ artist_type: string; notes: string | null }>(
      "SELECT artist_type::text, notes FROM public.artists WHERE name=$1", [VARIOUS_ARTISTS]);
    expect(rows[0]?.artist_type).toBe("other");
  });

  it("quien toca la pista va a track_credits.artist_id, no a person_id", async () => {
    const { rows } = await getPool().query<{
      track: string; credit_type: string; role: string; artist: string | null; person_id: string | null;
    }>(
      `SELECT t.title AS track, c.credit_type::text, c.role, a.name AS artist, c.person_id::text
         FROM public.track_credits c
         JOIN public.tracks t ON t.id = c.track_id
         LEFT JOIN public.artists a ON a.id = c.artist_id`);
    expect(rows).toHaveLength(1);
    // `credited_kind` impide que el orden por defecto (persona primero) se
    // lleve el crédito al homónimo que existe en el core.
    expect(rows[0]).toMatchObject({ track: TRACK, artist: BAND, person_id: null });
    // "intérprete" es una función de ejecución: músico, no `other`.
    expect(rows[0]?.credit_type).toBe("musician");
  });

  it("el homónimo sigue en el core, intacto y sin crédito", async () => {
    const { rows } = await getPool().query<{ count: string }>(
      "SELECT count(*)::text FROM public.persons WHERE name=$1", [BAND]);
    expect(rows[0]?.count).toBe("1");
  });

  it("la pista pertenece al recopilatorio, que es donde el core la ubica", async () => {
    const { rows } = await getPool().query<{ album: string; track_number: number }>(
      `SELECT b.title AS album, t.track_number FROM public.tracks t JOIN public.albums b ON b.id = t.album_id`);
    expect(rows[0]).toMatchObject({ album: ALBUM, track_number: 1 });
  });

  it("reprocesar no duplica el crédito", async () => {
    await ingestRecords(SOURCE, [credit], { confidence: "high", createdBy: "human" });
    const { rows } = await getPool().query<{ count: string }>("SELECT count(*)::text FROM public.track_credits");
    expect(rows[0]?.count).toBe("1");
  });
});
