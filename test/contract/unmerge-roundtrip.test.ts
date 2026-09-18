// CRV · E11.8 — Deshacer una fusión: test de ida y vuelta.
//
// Instantánea de las tablas que toca una fusión (fuera de la auditoría, que
// solo crece), fusión con créditos y membresías equivalentes, un claim gemelo
// y una revisión careada, y reversión. Las instantáneas deben volver a ser
// iguales salvo los sellos de tiempo que nadie decide (`updated_at`).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { withOperatorRun } from "../../src/merge/operator.js";
import { mergeEntities, previewEntityMerge } from "../../src/merge/entity-merge.js";
import { undoMergeRun } from "../../src/merge/unmerge.js";

describe("deshacer una fusión (E11.8)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);

  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  /** Estado que una fusión toca; la auditoría no entra (solo crece, a propósito). */
  async function snapshot() {
    const q = async (sql: string) => (await getPool().query(sql)).rows;
    return {
      persons: await q("SELECT to_jsonb(p) - 'updated_at' - 'created_at' AS row FROM public.persons p ORDER BY p.id"),
      // `created_at` fuera del JSON (su texto puede redondear al ir y volver por
      // jsonb) y comprobado aparte: el sello se restaura con precisión de
      // milisegundos, que es la que conserva el ida y vuelta del `old_value`
      // (el snapshot de la auditoría pasa por `JSON.stringify` de un `Date`).
      personStamps: await q(`SELECT id::text AS id,
        to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS') AS stamp FROM public.persons ORDER BY id`),
      personAliases: await q("SELECT to_jsonb(a) - 'created_at' AS row FROM ingest.person_aliases a ORDER BY a.id"),
      albumCredits: await q("SELECT to_jsonb(c) AS row FROM public.album_credits c ORDER BY c.id"),
      trackCredits: await q("SELECT to_jsonb(c) AS row FROM public.track_credits c ORDER BY c.id"),
      artistMembers: await q("SELECT to_jsonb(m) AS row FROM public.artist_members m ORDER BY m.id"),
      claims: await q("SELECT id, person_id, status FROM ingest.claims ORDER BY id"),
      reviewQueue: await q("SELECT id, person_a_id, person_b_id, status FROM ingest.review_queue ORDER BY id"),
      redirects: await q("SELECT entity_kind, from_id, to_id FROM ingest.entity_redirects ORDER BY entity_kind, from_id"),
    };
  }

  const merge = async (keepId: number, dropId: number, note: string) => {
    const preview = await previewEntityMerge(getPool(), "person", keepId, dropId);
    return withOperatorRun({ name: "test:merge:person", operator: "prueba", note },
      (context) => mergeEntities(context, { kind: "person", keepId, dropId, previewHash: preview.previewHash, keepDropNameAsAlias: true }));
  };

  const undo = async (mergeRunId: number, note = "prueba de reversión") => {
    const { runId, result } = await withOperatorRun(
      { name: "test:merge:undo", operator: "prueba", note }, (context) => undoMergeRun(context, mergeRunId));
    return { ...result, undoRunId: runId };
  };

  it("la instantánea vuelve a ser la misma tras fusionar y deshacer", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Reversión QA') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Reversión QA') RETURNING id", [band]);
    const track = await one("INSERT INTO public.tracks(album_id,track_number,title) VALUES($1,1,'Pista Reversión QA') RETURNING id", [album]);
    const sourceId = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled) VALUES('undo-fixture','Undo fixture','website','high',true) RETURNING id");
    const keep = await one("INSERT INTO public.persons(name,biography) VALUES('Reversion A','Biografía de A') RETURNING id");
    const drop = await one("INSERT INTO public.persons(name,is_venezuelan) VALUES('Reversion B',true) RETURNING id");
    // Créditos equivalentes (mismo disco, mismo rol salvo mayúsculas) y membresías compatibles.
    await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitar') RETURNING id", [album, keep]);
    await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','guitar') RETURNING id", [album, drop]);
    await one("INSERT INTO public.track_credits(track_id,person_id,credit_type,role) VALUES($1,$2,'musician','Bajo') RETURNING id", [track, drop]);
    await one("INSERT INTO public.artist_members(artist_id,person_id,role,to_year) VALUES($1,$2,'Batería',1995) RETURNING id", [band, keep]);
    await one("INSERT INTO public.artist_members(artist_id,person_id,role,from_year) VALUES($1,$2,'batería',1990) RETURNING id", [band, drop]);
    // Claim gemelo: mismo source/página/campo/hash con destino distinto.
    const rawHash = sha("gemelo-reversion");
    const claim = (personId: number, identity: string) => one(`
      INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,identity_key)
      VALUES($1,'person',$2,'name',to_jsonb('Reversion'::text),$3,'accepted',$4) RETURNING id`, [sourceId, personId, rawHash, identity]);
    await claim(keep, "reversion:keep");
    await claim(drop, "reversion:drop");
    // Revisión que carea las dos fichas (la fusión la suelta; la reversión la devuelve).
    const reviewId = await one(
      "INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,status,notes) VALUES('person_match',$1,$2,'open','careo de reversión') RETURNING id",
      [keep, drop]);

    const before = await snapshot();
    const merged = await merge(keep, drop, "prueba de reversión");
    // La fusión hizo su trabajo: una sola persona, créditos unificados, redirección.
    expect(Number((await getPool().query<{ n: string }>("SELECT count(*) n FROM public.persons")).rows[0]!.n)).toBe(1);
    expect((await getPool().query("SELECT 1 FROM ingest.entity_redirects WHERE from_id=$1", [drop])).rows).toHaveLength(1);

    const undone = await undo(merged.runId);

    expect(undone.mergeRunId).toBe(merged.runId);
    // `restored` lista todo lo que volvió: la persona, su crédito y su membresía
    // (la fusión los había unificado en las filas equivalentes de la que quedó).
    expect(undone.restored).toEqual(expect.arrayContaining([
      { kind: "person", id: drop },
      { kind: "album_credit", id: expect.any(Number) as unknown as number },
      { kind: "artist_membership", id: expect.any(Number) as unknown as number },
    ]));
    expect(undone.fieldsNotReverted).toEqual([]);
    expect(await snapshot()).toEqual(before);

    // La revisión careada volvió a su estado abierto y con las dos fichas.
    const review = (await getPool().query<{ status: string; person_a_id: string; person_b_id: string }>(
      "SELECT status, person_a_id::text, person_b_id::text FROM ingest.review_queue WHERE id=$1", [reviewId])).rows[0]!;
    expect(review).toEqual({ status: "open", person_a_id: String(keep), person_b_id: String(drop) });
    // Y la auditoría de la reversión quedó: una fila por fusión deshecha (la
    // persona, su crédito y su membresía), con los claims de la fusión enlazados.
    const unmerged = (await getPool().query<{ kind: string; claims: string }>(`
      SELECT ma.entity_kind::text AS kind,
             (SELECT count(*)::text FROM ingest.merge_audit_claims WHERE merge_audit_id=ma.id) AS claims
        FROM ingest.merge_audit ma WHERE ma.run_id=$1 AND ma.field='unmerged_duplicate'
       ORDER BY ma.id`, [undone.undoRunId])).rows;
    // Una fila por fusión deshecha (la persona, su crédito y su membresía), cada
    // una con los claims que probaban esa fusión.
    expect(unmerged.map((row) => row.kind).sort()).toEqual(["album_credit", "artist_membership", "person"]);
    const personAudit = unmerged.find((row) => row.kind === "person");
    expect(personAudit).toBeDefined();
    expect(Number(personAudit!.claims)).toBeGreaterThanOrEqual(2);
  });

  it("informa —sin revertir— las correcciones de campo hechas durante la fusión", async () => {
    const keep = await one("INSERT INTO public.persons(name,biography) VALUES('Correccion A','bio A') RETURNING id");
    const drop = await one("INSERT INTO public.persons(name,biography) VALUES('Correccion B','bio B') RETURNING id");
    const preview = await previewEntityMerge(getPool(), "person", keep, drop);
    const merged = await withOperatorRun({ name: "test:merge:person", operator: "prueba", note: "con elección de campo" },
      (context) => mergeEntities(context, { kind: "person",
        keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: true,
        fieldChoices: { biography: "drop" },
      }));

    const undone = await undo(merged.runId, "prueba de reversión con corrección");
    expect(undone.fieldsNotReverted).toEqual(["biography"]);
    // La corrección humana no se revierte: la biografía elegida sigue en la ficha.
    const stored = (await getPool().query<{ biography: string }>("SELECT biography FROM public.persons WHERE id=$1", [keep])).rows[0]!;
    expect(stored.biography).toBe("bio B");
  });

  it("no deshace una fusión si la ficha que quedó se fusionó después", async () => {
    const a = await one("INSERT INTO public.persons(name) VALUES('Cadena A') RETURNING id");
    const b = await one("INSERT INTO public.persons(name) VALUES('Cadena B') RETURNING id");
    const c = await one("INSERT INTO public.persons(name) VALUES('Cadena C') RETURNING id");
    const first = await merge(a, b, "primera fusión de la cadena");
    await merge(c, a, "segunda fusión de la cadena");

    await expect(undo(first.runId)).rejects.toMatchObject({ code: "not_open" });
    // Nada cambió: sigue la cadena C ← A ← B, y la redirección del id B se
    // comprimió hacia C al fusionar A en C (E11.2), no hacia un id muerto.
    const persons = (await getPool().query<{ name: string }>("SELECT name FROM public.persons ORDER BY id")).rows.map((row) => row.name);
    expect(persons).toContain("Cadena C");
    expect(persons).not.toContain("Cadena A");
    expect((await getPool().query("SELECT 1 FROM ingest.entity_redirects WHERE from_id=$1 AND to_id=$2", [b, c])).rows).toHaveLength(1);
  });

  it("rechaza deshacer una fusión anterior a E11.1 (sin filas movidas en la auditoría)", async () => {
    const keep = await one("INSERT INTO public.persons(name) VALUES('Antigua A') RETURNING id");
    const drop = await one("INSERT INTO public.persons(name) VALUES('Antigua B') RETURNING id");
    // Fusión «vieja»: la auditoría no guarda movedRefs (version 1 no existe).
    const runId = await one(
      "INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','ok','{}'::jsonb) RETURNING id");
    await getPool().query(`
      INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
      VALUES($1,'person',$2,'merged_duplicate',$3::jsonb,$4::jsonb,'fusión antigua','high','human')`,
    [runId, keep, JSON.stringify({ id: drop, name: "Antigua B" }), JSON.stringify({ keptId: keep, filled: [], moved: 0, discarded: 0, tracksMerged: 0 })]);

    await expect(undo(runId)).rejects.toMatchObject({ code: "invalid" });
  });
});
