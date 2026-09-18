// CRV · Test de contrato: puerto a Vitest de tests/run_all.sh (ARCH §7,
// PHASES F0). Contra un PostgreSQL 16 desechable, en un solo run:
//   1. el core (crv_simple_v1.sql) se aplica verbatim y el hash coincide;
//   2. las migraciones 0001-0021 se aplican vía el runner TS
//      (src/db/migrate.ts), 2 veces (idempotencia), y toda FK de
//      ingest/media queda respaldada por un índice;
//   3. el diff de `pg_dump --schema=public --schema-only` antes/después de
//      migrar es VACÍO — el core no fue tocado;
//   4. el schema Drizzle (src/db/schema) funciona de verdad: insertar y
//      leer a través de core+ingest+media con FKs y enums reales;
//   5. el rollback completo (down) deja el diff de `public` vacío también.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { resetEnvCache } from "../../src/config/env.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { migrateUp, migrateDownAll } from "../../src/db/migrate.js";
import * as schema from "../../src/db/schema/index.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

function useDatabaseUrl(url: string): void {
  process.env["DATABASE_URL"] = url;
  resetEnvCache();
}

async function pgDumpPublic(containerName: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "exec", containerName, "pg_dump", "-U", "postgres", "-d", "postgres",
    "--schema=public", "--schema-only",
  ]);
  // \restrict/\unrestrict llevan una clave aleatoria por dump (no son
  // objetos de base de datos): se excluyen del diff, igual que en
  // tests/run_all.sh.
  return stdout
    .split("\n")
    .filter((line) => !/^\\(un)?restrict/.test(line))
    .join("\n");
}

describe("contrato del core + migraciones (Drizzle/TS)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    useDatabaseUrl(container.databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    await container.stop();
  }, 60_000);

  it("crv_simple_v1.sql coincide con crv_simple_v1.sql.sha256", async () => {
    const [sql, hashFile] = await Promise.all([
      readFile(path.join(ROOT, "crv_simple_v1.sql"), "utf8"),
      readFile(path.join(ROOT, "crv_simple_v1.sql.sha256"), "utf8"),
    ]);
    const expected = hashFile.trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(sql).digest("hex");
    expect(actual).toBe(expected);
  });

  it("aplica el core y toma snapshot de public", async () => {
    await applyCore(container.name);
    const snapshot = await pgDumpPublic(container.name);
    expect(snapshot).toContain("CREATE TABLE public.artists");
    (globalThis as { __crvBeforeSnapshot?: string }).__crvBeforeSnapshot = snapshot;
  });

  it("aplica 0001-0022 vía el runner TS (2 pasadas, la 2ª es no-op)", async () => {
    const first = await migrateUp();
    expect(first.applied).toEqual([
      "0001_ingest_core", "0002_media", "0003_ingest_claims_identity", "0004_review_kinds",
      "0005_raw_pages_run", "0006_youtube_pipeline", "0007_entity_resolution_ai",
      "0008_media_link_claims", "0009_media_link_constraints", "0010_review_decisions",
      "0011_album_classifications", "0012_ambiguity_resolutions", "0013_fk_indexes",
      "0014_entity_redirects", "0015_review_kind_person_duplicate", "0016_person_duplicate_pair_uk",
      "0017_curation_findings", "0018_curation_finding_fixes", "0019_curation_scan_resolution", "0020_curation_durable_decisions",
      "0021_curation_fix_batches", "0022_er_decisions_retention",
    ]);
    const second = await migrateUp();
    expect(second.applied).toEqual([]);
  });

  it("diff de public vacío tras migrar: el core no fue alterado", async () => {
    const before = (globalThis as { __crvBeforeSnapshot?: string }).__crvBeforeSnapshot;
    const after = await pgDumpPublic(container.name);
    expect(after).toBe(before);
  });

  it("toda FK de ingest y media tiene un índice que empieza por sus columnas (0013)", async () => {
    // Sin él, cada DELETE del padre recorre la tabla hija entera (E11).
    const { rows } = await getPool().query<{ fk: string }>(`
      SELECT n.nspname || '.' || t.relname || '.' || c.conname AS fk
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'f' AND n.nspname IN ('ingest', 'media')
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey)
       ORDER BY 1`);
    expect(rows.map((row) => row.fk)).toEqual([]);
  });

  it("el schema Drizzle inserta y lee a través de core + ingest + media", async () => {
    const db = getDb();

    const [artist] = await db.insert(schema.artists).values({
      name: "Los Caramelos de Prueba",
      artistType: "band",
    }).returning();
    expect(artist?.id).toBeTypeOf("number");

    const [album] = await db.insert(schema.albums).values({
      artistId: artist!.id,
      title: "Las Paticas",
      albumType: "studio_album",
      releaseYear: 2009,
    }).returning();
    expect(album?.id).toBeTypeOf("number");

    const [track] = await db.insert(schema.tracks).values({
      albumId: album!.id,
      trackNumber: 1,
      title: "Canción de prueba",
    }).returning();
    expect(track?.id).toBeTypeOf("number");

    const [source] = await db.insert(schema.sources).values({
      slug: "test-source",
      name: "Fuente de prueba",
      siteType: "website",
      trustLevel: "medium",
    }).returning();
    expect(source?.id).toBeTypeOf("number");

    const [video] = await db.insert(schema.youtubeVideos).values({
      videoId: "dQw4w9WgXcQ",
      title: "Video de prueba",
      publicationStatus: "published",
    }).returning();
    expect(video?.id).toBeTypeOf("number");

    // video<->album N:N con enlace primario (media.video_albums, 0002/0003)
    await db.insert(schema.videoAlbums).values({
      videoId: video!.id,
      albumId: album!.id,
      albumKind: "full_album",
      isPrimaryLink: true,
      confidence: "high",
    });

    // claim sobre el álbum (ingest.claims, 0003) con evidencia
    const [claim] = await db.insert(schema.claims).values({
      sourceId: source!.id,
      entityKind: "album",
      albumId: album!.id,
      field: "release_year",
      rawValue: { value: "2009" },
      rawHash: "a".repeat(64),
      confidence: "high",
      status: "accepted",
    }).returning();
    expect(claim?.id).toBeTypeOf("number");

    await db.insert(schema.claimEvidence).values({
      claimId: claim!.id,
      url: "https://example.test/paticas",
      excerpt: "Las Paticas (2009)",
      evidenceHash: "b".repeat(64),
    });

    // review_queue con uno de los 8 kinds de 0004 (missing_url)
    const [review] = await db.insert(schema.reviewQueue).values({
      kind: "missing_url",
      claimAId: claim!.id,
    }).returning();
    expect(review?.kind).toBe("missing_url");

    // Join real a través de las tres tablas: album -> track -> video (media.video_tracks)
    await db.insert(schema.videoTracks).values({
      videoId: video!.id,
      trackId: track!.id,
      startSeconds: 0,
      confidence: "medium",
    });

    const joined = await db
      .select({ artistName: schema.artists.name, albumTitle: schema.albums.title, videoTitle: schema.youtubeVideos.title })
      .from(schema.videoAlbums)
      .innerJoin(schema.albums, eq(schema.albums.id, schema.videoAlbums.albumId))
      .innerJoin(schema.artists, eq(schema.artists.id, schema.albums.artistId))
      .innerJoin(schema.youtubeVideos, eq(schema.youtubeVideos.id, schema.videoAlbums.videoId))
      .where(eq(schema.videoAlbums.albumId, album!.id));

    expect(joined).toEqual([
      { artistName: "Los Caramelos de Prueba", albumTitle: "Las Paticas", videoTitle: "Video de prueba" },
    ]);
  });

  it("un kind de 0004 (missing_url) es rechazado tras el rollback completo, y el diff de public sigue vacío", async () => {
    // Limpia las filas de prueba para no bloquear el down (mismo motivo que
    // tests/test_0004_review_kinds.sh §4/§5: el down aborta si hay filas
    // usando kinds de 0004).
    const pool = getPool();
    await pool.query("DELETE FROM ingest.review_queue");

    const result = await migrateDownAll();
    expect(result.reverted).toEqual([
      "0022_er_decisions_retention", "0021_curation_fix_batches", "0020_curation_durable_decisions", "0019_curation_scan_resolution", "0018_curation_finding_fixes", "0017_curation_findings", "0016_person_duplicate_pair_uk", "0015_review_kind_person_duplicate",
      "0014_entity_redirects", "0013_fk_indexes", "0012_ambiguity_resolutions", "0011_album_classifications", "0010_review_decisions", "0009_media_link_constraints", "0008_media_link_claims",
      "0007_entity_resolution_ai", "0006_youtube_pipeline", "0005_raw_pages_run", "0004_review_kinds", "0003_ingest_claims_identity", "0002_media", "0001_ingest_core",
    ]);

    const { rows } = await pool.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname IN ('ingest','media')",
    );
    expect(rows).toEqual([]);

    const before = (globalThis as { __crvBeforeSnapshot?: string }).__crvBeforeSnapshot;
    const after = await pgDumpPublic(container.name);
    expect(after).toBe(before);
  });
});
