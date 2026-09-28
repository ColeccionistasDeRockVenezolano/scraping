// CRV · Diario de cambios y deshacer por run (migración 0028).
// Contra una PostgreSQL desechable y a través de `app.inject()`:
//   * toda escritura de la API queda en el diario ligada a su run;
//   * editar, crear un crédito, retirar, fusionar, dividir y convertir una
//     persona se deshacen con POST /changes/:runId/undo, y deshacer el
//     deshacer vuelve a aplicarlos (rehacer);
//   * si la ficha cambió después, el deshacer se niega y nombra el cambio
//     posterior;
//   * un proceso de varias transacciones queda ligado con `withRunScope`;
//   * el 404 de una ficha retirada dice qué cambio la retiró;
//   * el diff del core solo ve los disparadores `crv_journal`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { withRunScope } from "../../src/db/run-binding.js";
import { netChanges } from "../../src/merge/journal-undo.js";

const TOKEN = "token-de-prueba-del-diario-0123456789";
const OPERATOR = "Tester Diario";

describe("diario de cambios y deshacer por run (0028)", () => {
  let container: PgContainer;
  let app: FastifyInstance;

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await getPool().query(sql, params)).rows[0] as T;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);

  async function write(method: "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method, url,
      headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
      ...(payload === undefined ? {} : { payload }),
    });
  }
  const expectOk = (response: { statusCode: number; body: string }) => expect(response.statusCode, response.body).toBeLessThan(300);
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
  const undo = (runId: number, note = "deshacer en prueba") => write("POST", `/changes/${runId}/undo`, { note });

  async function createPerson(name: string): Promise<{ id: number; runId: number }> {
    const response = await write("POST", "/persons", { name, note: "alta de prueba", allowSimilar: true });
    expectOk(response);
    return response.json();
  }

  let artistId: number;
  let albumId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
    const artist = await write("POST", "/artists", { name: "Banda del Diario", note: "alta de prueba" });
    artistId = artist.json().id;
    const album = await write("POST", "/albums", { title: "Disco del Diario", artistId, note: "alta de prueba" });
    albumId = album.json().id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"];
    resetEnvCache();
    await container?.stop();
  }, 60_000);

  it("reduce varios cambios de una fila a antes/después", () => {
    const rows = [
      { id: 1, table_name: "public.persons", op: "U" as const, row_pk: { id: 1 }, old_data: { name: "A" }, new_data: { name: "B" } },
      { id: 2, table_name: "public.persons", op: "U" as const, row_pk: { id: 1 }, old_data: { name: "B", notes: null }, new_data: { name: "C", notes: "x" } },
      { id: 3, table_name: "public.persons", op: "I" as const, row_pk: { id: 2 }, old_data: null, new_data: { id: 2, name: "N" } },
      { id: 4, table_name: "public.persons", op: "D" as const, row_pk: { id: 2 }, old_data: { id: 2, name: "N" }, new_data: null },
      { id: 5, table_name: "public.persons", op: "D" as const, row_pk: { id: 3 }, old_data: { id: 3, name: "Z" }, new_data: null },
    ];
    const net = netChanges(rows);
    expect(net).toHaveLength(2);
    expect(net[0]).toMatchObject({ existedBefore: true, before: { name: "A", notes: null }, after: { name: "C", notes: "x" } });
    expect(net[1]).toMatchObject({ existedBefore: true, before: { id: 3, name: "Z" }, after: null });
  });

  it("una edición queda en el diario, se deshace y se rehace", async () => {
    const person = await createPerson("Pedro Diario");
    const edit = await write("PATCH", `/persons/${person.id}`, { name: "Pedro J. Diario", nationality: "Venezuela", note: "corrección de prueba" });
    expectOk(edit);
    const editRun = edit.json().runId as number;
    expect(await count("SELECT count(*) n FROM ingest.change_journal WHERE run_id=$1 AND table_name='public.persons'", [editRun])).toBeGreaterThan(0);

    const detail = await get(`/changes/${editRun}`);
    expectOk(detail);
    expect(detail.json()).toMatchObject({ runId: editRun, journaled: true, undo: { undoable: true, method: "journal" } });
    expect(detail.json().entities).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "person", id: person.id })]));

    const undone = await undo(editRun);
    expectOk(undone);
    const undoRun = undone.json().runId as number;
    expect(await one("SELECT name, nationality FROM public.persons WHERE id=$1", [person.id])).toEqual({ name: "Pedro Diario", nationality: null });
    // El alias que dejó el renombrado también se fue.
    expect(await count("SELECT count(*) n FROM ingest.person_aliases WHERE person_id=$1 AND alias='Pedro J. Diario'", [person.id])).toBe(0);
    expect((await get(`/changes/${editRun}`)).json()).toMatchObject({ undoneBy: undoRun, undo: { undoable: false } });
    expect((await undo(editRun)).statusCode).toBe(409);

    // Rehacer: deshacer el deshacer.
    const redone = await undo(undoRun, "rehacer en prueba");
    expectOk(redone);
    expect(await one("SELECT name, nationality FROM public.persons WHERE id=$1", [person.id])).toEqual({ name: "Pedro J. Diario", nationality: "Venezuela" });
    expect((await get(`/changes/${editRun}`)).json().undoneBy).toBeNull();
    // El historial lo nombra como rehacer del cambio original.
    expect((await get(`/changes/${redone.json().runId}`)).json()).toMatchObject({ undoOf: undoRun, redoOf: editRun });
    expect((await get(`/changes/${undoRun}`)).json()).toMatchObject({ undoOf: editRun, redoOf: null });

    const history = await get(`/changes?entity=person&id=${person.id}`);
    expect(history.json().data.map((row: { runId: number }) => row.runId)).toEqual(expect.arrayContaining([editRun, undoRun, redone.json().runId]));
  });

  it("si la ficha cambió después, no se deshace y nombra el cambio posterior", async () => {
    const person = await createPerson("Rosa Diario");
    const first = (await write("PATCH", `/persons/${person.id}`, { nationality: "Venezuela", note: "primera" })).json().runId as number;
    const second = (await write("PATCH", `/persons/${person.id}`, { nationality: "Colombia", note: "segunda" })).json().runId as number;
    const refused = await undo(first);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.laterRunIds).toEqual([second]);
    expect((await get(`/changes/${first}`)).json().undo).toMatchObject({ undoable: false });
    // En orden inverso, sí.
    expectOk(await undo(second));
    expectOk(await undo(first));
    expect((await one<{ nationality: string | null }>("SELECT nationality FROM public.persons WHERE id=$1", [person.id])).nationality).toBeNull();
  });

  it("crear un crédito y retirar una ficha se deshacen; el 404 dice qué cambio la retiró", async () => {
    const person = await createPerson("Luis Crédito");
    const credit = await write("POST", "/album-credits", { albumId, personId: person.id, role: "Guitarra", note: "crédito de prueba" });
    expectOk(credit);
    const creditId = credit.json().id as number;
    expectOk(await undo(credit.json().runId));
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE id=$1", [creditId])).toBe(0);
    // El claim del crédito no se borró: quedó sustituido.
    expect(await count("SELECT count(*) n FROM ingest.claims WHERE run_id=$1 AND status='superseded'", [credit.json().runId])).toBeGreaterThan(0);

    const orphan = await createPerson("Ficha Huérfana");
    const removed = await write("DELETE", `/persons/${orphan.id}?note=${encodeURIComponent("retiro de prueba")}`);
    expectOk(removed);
    const missing = await app.inject({ method: "GET", url: `/persons/${orphan.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.details).toMatchObject({ removedByRun: removed.json().runId });
    expectOk(await undo(removed.json().runId));
    expect(await one("SELECT name FROM public.persons WHERE id=$1", [orphan.id])).toEqual({ name: "Ficha Huérfana" });
  });

  it("fusionar dos personas se deshace entero, créditos incluidos", async () => {
    const keep = await createPerson("Ana Fusión");
    const drop = await createPerson("Ana Fusion");
    await write("POST", "/album-credits", { albumId, personId: drop.id, role: "Voz", note: "crédito del duplicado" });
    const preview = await get(`/persons/${keep.id}/merge-preview?with=${drop.id}`);
    expectOk(preview);
    const merged = await write("POST", `/persons/${keep.id}/merge`, {
      dropId: drop.id, previewHash: preview.json().previewHash, keepDropNameAsAlias: true, note: "misma persona",
    });
    expectOk(merged);
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [drop.id])).toBe(0);

    const undone = await undo(merged.json().runId);
    expectOk(undone);
    expect(await one("SELECT name FROM public.persons WHERE id=$1", [drop.id])).toEqual({ name: "Ana Fusion" });
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE person_id=$1", [drop.id])).toBe(1);
    expect(await count("SELECT count(*) n FROM ingest.entity_redirects WHERE entity_kind='person' AND from_id=$1", [drop.id])).toBe(0);
  });

  it("dividir una persona se deshace: vuelve la ficha combinada y se retiran las nuevas", async () => {
    const combined = await createPerson("Juan y Pedro Díaz");
    await write("POST", "/album-credits", { albumId, personId: combined.id, role: "Coros", note: "crédito combinado" });
    await write("POST", "/artist-members", { artistId, personId: combined.id, role: "Coros", note: "membresía combinada" });
    const split = await write("POST", `/persons/${combined.id}/split`, { into: ["Juan Díaz", "Pedro Díaz"], note: "dos personas" });
    expectOk(split);
    const targets = split.json().targetIds as number[];
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [combined.id])).toBe(0);

    const undone = await undo(split.json().runId);
    expectOk(undone);
    expect(await one("SELECT name FROM public.persons WHERE id=$1", [combined.id])).toEqual({ name: "Juan y Pedro Díaz" });
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE person_id=$1", [combined.id])).toBe(1);
    expect(await count("SELECT count(*) n FROM public.artist_members WHERE person_id=$1", [combined.id])).toBe(1);
    expect(await count("SELECT count(*) n FROM public.persons WHERE id = ANY($1::bigint[])", [targets])).toBe(0);
    // Los claims de la ficha combinada vuelven a apuntarla.
    expect(await count("SELECT count(*) n FROM ingest.claims WHERE person_id=$1 AND status NOT IN ('rejected','superseded')", [combined.id])).toBeGreaterThan(0);

    // Y rehacer la división la vuelve a aplicar.
    expectOk(await undo(undone.json().runId, "rehacer la división"));
    expect(await count("SELECT count(*) n FROM public.persons WHERE id=$1", [combined.id])).toBe(0);
    expect(await count("SELECT count(*) n FROM public.persons WHERE id = ANY($1::bigint[])", [targets])).toBe(2);
  });

  it("convertir una persona en organización se deshace", async () => {
    const person = await createPerson("Estudios Diario");
    await write("POST", "/album-credits", { albumId, personId: person.id, role: "Grabación", note: "crédito de estudio" });
    const converted = await write("POST", `/persons/${person.id}/convert`, {
      to: "organization", create: { name: "Estudios Diario C.A.", organizationType: "recording_studio" }, keepNameAsAlias: true, note: "es un estudio",
    });
    expectOk(converted);
    const organizationId = converted.json().organizationId ?? converted.json().targetId ?? converted.json().target?.id;
    const undone = await undo(converted.json().runId);
    expectOk(undone);
    expect(await one("SELECT name FROM public.persons WHERE id=$1", [person.id])).toEqual({ name: "Estudios Diario" });
    expect(await count("SELECT count(*) n FROM public.album_credits WHERE person_id=$1", [person.id])).toBe(1);
    if (organizationId) expect(await count("SELECT count(*) n FROM public.organizations WHERE id=$1", [organizationId])).toBe(0);
    expect(await count("SELECT count(*) n FROM public.organizations WHERE name='Estudios Diario C.A.'")).toBe(0);
  });

  it("un proceso de varias transacciones queda ligado con withRunScope", async () => {
    const run = Number((await one<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','ok','{\"action\":\"prueba_alcance\"}') RETURNING id")).id);
    await withRunScope(run, async () => {
      await getPool().query("INSERT INTO public.persons(name) VALUES('Alcance Uno')");
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO public.persons(name) VALUES('Alcance Dos')");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    });
    // Fuera del alcance, la misma conexión ya no lleva el run.
    await getPool().query("INSERT INTO public.persons(name) VALUES('Sin Alcance')");
    expect(await count("SELECT count(*) n FROM ingest.change_journal WHERE run_id=$1 AND op='I' AND table_name='public.persons'", [run])).toBe(2);
    expect(await count("SELECT count(*) n FROM ingest.change_journal WHERE run_id IS NULL AND new_data->>'name'='Sin Alcance'")).toBe(1);
    expectOk(await undo(run));
    expect(await count("SELECT count(*) n FROM public.persons WHERE name IN ('Alcance Uno','Alcance Dos')")).toBe(0);
  });

  it("el listado general marca deshechos y deshacer", async () => {
    const list = await get("/changes?limit=100&journaled=true");
    expectOk(list);
    const rows = list.json().data as Array<{ runId: number; undoneBy: number | null; undoOf: number | null; action: string | null }>;
    expect(rows.some((row) => row.undoOf !== null && row.action === "api:undo:run")).toBe(true);
    expect(rows.some((row) => row.undoneBy !== null)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/changes" })).statusCode).toBe(401);
  });
});
