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

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

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

  it("una auditoría reciente sin run avisa (sin tumbar el doctor); el histórico se tolera", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      "INSERT INTO public.persons(name) VALUES('Persona Con Auditoría Sin Run QA') RETURNING id");
    const personId = Number(rows[0]!.id);
    // Un claim (para que la auditoría no quede huérfana) y la auditoría sin run.
    const claim = await getPool().query<{ id: string }>(`
      INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status,identity_key)
      SELECT (SELECT id FROM ingest.sources ORDER BY id LIMIT 1),'person',$1,'name',to_jsonb(p.name),
             encode(sha256(convert_to('qa-sin-run:'||p.id,'UTF8')),'hex'),'accepted','qa-sin-run:'||p.id
        FROM public.persons p WHERE p.id=$1
      RETURNING id`, [personId]);
    const claimId = Number(claim.rows[0]!.id);
    const audit = await getPool().query<{ id: string }>(
      `INSERT INTO ingest.merge_audit(person_id,entity_kind,field,old_value,new_value,reason,confidence,performed_by,at)
       VALUES($1,'person'::ingest.claim_entity_kind,'name','"A"'::jsonb,'"B"'::jsonb,'prueba sin run','high'::ingest.confidence_level,'human'::ingest.actor_kind,now())
       RETURNING id`, [personId]);
    const auditId = Number(audit.rows[0]!.id);
    await getPool().query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [auditId, claimId]);

    const report = await runDoctor();
    expect(report.ok).toBe(true);
    const coverage = check(report, "merge_audit.coverage");
    expect(coverage.status).toBe("warn");
    expect(coverage.detail).toContain("sin run");
    expect(report.warnings).toBe(1);

    // Retirada la fila nueva, el chequeo vuelve a ok; si quedaran históricas
    // viejas (> 3 días) el detalle las nombra sin convertirlo en aviso.
    await getPool().query("DELETE FROM ingest.merge_audit_claims WHERE merge_audit_id=$1", [auditId]);
    await getPool().query("DELETE FROM ingest.merge_audit WHERE id=$1", [auditId]);
    await getPool().query("DELETE FROM ingest.claims WHERE id=$1", [claimId]);
    await getPool().query("DELETE FROM public.persons WHERE id=$1", [personId]);
    expect(check(await runDoctor(), "merge_audit.coverage").status).toBe("ok");
  });
});
