import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { sources } from "../../src/db/schema/ingest.js";
import { mergeInto } from "../../src/review/duplicates.js";
import { mergeEquivalentMemberships } from "../../src/merge/equivalent-relations.js";

// Los siete fallos que bloqueaban la fusión de personas (P1, P3, P4, P6-P9 en
// el diagnóstico del 2026-09-15), cada uno con su caso contra PostgreSQL real.
// Todo pasa por `mergeInto`, el motor que comparten la CLI y la API.
describe("mergeInto endurecido", () => {
  let container: PgContainer;
  let sourceId: number;
  let runId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    const [source] = await getDb().insert(sources).values({
      slug: "hardening-fixture", name: "Hardening fixture", siteType: "website", trustLevel: "high", enabled: true,
    }).returning();
    sourceId = source!.id;
    runId = await one("INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running','{}'::jsonb) RETURNING id");
  }, 120_000);

  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  async function one(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await getPool().query<{ n: string }>(sql, params)).rows[0]!.n);
  }

  /** Una fusión es una transacción: igual que la ejecutan la CLI y el servicio. */
  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
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

  const merge = (kind: "person", keepId: number, dropId: number, note = "prueba de endurecimiento") =>
    inTransaction((client) => mergeInto(client, kind, keepId, dropId, note, runId));

  const newPerson = async (name: string, options: { isVenezuelan?: boolean } = {}) =>
    options.isVenezuelan
      ? one("INSERT INTO public.persons(name,is_venezuelan) VALUES($1,true) RETURNING id", [name])
      : one("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [name]);

  const keyIds = (keys: Array<Record<string, unknown>>) => keys.map((key) => Number(key["id"] as number));

  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  it("fusiona dos personas careadas en review_queue y cierra la revisión", async () => {
    const keep = await newPerson("Par Careado A");
    const drop = await newPerson("Par Careado B");
    // 41 revisiones de la base de desarrollo tienen las dos columnas; reapuntar
    // `person_b_id` a `keep` violaba review_queue_distinct_persons_chk (P1).
    const reviewId = await one(
      "INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,status,notes) VALUES('person_match',$1,$2,'open','careo de prueba') RETURNING id",
      [keep, drop]);

    const outcome = await merge("person", keep, drop, "prueba de par careado");

    const review = (await getPool().query<{ status: string; person_a_id: string; person_b_id: string | null; resolution_note: string }>(
      "SELECT status,person_a_id::text,person_b_id::text,resolution_note FROM ingest.review_queue WHERE id=$1", [reviewId])).rows[0]!;
    expect(review.status).toBe("approved");
    expect(Number(review.person_a_id)).toBe(keep);
    expect(review.person_b_id).toBeNull();
    expect(review.resolution_note).toContain("fusionado");
    expect(outcome.detachedReviews).toHaveLength(1);
    expect(Number(outcome.detachedReviews[0]!["person_b_id"] as number)).toBe(drop);

    const audit = (await getPool().query<{ new_value: Record<string, unknown> }>(
      "SELECT new_value FROM ingest.merge_audit WHERE id=$1", [outcome.auditId])).rows[0]!.new_value;
    expect(audit["version"]).toBe(2);
    expect(audit["detachedReviews"]).toHaveLength(1);
  });

  it("fusiona dos artistas careados en review_queue (misma avería, otro chk)", async () => {
    const keep = await one("INSERT INTO public.artists(name) VALUES('Par Careado Banda A') RETURNING id");
    const drop = await one("INSERT INTO public.artists(name) VALUES('Par Careado Banda B') RETURNING id");
    // P1 no era solo de personas: el mismo reapunte viola
    // review_queue_distinct_artists_chk.
    const reviewId = await one(
      "INSERT INTO ingest.review_queue(kind,artist_a_id,artist_b_id,status,notes) VALUES('possible_duplicate',$1,$2,'open','careo de bandas') RETURNING id",
      [keep, drop]);

    const outcome = await inTransaction((client) => mergeInto(client, "artist", keep, drop, "prueba de par careado de bandas", runId));

    const review = (await getPool().query<{ status: string; artist_a_id: string; artist_b_id: string | null; resolution_note: string }>(
      "SELECT status,artist_a_id::text,artist_b_id::text,resolution_note FROM ingest.review_queue WHERE id=$1", [reviewId])).rows[0]!;
    expect(review.status).toBe("approved");
    expect(Number(review.artist_a_id)).toBe(keep);
    expect(review.artist_b_id).toBeNull();
    expect(review.resolution_note).toContain("fusionado");
    expect(outcome.detachedReviews).toHaveLength(1);
    expect(await count("SELECT count(*) n FROM public.artists WHERE id=$1", [drop])).toBe(0);
  });

  it("un claim gemelo queda superseded sin destino y conserva su evidencia", async () => {
    const keep = await newPerson("Gemelo A");
    const drop = await newPerson("Gemelo B");
    // Mismo source, página, campo y raw_hash con destino distinto: al reapuntar
    // el de `drop` choca con `claims_dedupe_uk`. El INSERT va en SQL porque
    // persistClaim deduplica por identidad y no deja crear el gemelo.
    const rawHash = sha("gemelo");
    const claim = (personId: number, identity: string) => one(`
      INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,identity_key)
      VALUES($1,'person',$2,'name',to_jsonb('Gemelo'::text),$3,'accepted',$4) RETURNING id`, [sourceId, personId, rawHash, identity]);
    const keepClaim = await claim(keep, "gemelo:keep");
    const dropClaim = await claim(drop, "gemelo:drop");
    const evidence = (claimId: number, tag: string) => one(
      "INSERT INTO ingest.claim_evidence(claim_id,url,evidence_hash) VALUES($1,$2,$3) RETURNING id",
      [claimId, `https://fixture.invalid/gemelo/${tag}`, sha(`evidencia:${tag}`)]);
    await evidence(keepClaim, "keep");
    await evidence(dropClaim, "drop");
    const evidenceBefore = await count("SELECT count(*) n FROM ingest.claim_evidence");

    await merge("person", keep, drop, "prueba de claim gemelo");

    const claims = (await getPool().query<{ id: number; person_id: string | null; status: string; notes: string | null }>(
      "SELECT id::int,person_id::text,status,notes FROM ingest.claims WHERE id=ANY($1::int[]) ORDER BY id", [[keepClaim, dropClaim]])).rows;
    expect(claims.map((row) => ({ id: row.id, person_id: row.person_id, status: row.status }))).toEqual([
      { id: keepClaim, person_id: String(keep), status: "accepted" },
      { id: dropClaim, person_id: null, status: "superseded" },
    ]);
    expect(claims[1]!.notes).toContain("gemelo de un claim de person");
    // Ningún claim se borró y ninguna evidencia se fue en cascada con él (P3).
    expect(await count("SELECT count(*) n FROM ingest.claims WHERE id=$1", [dropClaim])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.claim_evidence")).toBe(evidenceBefore);
  });

  it("enlaza todos los claims en la auditoría aunque sean más de 50", async () => {
    const keep = await newPerson("Cincuenta A");
    const drop = await newPerson("Cincuenta B");
    for (let index = 0; index < 60; index += 1) {
      await getPool().query(`
        INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,identity_key)
        VALUES($1,'person',$2,'name',to_jsonb($3::text),$4,'accepted',$5)`,
      [sourceId, drop, `Cincuenta ${index}`, sha(`cincuenta:${index}`), `cincuenta:${index}`]);
    }

    const outcome = await merge("person", keep, drop, "prueba de 60 claims");

    // Antes: claimIds.slice(0, 50). La auditoría se quedaba sin 10 claims (P4).
    expect(await count("SELECT count(*) n FROM ingest.merge_audit_claims WHERE merge_audit_id=$1", [outcome.auditId])).toBe(60);
  });

  it("registra la clave primaria de cada fila movida", async () => {
    const artist = await one("INSERT INTO public.artists(name) VALUES('Banda Ref Moved') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Ref Moved') RETURNING id", [artist]);
    const keep = await newPerson("Referencia A");
    const drop = await newPerson("Referencia B");
    const credits: number[] = [];
    for (const role of ["Guitar", "Bass"]) {
      credits.push(await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician',$3) RETURNING id", [album, drop, role]));
    }

    const outcome = await merge("person", keep, drop, "prueba de referencias movidas");

    const ref = outcome.movedRefs.find((item) => item.table.endsWith("album_credits"));
    expect(ref?.table).toBe("public.album_credits");
    expect(ref?.column).toBe("person_id");
    expect(keyIds(ref!.keys).sort()).toEqual([...credits].sort());
    // El rastro va a la auditoría: es lo que permite deshacer la fusión (P6).
    const audit = (await getPool().query<{ new_value: { movedRefs: Array<{ table: string; keys: Array<Record<string, unknown>> }> } }>(
      "SELECT new_value FROM ingest.merge_audit WHERE id=$1", [outcome.auditId])).rows[0]!.new_value;
    expect(audit.movedRefs.map((item) => item.table)).toContain("public.album_credits");
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE person_id=$1", [keep])).toBe(2);
  });

  it("conserva is_venezuelan=true del duplicado", async () => {
    const keep = await newPerson("Venezolano A");
    const drop = await newPerson("Venezolano B", { isVenezuelan: true });
    const outcome = await merge("person", keep, drop, "prueba de is_venezuelan");

    // is_venezuelan es NOT NULL DEFAULT false: «vacío» es false, no NULL (P9).
    expect(outcome.filled).toContain("is_venezuelan");
    const row = (await getPool().query<{ is_venezuelan: boolean }>("SELECT is_venezuelan FROM public.persons WHERE id=$1", [keep])).rows[0]!;
    expect(row.is_venezuelan).toBe(true);
  });

  it("une membresías compatibles y abre revisión si los periodos se contradicen", async () => {
    const compatibleBand = await one("INSERT INTO public.artists(name) VALUES('Banda Membresias Compatibles') RETURNING id");
    const conflictingBand = await one("INSERT INTO public.artists(name) VALUES('Banda Membresias Contradictorias') RETURNING id");
    const keep = await newPerson("Membresia A");
    const drop = await newPerson("Membresia B");
    // Mismo rol salvo mayúsculas, períodos que no se contradicen.
    const compatibleKeep = await one("INSERT INTO public.artist_members(artist_id,person_id,role,from_year) VALUES($1,$2,'Bass',1990) RETURNING id", [compatibleBand, keep]);
    const compatibleDrop = await one("INSERT INTO public.artist_members(artist_id,person_id,role,to_year) VALUES($1,$2,'bass',1995) RETURNING id", [compatibleBand, drop]);
    // Mismo rol y años distintos: decide una persona, no el motor.
    const conflictingKeep = await one("INSERT INTO public.artist_members(artist_id,person_id,role,from_year,to_year) VALUES($1,$2,'Drums',1990,1995) RETURNING id", [conflictingBand, keep]);
    const conflictingDrop = await one("INSERT INTO public.artist_members(artist_id,person_id,role,from_year,to_year) VALUES($1,$2,'Drums',2000,2005) RETURNING id", [conflictingBand, drop]);

    await merge("person", keep, drop, "prueba de membresías");
    const result = await inTransaction((client) => mergeEquivalentMemberships(client, keep, "prueba de membresías", runId));

    expect(result).toEqual({ merged: 1, reviewsOpened: 1 });
    const memberships = await count("SELECT count(*) n FROM public.artist_members WHERE person_id=$1", [keep]);
    expect(memberships).toBe(3);
    // El que queda completa lo que le faltaba del que desaparece.
    const survivor = (await getPool().query<{ from_year: number | null; to_year: number | null }>(
      "SELECT from_year,to_year FROM public.artist_members WHERE id=$1", [compatibleKeep])).rows[0]!;
    expect(survivor).toEqual({ from_year: 1990, to_year: 1995 });
    expect(await count("SELECT count(*) n FROM public.artist_members WHERE id=$1", [compatibleDrop])).toBe(0);

    const review = (await getPool().query<{ kind: string; priority: number; status: string; payload: { detector: string; ids: number[] }; ids: string }>(`
      SELECT kind,priority,status,payload,payload->'ids' AS ids FROM ingest.review_queue
       WHERE kind='manual_review' AND payload->>'detector'='membership-periods' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(review.kind).toBe("manual_review");
    expect(review.priority).toBe(5);
    expect(review.status).toBe("open");
    expect(new Set(review.payload.ids)).toEqual(new Set([conflictingKeep, conflictingDrop]));
  });
});
