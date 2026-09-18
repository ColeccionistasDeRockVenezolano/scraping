// CRV · Escritura de alias (PHASES §E8). Contra una PostgreSQL desechable:
// alta, corrección (incluida la única bandera is_primary), retiro, y que
// los alias vuelvan en la ficha agregada de lectura.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";

const TOKEN = "token-de-prueba-de-alias-0123456789ab";
const OPERATOR = "Tester Alias";

describe("API de escritura de alias (E8)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let artistId: number;
  /** El alta de una entidad ya siembra un alias primario igual al nombre canónico (merge/engine.ts). */
  let seededAliasId: number;

  async function write(method: "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method, url,
      headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
    const created = await write("POST", "/artists", { name: "Azúcar Cacao y Leche", note: "fixture" });
    artistId = created.json().id;
    const seeded = (await app.inject({ method: "GET", url: `/artists/${artistId}` })).json();
    seededAliasId = seeded.aliases[0].id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"];
    resetEnvCache();
    await container?.stop();
  }, 60_000);

  it("sin token no se escribe", async () => {
    const anon = await app.inject({ method: "POST", url: `/artists/${artistId}/aliases`, payload: { alias: "Azúcar, Cacao & Leche" } });
    expect(anon.statusCode).toBe(401);
  });

  it("añade, corrige y retira un alias; queda en la ficha de lectura", async () => {
    const created = await write("POST", `/artists/${artistId}/aliases`, {
      alias: "Azúcar, Cacao & Leche", aliasType: "spelling_variant", isPrimary: true, note: "nombre del canal",
    });
    expect(created.statusCode).toBe(201);
    const alias = created.json();
    expect(alias).toMatchObject({ entityId: artistId, alias: "Azúcar, Cacao & Leche", aliasType: "spelling_variant", isPrimary: true });

    // La alta desplaza al alias sembrado por la propia creación de la entidad
    // (merge/engine.ts crea uno igual al nombre canónico, marcado primario).
    const detail = (await app.inject({ method: "GET", url: `/artists/${artistId}` })).json();
    expect(detail.aliases.find((row: { id: number }) => row.id === alias.id))
      .toEqual({ id: alias.id, alias: "Azúcar, Cacao & Leche", aliasType: "spelling_variant", isPrimary: true });
    expect(detail.aliases.find((row: { id: number }) => row.id === seededAliasId).isPrimary).toBe(false);

    const second = await write("POST", `/artists/${artistId}/aliases`, { alias: "ACYL", aliasType: "acronym", isPrimary: true, note: "sigla" });
    expect(second.statusCode).toBe(201);
    const secondAlias = second.json();

    // La segunda alta con is_primary=true desplaza a la anterior: solo un primario por entidad.
    const afterSecond = (await app.inject({ method: "GET", url: `/artists/${artistId}` })).json();
    expect(afterSecond.aliases).toHaveLength(3);
    expect(afterSecond.aliases.find((row: { id: number }) => row.id === alias.id).isPrimary).toBe(false);
    expect(afterSecond.aliases.find((row: { id: number }) => row.id === secondAlias.id).isPrimary).toBe(true);

    const duplicate = await write("POST", `/artists/${artistId}/aliases`, { alias: "ACYL", note: "repetido" });
    expect(duplicate.statusCode).toBe(409);

    const corrected = await write("PATCH", `/artists/${artistId}/aliases/${alias.id}`, { alias: "Azúcar Cacao y Leche (variante)", note: "ortografía" });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({ alias: "Azúcar Cacao y Leche (variante)" });

    const removed = await write("DELETE", `/artists/${artistId}/aliases/${secondAlias.id}`, { note: "ya no aplica" });
    expect(removed.statusCode).toBe(200);
    const finalDetail = (await app.inject({ method: "GET", url: `/artists/${artistId}` })).json();
    expect(finalDetail.aliases.find((row: { id: number }) => row.id === alias.id))
      .toEqual({ id: alias.id, alias: "Azúcar Cacao y Leche (variante)", aliasType: "spelling_variant", isPrimary: false });
    expect(finalDetail.aliases).toHaveLength(2);
  });

  it("404 sobre entidad o alias inexistente", async () => {
    const missingEntity = await write("POST", "/artists/999999/aliases", { alias: "X", note: "n" });
    expect(missingEntity.statusCode).toBe(404);
    const missingAlias = await write("PATCH", `/artists/${artistId}/aliases/999999`, { alias: "X", note: "n" });
    expect(missingAlias.statusCode).toBe(404);
  });
});
