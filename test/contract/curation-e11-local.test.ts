import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan, waitForCurationScans } from "../../src/curation/scan.js";

const TOKEN = "token-e11-local-01234567890123456789";
const OPERATOR = "Tester E11 local";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("E11 local: corregir → verificar → cerrar", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let artistId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
    artistId = Number((await getPool().query<{ id: string }>(
      "INSERT INTO public.artists(name) VALUES('BANDA TOTAL CARACAS') RETURNING id::text",
    )).rows[0]!.id);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    await container?.stop();
  }, 60_000);

  it("una edición de una ficha cierra mayusculas_sostenidas en el análisis dirigido inmediato", async () => {
    expect((await runCurationScan({ trigger: "manual" })).status).toBe("ok");
    const before = await getPool().query<{ id: string; status: string }>(`
      SELECT id::text, status FROM ingest.curation_findings
       WHERE detector='mayusculas_sostenidas' AND entity_kind='artist' AND entity_id=$1`, [artistId]);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]!.status).toBe("open");

    const previousScan = Number((await getPool().query<{ id: string }>(
      "SELECT coalesce(max(id),0)::text AS id FROM ingest.curation_scans",
    )).rows[0]!.id);
    const patched = await app.inject({
      method: "PATCH",
      url: `/artists/${artistId}`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
      payload: { name: "Banda Total Caracas" },
    });
    expect(patched.statusCode).toBe(200);

    const deadline = Date.now() + 20_000;
    let directed: { id: string; scope: string; status: string } | undefined;
    while (Date.now() < deadline) {
      const rows = (await getPool().query<{ id: string; scope: string; status: string }>(`
        SELECT id::text, scope, status FROM ingest.curation_scans
         WHERE id > $1 AND trigger='correccion' AND status IN ('ok','partial')
         ORDER BY id DESC LIMIT 1`, [previousScan])).rows;
      if (rows[0]) { directed = rows[0]; break; }
      await sleep(150);
    }
    await waitForCurationScans();
    expect(directed).toMatchObject({ scope: "dirigido", status: "ok" });

    const after = await getPool().query<{ status: string; resolution: string | null }>(`
      SELECT status, resolution FROM ingest.curation_findings
       WHERE detector='mayusculas_sostenidas' AND entity_kind='artist' AND entity_id=$1`, [artistId]);
    expect(after.rows[0]).toMatchObject({ status: "resolved", resolution: "changed_elsewhere" });
  }, 60_000);
});
