import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { runDoctor } from "../../src/doctor/index.js";

// Auditoría de pruebas #4 — `doctor` decide si el core fue alterado y si la
// auditoría cubre todo lo escrito; su lógica de catálogo estaba probada
// (core-catalog.test.ts) pero el orquestador no. Aquí se ejerce completo:
// verde en una base recién migrada, y cada detección real (drift en `public`,
// filas sin auditoría, aviso de fuentes) con su vuelta a verde.
describe("doctor — integridad operativa (contrato)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  const check = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) => report.checks.find((item) => item.name === name)!;

  it("base recién migrada: sin fallos; las fuentes sin sembrar son un aviso accionable", async () => {
    const report = await runDoctor();
    expect(report.ok).toBe(true);
    expect(check(report, "runtime.node").status).toBe("ok");
    expect(check(report, "db.connection").status).toBe("ok");
    expect(check(report, "core.hash").status).toBe("ok");
    expect(check(report, "core.catalog").status).toBe("ok");
    expect(check(report, "aux.schemas").status).toBe("ok");
    expect(check(report, "merge_audit.coverage").status).toBe("ok");
    expect(check(report, "migrations.applied").detail).toContain("0022_er_decisions_retention");
    expect(check(report, "sources.status").status).toBe("warn");
    expect(check(report, "sources.status").detail).toContain("sources:seed");
    expect(report.warnings).toBe(1);
  });

  it("una fila canónica sin auditoría se detecta (merge_audit.coverage)", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO public.persons(name) VALUES('Persona Sin Auditoría QA') RETURNING id");
    const report = await runDoctor();
    expect(report.ok).toBe(false);
    expect(check(report, "merge_audit.coverage").status).toBe("fail");
    expect(check(report, "merge_audit.coverage").detail).toContain("1 filas canónicas sin auditoría");
    await getPool().query("DELETE FROM public.persons WHERE id=$1", [Number(rows[0]!.id)]);
    expect((await runDoctor()).ok).toBe(true);
  });

  it("el drift del schema public se detecta entrada por entrada y se recupera", async () => {
    await getPool().query("ALTER TABLE public.artists ADD COLUMN drift_probe_qa text");
    const drifted = await runDoctor();
    expect(drifted.ok).toBe(false);
    expect(check(drifted, "core.catalog").status).toBe("fail");
    expect(check(drifted, "core.catalog").detail).toContain("DRIFT");
    await getPool().query("ALTER TABLE public.artists DROP COLUMN drift_probe_qa");
    expect(check(await runDoctor(), "core.catalog").status).toBe("ok");
  });

  it("con una fuente habilitada el aviso de fuentes pasa a verde", async () => {
    await getPool().query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled)
      VALUES('fuente-qa','Fuente QA','website','high',true)`);
    const report = await runDoctor();
    expect(check(report, "sources.status").status).toBe("ok");
    expect(check(report, "sources.status").detail).toBe("1 fuentes registradas, 1 habilitadas");
    expect(report.warnings).toBe(0);
    expect(report.ok).toBe(true);
  });
});
