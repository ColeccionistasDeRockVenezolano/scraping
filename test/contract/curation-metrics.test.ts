import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { clearCurationMetricsCache } from "../../src/curation/metrics.js";

const TOKEN = "token-de-prueba-curaduria-metrics-0123456789";
const OPERATOR = "Tester Metrics";

describe("E12 métricas operativas contra PostgreSQL real", () => {
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

    const db = getPool();
    // Un hallazgo accionable N1 y uno informativo. E12 debe excluir el segundo
    // del denominador sin esconderlo de la curaduría.
    await db.query(`
      INSERT INTO ingest.curation_findings
        (fingerprint, category, detector, signature, severity, entity_kind, entity_id, entity_label,
         field, value, title, suggestion, suggested_value)
      VALUES
        ('metrics-actionable', 'nombres_sucios', 'mayusculas_sostenidas', 'mayusculas_sostenidas', 'low',
         'artist', 1, 'BANDA TOTAL CARACAS', 'name', 'BANDA TOTAL CARACAS',
         'Mayúsculas sostenidas', 'Normalizar', 'Banda Total Caracas'),
        ('metrics-informational', 'fichas_sin_vinculos', 'disco_sin_pistas', 'disco_sin_pistas', 'low',
         'album', 2, 'Disco pendiente', 'tracks', 'Disco pendiente',
         'El disco no tiene ninguna pista', 'Completar el tracklist', NULL)`);

    // 20 decisiones concluyentes del mismo detector: 15 confirmadas + 5 falsos
    // positivos = 75 %. La muestra alcanza n=20 y por tanto debe generar alerta.
    for (let n = 0; n < 15; n += 1) {
      await db.query(`
        INSERT INTO ingest.curation_findings
          (fingerprint, category, detector, signature, severity, entity_kind, entity_id, entity_label,
           title, status, resolution, first_seen_at, resolved_at)
        VALUES ($1, 'datos_incoherentes', 'organizacion_sin_clasificar', 'sin_clasificar', 'low',
                'organization', $2, $3, 'Organización sin clasificar', 'resolved', 'fixed_by_curation',
                '2026-09-20 10:00:00+00', '2026-09-20 12:00:00+00')`,
      [`metrics-confirmed-${n}`, 1000 + n, `Org confirmada ${n}`]);
    }
    for (let n = 0; n < 5; n += 1) {
      await db.query(`
        INSERT INTO ingest.curation_findings
          (fingerprint, category, detector, signature, severity, entity_kind, entity_id, entity_label,
           title, status, ignored_at, ignored_by, ignore_reason)
        VALUES ($1, 'datos_incoherentes', 'organizacion_sin_clasificar', 'sin_clasificar', 'low',
                'organization', $2, $3, 'Organización sin clasificar', 'ignored', now(), $4, 'falso_positivo')`,
      [`metrics-rejected-${n}`, 2000 + n, `Org rechazada ${n}`, OPERATOR]);
    }

    const hash = "a".repeat(64);
    const batch = async (mode: string, status: string, note: string | null): Promise<number> =>
      Number((await db.query<{ id: string }>(`
        INSERT INTO ingest.curation_fix_batches(mode, requested_by, applied_by, note, preview_hash, status)
        VALUES ($1, $2, $2, $3, $4, $5) RETURNING id::text`,
      [mode, OPERATOR, note, hash, status])).rows[0]!.id);

    const preview = await batch("group", "previewed", null);
    const autoDone = await batch("auto", "done", "auto aplicada");
    const autoUndone = await batch("auto", "undone", "auto revertida");
    const individual = await batch("individual", "done", "manual aplicada");
    await batch("undo", "done", "deshacer"); // no entra en total

    await db.query(`
      INSERT INTO ingest.curation_fix_items(batch_id, position, action_key, level, status, applied_at)
      VALUES
        ($1, 0, 'capitalizar', 0, 'applied', now()),
        ($1, 1, 'capitalizar', 0, 'applied', now()),
        ($2, 0, 'capitalizar', 0, 'undone', now()),
        ($3, 0, 'capitalizar', 1, 'applied', now())`,
    [autoDone, autoUndone, individual]);
    expect(preview).toBeGreaterThan(0);
    clearCurationMetricsCache();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    await container?.stop();
  }, 60_000);

  it("publica valores exactos de precisión, cobertura y lotes", async () => {
    clearCurationMetricsCache();
    const response = await app.inject({
      method: "GET",
      url: "/curation/summary",
      headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const metrics = body.metrics;

    // El total grande sigue contando todo, pero dice cuánto de eso es
    // informativo: 1 hallazgo accionable y 1 informativo sembrados.
    expect(body.totals.open).toBe(2);
    expect(body.totals.openInformational).toBe(1);

    expect(metrics.actionCoverage).toEqual({
      open: 1,
      excludedInformational: 1,
      level1OrLess: 1,
      level2OrLess: 1,
      level1OrLessPct: 1,
      level2OrLessPct: 1,
    });
    expect(metrics.batches).toEqual({
      total: 4,
      previewed: 1,
      applied: 3,
      undone: 1,
      autoApplied: 2,
      autoReverted: 1,
    });

    const detector = metrics.detectors.find((item: { detector: string }) =>
      item.detector === "organizacion_sin_clasificar");
    expect(detector).toMatchObject({
      reviewed: 20,
      confirmed: 15,
      rejected: 5,
      falsePositives: 5,
      intentional: 0,
      observedPrecision: 0.75,
      meanCorrectionSeconds: 7200,
    });
    expect(metrics.alerts).toContainEqual(expect.objectContaining({
      detector: "organizacion_sin_clasificar",
      precision: 0.75,
      reviewed: 20,
      threshold: 0.8,
      minimumReviewed: 20,
    }));
  }, 30_000);
});
