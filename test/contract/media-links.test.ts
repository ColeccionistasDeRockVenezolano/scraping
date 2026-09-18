// Camino de claims hacia media.media_links (migración 0008). Prueba las
// cuatro reglas del puente sobre una base real: sin red, sin fixtures de
// producción.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { sources } from "../../src/db/schema/ingest.js";
import { ingestRecords } from "../../src/ingest/runner.js";
import type { RawRecord } from "../../src/adapters/contracts.js";

const SOURCE = "fixture-artes";
const POST = "https://fixture.invalid/artes/banda";

function evidence(selector: string) {
  return { url: POST, selector, excerpt: "arte de fixture" };
}

const artist: RawRecord = {
  entityKind: "artist", identity: "Banda Artes", extractor: "fixture", extractorVersion: "1",
  fields: [{ field: "name", value: "Banda Artes", evidence: evidence("h1") }],
};

const album: RawRecord = {
  entityKind: "album", identity: "Banda Artes::Disco Artes", extractor: "fixture", extractorVersion: "1",
  fields: [
    { field: "title", value: "Disco Artes", evidence: evidence("h2") },
    { field: "artist_name", value: "Banda Artes", evidence: evidence("h2") },
  ],
};

function art(url: string, mediaType: string, target: "album" | "artist"): RawRecord {
  return {
    entityKind: "media_link", identity: `Banda Artes::${target === "album" ? "Disco Artes" : ""}::${url}`,
    extractor: "fixture", extractorVersion: "1",
    fields: [
      { field: "media_url", value: url, evidence: evidence("img") },
      { field: "media_type", value: mediaType, evidence: evidence("img") },
      { field: "media_target", value: target, evidence: evidence("img") },
      { field: "artist_name", value: "Banda Artes", evidence: evidence("img") },
      ...(target === "album" ? [{ field: "album_title", value: "Disco Artes", evidence: evidence("img") }] : []),
    ],
  };
}

const CONTRAPORTADA = "https://fixture.invalid/i/contraportada.jpg";
const GALLETA = "https://fixture.invalid/i/cd.jpg";

async function links() {
  const { rows } = await getPool().query<{ entity_kind: string; media_type: string; url: string; album_id: string | null; artist_id: string | null }>(
    "SELECT entity_kind, media_type, url, album_id::text, artist_id::text FROM media.media_links ORDER BY url",
  );
  return rows;
}

describe("artes que no caben en la columna única del core", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await getDb().insert(sources).values({
      slug: SOURCE, name: "Fixture de artes", url: "https://fixture.invalid",
      siteType: "website", trustLevel: "high", enabled: true,
    });
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("0008 añade el tipo sin tocar el core", async () => {
    const { rows } = await getPool().query<{ labels: string }>(
      `SELECT string_agg(e.enumlabel, '|' ORDER BY e.enumsortorder) AS labels
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname='ingest' AND t.typname='claim_entity_kind'`);
    expect(rows[0]?.labels).toContain("media_link");
    // La columna de trazabilidad vive en ingest, nunca en public.
    const columns = await getPool().query(
      `SELECT table_schema FROM information_schema.columns WHERE column_name='media_link_id'`);
    expect(columns.rows.every((row) => (row as { table_schema: string }).table_schema === "ingest")).toBe(true);
  });

  it("un arte low no escribe media_links: primero la entidad, después el arte", async () => {
    await ingestRecords(SOURCE, [artist, album, art(CONTRAPORTADA, "scan", "album")], { confidence: "low" });
    expect(await links()).toHaveLength(0);
  });

  it("un arte NO crea el disco del que cuelga", async () => {
    // Se aprueba solo el arte, con el disco todavía fuera del core.
    await ingestRecords(SOURCE, [art(GALLETA, "scan", "album")], { confidence: "high", createdBy: "human" });
    expect(await links()).toHaveLength(0);
    const { rows } = await getPool().query<{ count: string }>("SELECT count(*)::text FROM public.albums");
    expect(rows[0]?.count).toBe("0");
  });

  it("con la entidad ya en el core, el arte aterriza y es idempotente", async () => {
    await ingestRecords(SOURCE, [artist, album], { confidence: "high", createdBy: "human" });
    await ingestRecords(SOURCE, [art(CONTRAPORTADA, "scan", "album")], { confidence: "high", createdBy: "human" });
    const first = await links();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ entity_kind: "album", media_type: "scan", url: CONTRAPORTADA });
    expect(first[0]?.album_id).not.toBeNull();
    expect(first[0]?.artist_id).toBeNull();

    // UNIQUE(destino, url): reprocesar no duplica el arte.
    await ingestRecords(SOURCE, [art(CONTRAPORTADA, "scan", "album")], { confidence: "high", createdBy: "human" });
    expect(await links()).toHaveLength(1);
  });

  it("el destino lo fija el claim, no la URL: una foto de banda cuelga del artista", async () => {
    const photo = "https://fixture.invalid/i/banda.jpg";
    await ingestRecords(SOURCE, [art(photo, "artist_photo", "artist")], { confidence: "high", createdBy: "human" });
    const row = (await links()).find((item) => item.url === photo);
    expect(row).toMatchObject({ entity_kind: "artist", media_type: "artist_photo" });
    expect(row?.artist_id).not.toBeNull();
    expect(row?.album_id).toBeNull();
  });

  it("un media_type fuera del vocabulario se detiene en vez de caer en 'other'", async () => {
    const url = "https://fixture.invalid/i/raro.jpg";
    await ingestRecords(SOURCE, [art(url, "portada_trasera", "album")], { confidence: "high", createdBy: "human" });
    expect((await links()).some((item) => item.url === url)).toBe(false);
    const { rows } = await getPool().query<{ notes: string }>(
      "SELECT notes FROM ingest.review_queue WHERE notes LIKE 'Arte pendiente%' ORDER BY id DESC LIMIT 1");
    expect(rows[0]?.notes).toContain("media_type");
  });

  it("el arte queda auditado y enganchado a su claim", async () => {
    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text FROM ingest.merge_audit
        WHERE entity_kind='media_link' AND media_link_id IS NOT NULL`);
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    const attached = await getPool().query<{ count: string }>(
      "SELECT count(*)::text FROM ingest.claims WHERE entity_kind='media_link' AND media_link_id IS NOT NULL");
    expect(Number(attached.rows[0]?.count)).toBeGreaterThan(0);
  });
});
