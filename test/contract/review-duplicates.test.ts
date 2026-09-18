import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { sources } from "../../src/db/schema/ingest.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim } from "../../src/claims/persistence.js";
import { findDuplicateGroups, mergeAllDuplicates } from "../../src/review/duplicates.js";

const count = async (sql: string, params: unknown[] = []) => Number((await getPool().query(sql, params)).rows[0].n);

describe("fusión de duplicados del core", () => {
  let container: PgContainer;
  let sourceId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    const [source] = await getDb().insert(sources).values({
      slug: "dup-fixture", name: "Duplicados fixture", siteType: "website", trustLevel: "high", enabled: true,
    }).returning();
    sourceId = source!.id;
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  async function albumClaim(albumId: number, title: string) {
    const [record] = normalizeRecord({
      entityKind: "album", identity: `Pacifica::${title}`, extractor: "dup-fixture", extractorVersion: String(albumId),
      fields: [{ field: "title", value: title, evidence: { url: `https://fixture.invalid/dup/${albumId}` } }],
    });
    return persistClaim({ ...record!, sourceId, confidence: "high", albumId });
  }

  it("une artistas por tilde, arrastra discos y pistas, y conserva auditoría y alias", async () => {
    const plain = Number((await getPool().query("INSERT INTO artists(name) VALUES('Pacifica') RETURNING id")).rows[0].id);
    const accented = Number((await getPool().query("INSERT INTO artists(name) VALUES('Pacífica') RETURNING id")).rows[0].id);
    await getPool().query("INSERT INTO artists(name) VALUES('Los Pixel'),('Pixel')");
    const keepAlbum = Number((await getPool().query("INSERT INTO albums(artist_id,title,release_year) VALUES($1,'.22',NULL) RETURNING id", [plain])).rows[0].id);
    const dropAlbum = Number((await getPool().query("INSERT INTO albums(artist_id,title,release_year,album_type) VALUES($1,'.22',2007,'studio_album') RETURNING id", [accented])).rows[0].id);
    await getPool().query("INSERT INTO tracks(album_id,track_number,title) VALUES($1,1,'Uno'),($2,1,'uno'),($2,2,'Dos')", [keepAlbum, dropAlbum]);
    const claim = await albumClaim(dropAlbum, ".22");
    await getPool().query(`
      WITH a AS (INSERT INTO ingest.merge_audit(entity_kind,album_id,field,new_value,reason,confidence) VALUES('album',$1,'title','".22"','fixture','high') RETURNING id)
      INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT id,$2 FROM a`, [dropAlbum, claim.id]);

    const scan = await findDuplicateGroups();
    expect(scan.groups.map((group) => [group.kind, group.names])).toEqual([["artist", ["Pacifica", "Pacífica"]]]);

    const result = await mergeAllDuplicates("prueba de duplicados");
    expect(result.failed).toEqual([]);
    expect(result.merged.map((item) => item.kind)).toEqual(["artist", "album"]);

    expect(await count("SELECT count(*) n FROM artists WHERE name IN ('Pacifica','Pacífica')")).toBe(1);
    expect(await count("SELECT count(*) n FROM artists WHERE name IN ('Los Pixel','Pixel')")).toBe(2);
    // P13: de dos discos iguales queda el que más referencias tiene —dos pistas
    // contra una—, no el de id menor; el año y el tipo del que queda se imponen.
    const survivor = dropAlbum;
    const discarded = keepAlbum;
    const album = (await getPool().query("SELECT id,release_year,album_type FROM albums WHERE title='.22'")).rows;
    expect(album).toEqual([{ id: String(survivor), release_year: 2007, album_type: "studio_album" }]);
    // De las dos pistas de la misma posición queda la del disco que sobrevive
    // («uno», que ya estaba en él): la otra se fusiona en esa.
    expect((await getPool().query("SELECT track_number,title FROM tracks WHERE album_id=$1 ORDER BY track_number", [survivor])).rows)
      .toEqual([{ track_number: 1, title: "uno" }, { track_number: 2, title: "Dos" }]);
    expect(await count("SELECT count(*) n FROM tracks WHERE album_id=$1", [discarded])).toBe(0);
    expect((await getPool().query("SELECT album_id FROM ingest.claims WHERE id=$1", [claim.id])).rows[0].album_id).toBe(String(survivor));
    expect(await count("SELECT count(*) n FROM ingest.merge_audit WHERE album_id=$1 AND field='title'", [survivor])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.artist_aliases WHERE artist_id=$1 AND alias='Pacífica'", [plain])).toBe(1);
    expect(await count(`SELECT count(*) n FROM ingest.merge_audit ma WHERE field='merged_duplicate'
      AND EXISTS (SELECT 1 FROM ingest.merge_audit_claims mac WHERE mac.merge_audit_id=ma.id)`)).toBeGreaterThanOrEqual(1);
  });

  it("no toca discos con el mismo título y años distintos ni pistas distintas en la misma posición", async () => {
    const spiteri = Number((await getPool().query("INSERT INTO artists(name) VALUES('Spiteri Fixture') RETURNING id")).rows[0].id);
    await getPool().query("INSERT INTO albums(artist_id,title,release_year) VALUES($1,'Spiteri',1973),($1,'Spiteri',1981)", [spiteri]);
    const band = Number((await getPool().query("INSERT INTO artists(name) VALUES('Banda Pistas') RETURNING id")).rows[0].id);
    const a = Number((await getPool().query("INSERT INTO albums(artist_id,title) VALUES($1,'Disco') RETURNING id", [band])).rows[0].id);
    const b = Number((await getPool().query("INSERT INTO albums(artist_id,title) VALUES($1,'disco') RETURNING id", [band])).rows[0].id);
    await getPool().query("INSERT INTO tracks(album_id,track_number,title) VALUES($1,1,'Una'),($2,1,'Otra')", [a, b]);

    const result = await mergeAllDuplicates("no adivinar");
    expect(result.skipped.map((item) => item.reason)).toEqual(["mismo título con años distintos: 1973, 1981"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("pistas distintas");
    expect(await count("SELECT count(*) n FROM albums WHERE artist_id=ANY($1::bigint[])", [[spiteri, band]])).toBe(4);
  });
});
