// CRV · Deshacer lo anterior al diario (22-09-2026), decisión por decisión.
//
// Las fusiones de antes de E11.1 guardaban CUÁNTAS filas movieron, no cuáles.
// `crv merges rebuild-traces` reconstruye esa lista desde un respaldo anterior
// al cambio (aquí, una segunda base desechable con solo el core) y la guarda
// en `ingest.merge_traces`. Esta prueba comprueba las dos mitades de la regla:
//   * SOLO SE DESHACE LO VERIFICADO: si la reconstrucción cuadra con lo que la
//     fusión registró, `POST /audit/:id/undo` devuelve la ficha con todo lo
//     suyo; si no cuadra, la vista previa dice que no y por qué;
//   * una conversión (`absorbed_person`) se deshace desde su propia auditoría,
//     sin respaldo: la persona vuelve con sus créditos, su alias en el destino
//     desaparece y sus claims dejan de estar rechazados.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { rebuildTraces } from "../../src/merge/legacy-trace.js";
import { applyPersonCorrections } from "../../src/review/person-corrections.js";

const TOKEN = "token-de-prueba-de-lo-heredado-0123456789";
const OPERATOR = "Tester Heredado";
const SNAPSHOT = "respaldo crv-20260915T063612Z (prueba)";

describe("deshacer lo anterior al diario, decisión por decisión", () => {
  let container: PgContainer;
  let snapshot: PgContainer;
  let snapshotClient: pg.Client;
  let app: FastifyInstance;

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await getPool().query(sql, params)).rows[0] as T;
  const id = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ id: string }>(sql, params)).id);
  const write = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });

  /** Ids del escenario, iguales en la base viva y en la «instantánea». */
  const ref: Record<string, number> = {};
  let runId = 0;
  let mergeAuditId = 0;
  let mismatchAuditId = 0;

  /** La misma fila, con el mismo id, en la instantánea (core sin migraciones). */
  const mirror = (sql: string, params: unknown[] = []) => snapshotClient.query(sql, params);

  beforeAll(async () => {
    [container, snapshot] = await Promise.all([startPgContainer(), startPgContainer()]);
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await Promise.all([applyCore(container.name), applyCore(snapshot.name)]);
    await migrateUp();
    app = await buildApp();
    snapshotClient = new pg.Client({ connectionString: snapshot.databaseUrl });
    await snapshotClient.connect();

    // 1. El catálogo tal como estaba ANTES de la fusión vieja.
    ref["source"] = await id("INSERT INTO ingest.sources(slug,name,site_type,trust_level) VALUES ('prueba-heredado','Prueba','website','medium') RETURNING id");
    ref["artist"] = await id("INSERT INTO public.artists(name) VALUES ('Los del Rastro') RETURNING id");
    ref["album"] = await id("INSERT INTO public.albums(artist_id,title,album_type) VALUES ($1,'Disco del Rastro','studio_album') RETURNING id", [ref["artist"]]);
    ref["keep"] = await id("INSERT INTO public.persons(name) VALUES ('Juan Pérez') RETURNING id");
    ref["drop"] = await id("INSERT INTO public.persons(name,notes) VALUES ('Juan Perez','sin acento') RETURNING id");
    ref["c1"] = await id("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES ($1,$2,'musician','Bass') RETURNING id", [ref["album"], ref["drop"]]);
    ref["c2"] = await id("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES ($1,$2,'mixing','mixed') RETURNING id", [ref["album"], ref["drop"]]);
    await getPool().query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES ($1,$2,'Bass')", [ref["artist"], ref["drop"]]);
    ref["member"] = await id("SELECT id::text FROM public.artist_members WHERE person_id=$1", [ref["drop"]]);
    // Segunda pareja, la que no cuadrará.
    ref["keep2"] = await id("INSERT INTO public.persons(name) VALUES ('Ana Ruiz') RETURNING id");
    ref["drop2"] = await id("INSERT INTO public.persons(name) VALUES ('Anna Ruiz') RETURNING id");
    ref["c3"] = await id("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES ($1,$2,'photography','Photos') RETURNING id", [ref["album"], ref["drop2"]]);

    // 2. La misma foto en la instantánea, con los mismos ids.
    await mirror("INSERT INTO artists(id,name) OVERRIDING SYSTEM VALUE VALUES ($1,'Los del Rastro')", [ref["artist"]]);
    await mirror("INSERT INTO albums(id,artist_id,title,album_type) OVERRIDING SYSTEM VALUE VALUES ($1,$2,'Disco del Rastro','studio_album')", [ref["album"], ref["artist"]]);
    await mirror("INSERT INTO persons(id,name) OVERRIDING SYSTEM VALUE VALUES ($1,'Juan Pérez')", [ref["keep"]]);
    await mirror("INSERT INTO persons(id,name,notes) OVERRIDING SYSTEM VALUE VALUES ($1,'Juan Perez','sin acento')", [ref["drop"]]);
    await mirror("INSERT INTO persons(id,name) OVERRIDING SYSTEM VALUE VALUES ($1,'Ana Ruiz')", [ref["keep2"]]);
    await mirror("INSERT INTO persons(id,name) OVERRIDING SYSTEM VALUE VALUES ($1,'Anna Ruiz')", [ref["drop2"]]);
    await mirror("INSERT INTO album_credits(id,album_id,person_id,credit_type,role) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,'musician','Bass')", [ref["c1"], ref["album"], ref["drop"]]);
    await mirror("INSERT INTO album_credits(id,album_id,person_id,credit_type,role) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,'mixing','mixed')", [ref["c2"], ref["album"], ref["drop"]]);
    await mirror("INSERT INTO album_credits(id,album_id,person_id,credit_type,role) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,'photography','Photos')", [ref["c3"], ref["album"], ref["drop2"]]);
    await mirror("INSERT INTO artist_members(id,artist_id,person_id,role) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,'Bass')", [ref["member"], ref["artist"], ref["drop"]]);

    // 3. Dos fusiones con la auditoría de entonces: cuentas, sin `movedRefs`.
    runId = await id(`INSERT INTO ingest.scrape_runs(kind,source_id,status,params)
      VALUES ('manual',$1,'ok','{"action":"merge:legacy"}'::jsonb) RETURNING id`, [ref["source"]]);
    mergeAuditId = await legacyMerge(ref["keep"]!, ref["drop"]!, "Juan Perez", 3);
    await getPool().query("UPDATE public.album_credits SET person_id=$1 WHERE id=ANY($2::bigint[])", [ref["keep"], [ref["c1"], ref["c2"]]]);
    await getPool().query("UPDATE public.artist_members SET person_id=$1 WHERE id=$2", [ref["keep"], ref["member"]]);
    await getPool().query("DELETE FROM public.persons WHERE id=$1", [ref["drop"]]);
    // La segunda dice haber movido 5 filas: la instantánea solo explica 1.
    mismatchAuditId = await legacyMerge(ref["keep2"]!, ref["drop2"]!, "Anna Ruiz", 5);
    await getPool().query("UPDATE public.album_credits SET person_id=$1 WHERE id=$2", [ref["keep2"], ref["c3"]]);
    await getPool().query("DELETE FROM public.persons WHERE id=$1", [ref["drop2"]]);
  }, 180_000);

  /** Una fila `merged_duplicate` del formato viejo, con su alias y su redirección. */
  async function legacyMerge(keepId: number, dropId: number, dropName: string, moved: number): Promise<number> {
    const auditId = await id(`
      INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
      SELECT $1,'person',$2,'merged_duplicate',to_jsonb(p),$3::jsonb,'fusión de prueba anterior a E11.1','high','human'
        FROM public.persons p WHERE p.id=$4 RETURNING id`,
    [runId, keepId, JSON.stringify({ keptId: keepId, moved, discarded: 0, filled: [], tracksMerged: 0 }), dropId]);
    await getPool().query(
      "INSERT INTO ingest.person_aliases(person_id,alias,normalized_alias,notes) VALUES ($1,$2::text,lower($2::text),'Nombre de un duplicado fusionado')",
      [keepId, dropName]);
    await getPool().query(
      "INSERT INTO ingest.entity_redirects(entity_kind,from_id,to_id,merge_audit_id,run_id) VALUES ('person',$1,$2,$3,$4)",
      [dropId, keepId, auditId, runId]);
    return auditId;
  }

  afterAll(async () => {
    await app?.close();
    await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"];
    await snapshotClient?.end().catch(() => undefined);
    await Promise.all([container?.stop(), snapshot?.stop()]);
  }, 90_000);

  it("sin rastro reconstruido, una fusión vieja no se deshace y lo dice", async () => {
    const preview = await get(`/audit/${mergeAuditId}/undo`);
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json();
    expect(body.undoable).toBe(false);
    expect(body.kind).toBe("merge");
    expect(body.restores).toMatchObject({ kind: "person", id: ref["drop"], label: "Juan Perez" });
    expect(body.reasonNot).toMatch(/anterior a E11\.1/);
    expect(body.reasonNot).toMatch(/rebuild-traces/);
  });

  it("la reconstrucción desde el respaldo verifica lo que cuadra y solo eso", async () => {
    const client = await getPool().connect();
    try {
      const summary = await rebuildTraces(client, snapshotClient, SNAPSHOT, { runId });
      expect(summary.merges).toBe(2);
      expect(summary.verified).toBe(1);
      expect(summary.unverified).toHaveLength(1);
      expect(summary.unverified[0]!.auditId).toBe(mismatchAuditId);
      expect(summary.unverified[0]!.reason).toMatch(/explica 1 de las 5 filas/);
    } finally {
      client.release();
    }
    const traces = await getPool().query<{ audit_id: string; moved_found: number; verified: boolean; source_label: string }>(
      "SELECT audit_id::text, moved_found, verified, source_label FROM ingest.merge_traces ORDER BY audit_id");
    expect(traces.rows).toEqual([
      { audit_id: String(mergeAuditId), moved_found: 3, verified: true, source_label: SNAPSHOT },
      { audit_id: String(mismatchAuditId), moved_found: 1, verified: false, source_label: SNAPSHOT },
    ]);
  });

  it("la que no cuadra sigue sin deshacerse, diciendo cuántas filas faltan", async () => {
    const preview = await get(`/audit/${mismatchAuditId}/undo`);
    expect(preview.json().undoable).toBe(false);
    expect(preview.json().reasonNot).toMatch(/explica 1 de las 5 filas/);
    const applied = await write("POST", `/audit/${mismatchAuditId}/undo`, { note: "intento en prueba" });
    expect(applied.statusCode).toBe(409);
    expect(await personExists(ref["drop2"]!)).toBe(false);
  });

  it("la verificada se deshace: la persona vuelve con sus créditos y su membresía", async () => {
    const preview = await get(`/audit/${mergeAuditId}/undo`);
    expect(preview.json().undoable, preview.body).toBe(true);
    // La vista previa no deja rastro: la persona sigue sin volver.
    expect(await personExists(ref["drop"]!)).toBe(false);

    const response = await write("POST", `/audit/${mergeAuditId}/undo`, { note: "fusión equivocada" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ auditId: mergeAuditId, kind: "merge", result: { restored: { kind: "person", id: ref["drop"] } } });
    expect(typeof response.json().runId).toBe("number");

    const person = await one<{ name: string; notes: string }>("SELECT name,notes FROM public.persons WHERE id=$1", [ref["drop"]]);
    expect(person).toEqual({ name: "Juan Perez", notes: "sin acento" });
    const credits = await getPool().query<{ id: string; person_id: string }>(
      "SELECT id::text, person_id::text FROM public.album_credits WHERE id=ANY($1::bigint[]) ORDER BY id", [[ref["c1"], ref["c2"]]]);
    expect(credits.rows.map((row) => Number(row.person_id))).toEqual([ref["drop"], ref["drop"]]);
    const member = await one<{ person_id: number }>("SELECT person_id::int FROM public.artist_members WHERE id=$1", [ref["member"]]);
    expect(member.person_id).toBe(ref["drop"]);
    // El alias que dejó la fusión y la redirección del id desaparecen.
    const alias = await one<{ n: number }>("SELECT count(*)::int AS n FROM ingest.person_aliases WHERE person_id=$1 AND alias='Juan Perez'", [ref["keep"]]);
    expect(alias.n).toBe(0);
    const redirect = await one<{ n: number }>("SELECT count(*)::int AS n FROM ingest.entity_redirects WHERE entity_kind='person' AND from_id=$1", [ref["drop"]]);
    expect(redirect.n).toBe(0);
    // Y la ficha devuelta se puede abrir por la API.
    const page = await get(`/persons/${ref["drop"]}`);
    expect(page.statusCode).toBe(200);
  });

  it("deshacer dos veces la misma fusión se niega y nombra el cambio que la deshizo", async () => {
    const preview = await get(`/audit/${mergeAuditId}/undo`);
    expect(preview.json().undoable).toBe(false);
    expect(preview.json().reasonNot).toMatch(/ya se deshizo/);
    expect(preview.json().undoneByRunId).toBeGreaterThan(0);
    const response = await write("POST", `/audit/${mergeAuditId}/undo`, { note: "otra vez" });
    expect(response.statusCode).toBe(409);
    expect(response.json().message ?? response.body).toMatch(/ya se deshizo/);
  });

  it("una conversión se deshace desde su auditoría, sin respaldo", async () => {
    const pool = getPool();
    const studio = await id("INSERT INTO public.organizations(name,organization_type) VALUES ('Killdom Imaging','other') RETURNING id");
    const killdom = await id("INSERT INTO public.persons(name) VALUES ('Killdom') RETURNING id");
    // Dos claims: uno sin notas y otro con notas previas, porque la conversión
    // añade su motivo con `concat_ws` y al deshacer hay que quitarlo en ambos.
    const claim = async (raw: string, notes: string | null) => id(`
      INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,notes)
      VALUES ($1,'person',$2,'name',to_jsonb($3::text),$4,'accepted',$5) RETURNING id`,
    [ref["source"], killdom, raw, createHash("sha256").update(`person:${raw}`).digest("hex"), notes]);
    const claimId = await claim("Killdom", null);
    const claimConNotas = await claim("Killdom Studio", "de la planilla");
    const credit = await id("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES ($1,$2,'photography','photos') RETURNING id", [ref["album"], killdom]);

    const result = await applyPersonCorrections({ decidedAt: "2026-09-14", evidence: "prueba", corrections: [
      { op: "to_organization", person: { id: killdom, name: "Killdom" }, organization: { id: studio, name: "Killdom Imaging" }, keepNameAsAlias: true, why: "es el estudio" },
    ] }, "decisión del propietario");
    expect(result.outcomes[0]!.status).toBe("applied");
    const auditId = await id("SELECT id::text FROM ingest.merge_audit WHERE field='absorbed_person' ORDER BY id DESC LIMIT 1");

    const preview = await get(`/audit/${auditId}/undo`);
    expect(preview.json()).toMatchObject({ undoable: true, kind: "absorption", restores: { kind: "person", id: killdom, label: "Killdom" } });
    expect(await personExists(killdom)).toBe(false);

    const response = await write("POST", `/audit/${auditId}/undo`, { note: "sí era una persona" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result).toMatchObject({ kind: "absorption", absorption: { personId: killdom, creditsReturned: 1, aliasesRemoved: 1, claimsRestored: 2 } });

    const back = await one<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [killdom]);
    expect(back.name).toBe("Killdom");
    const moved = await one<{ person_id: number; organization_id: number | null }>(
      "SELECT person_id::int, organization_id::int FROM public.album_credits WHERE id=$1", [credit]);
    expect(moved).toEqual({ person_id: killdom, organization_id: null });
    const alias = await one<{ n: number }>("SELECT count(*)::int AS n FROM ingest.organization_aliases WHERE organization_id=$1", [studio]);
    expect(alias.n).toBe(0);
    const claims = await pool.query<{ id: string; status: string; person_id: number; notes: string | null }>(
      "SELECT id::text, status::text, person_id::int, notes FROM ingest.claims WHERE id=ANY($1::bigint[]) ORDER BY id", [[claimId, claimConNotas]]);
    expect(claims.rows.map((row) => [row.status, row.person_id, row.notes])).toEqual([
      ["accepted", killdom, null],
      ["accepted", killdom, "de la planilla"],
    ]);

    // Y no se deshace dos veces.
    const again = await write("POST", `/audit/${auditId}/undo`, { note: "otra vez" });
    expect(again.statusCode).toBe(409);
  });

  async function personExists(personId: number): Promise<boolean> {
    return (await one<{ n: number }>("SELECT count(*)::int AS n FROM public.persons WHERE id=$1", [personId])).n > 0;
  }
});
