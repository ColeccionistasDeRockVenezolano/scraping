// CRV · E11.4 — API de fusión de personas.
// Contra una PostgreSQL desechable y a través de `app.inject()`: el flujo
// completo previsualización → fusión, la credencial obligatoria para escribir,
// el candado del hash (`stale_preview`) y la redirección del id fusionado.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";

const TOKEN = "token-de-prueba-fusion-personas-0123456789";
const OPERATOR = "Tester Fusión";

describe("API de fusión de personas (E11.4)", () => {
  let container: PgContainer;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"];
    resetEnvCache();
    await container?.stop();
  }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);

  const newPerson = (name: string, values: Record<string, string> = {}) => {
    const columns = ["name", ...Object.keys(values)];
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    return one(`INSERT INTO public.persons(${columns.join(",")}) VALUES(${placeholders.join(",")}) RETURNING id`,
      [name, ...Object.values(values)]);
  };

  const preview = (keepId: number, dropId: number) => app.inject({
    method: "GET", url: `/persons/${keepId}/merge-preview?with=${dropId}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  const merge = (keepId: number, payload: Record<string, unknown>) => app.inject({
    method: "POST", url: `/persons/${keepId}/merge`,
    headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
    payload,
  });

  it("sin credenciales no se fusiona ni se compara", async () => {
    const keep = await newPerson("Api Fusion A");
    const drop = await newPerson("Api Fusion B");
    const anonymous = await app.inject({ method: "POST", url: `/persons/${keep}/merge`, payload: { dropId: drop } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: "unauthorized" } });

    const anonymousPreview = await app.inject({ method: "GET", url: `/persons/${keep}/merge-preview?with=${drop}` });
    expect(anonymousPreview.statusCode).toBe(401);

    const read = await preview(keep, drop);
    expect(read.statusCode).toBe(200);
    expect(read.json().previewHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("flujo completo: previsualizar, elegir campos y fusionar con run del operador", async () => {
    const keep = await newPerson("Flujo Completo A", { nationality: "Venezolana" });
    const drop = await newPerson("Flujo Completo B", { biography: "Biografía que llega del duplicado", nationality: "Argentina" });

    const previewRes = await preview(keep, drop);
    expect(previewRes.statusCode).toBe(200);
    const previewBody = previewRes.json();
    expect(previewBody.fieldConflicts).toEqual([
      { field: "nationality", keepValue: "Venezolana", dropValue: "Argentina" },
    ]);
    expect(previewBody.fieldsFilledFromDrop).toEqual(["biography"]);
    expect(previewBody.drop.id).toBe(drop);

    const merged = await merge(keep, {
      dropId: drop, previewHash: previewBody.previewHash,
      fieldChoices: { nationality: "drop" }, keepDropNameAsAlias: true, note: "prueba del flujo completo",
    });
    expect(merged.statusCode).toBe(200);
    const body = merged.json();
    expect(body).toMatchObject({
      keepId: keep, dropId: drop, fieldsCorrected: ["nationality"], creditsMerged: 0, membershipsMerged: 0,
    });
    expect(body.runId).toBeGreaterThan(0);
    expect(body.filled).toContain("biography");

    const detail = (await app.inject({ method: "GET", url: `/persons/${keep}` })).json();
    expect(detail).toMatchObject({ name: "Flujo Completo A", nationality: "Argentina", biography: "Biografía que llega del duplicado" });
    expect(detail.aliases.map((alias: { alias: string }) => alias.alias)).toContain("Flujo Completo B");

    // El run quedó registrado con operador, nota y motivo.
    const runResponse = await app.inject({
      method: "GET", url: `/runs/${body.runId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(runResponse.statusCode).toBe(200);
    const run = runResponse.json();
    expect(run).toMatchObject({ kind: "manual", status: "ok", params: { action: "api:merge:person", operator: OPERATOR, note: "prueba del flujo completo" } });

    // El id que desapareció ya no existe, pero lleva a la ficha que quedó.
    const gone = await app.inject({ method: "GET", url: `/persons/${drop}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.details.movedTo).toEqual({ kind: "person", id: keep });
  });

  it("un hash viejo responde 409 stale_preview y no cambia nada", async () => {
    const keep = await newPerson("Api Stale A");
    const drop = await newPerson("Api Stale B");
    const previewBody = (await preview(keep, drop)).json();
    await getPool().query("UPDATE public.persons SET biography='editada después' WHERE id=$1", [keep]);

    const stale = await merge(keep, {
      dropId: drop, previewHash: previewBody.previewHash, keepDropNameAsAlias: true, note: "prueba de hash viejo",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "stale_preview" } });
    expect((await app.inject({ method: "GET", url: `/persons/${drop}` })).statusCode).toBe(200);
  });

  it("fusionar consigo misma es 422 y un id inexistente es 404 con movedTo cuando aplica", async () => {
    const keep = await newPerson("Api Invalida");
    const samePreview = (await preview(keep, keep)).statusCode;
    expect(samePreview).toBe(422);
    const same = await merge(keep, {
      dropId: keep, previewHash: "0".repeat(64), keepDropNameAsAlias: true, note: "prueba inválida",
    });
    expect(same.statusCode).toBe(422);
    expect(same.json()).toMatchObject({ error: { code: "invalid" } });

    const missing = await preview(keep, 999_999);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("exige nota y un cuerpo estricto", async () => {
    const keep = await newPerson("Api Cuerpo A");
    const drop = await newPerson("Api Cuerpo B");
    const previewBody = (await preview(keep, drop)).json();
    const withoutNote = await merge(keep, { dropId: drop, previewHash: previewBody.previewHash, keepDropNameAsAlias: true });
    expect(withoutNote.statusCode).toBe(400);
    const unknownField = await merge(keep, {
      dropId: drop, previewHash: previewBody.previewHash, keepDropNameAsAlias: true, note: "nota", sobra: 1,
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it("los endpoints salen en OpenAPI", async () => {
    const spec = (await app.inject({ method: "GET", url: "/docs/json" })).json();
    expect(spec.paths["/persons/{id}/merge-preview"]).toBeDefined();
    expect(spec.paths["/persons/{id}/merge"]).toBeDefined();
  });
});
