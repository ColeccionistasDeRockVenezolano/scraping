import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { KEEP_CANDIDATES, compactEntityResolutionDecisions, ER_RETENTION_LOCK } from "../../src/er/retention.js";

// Auditoría BD #1 — La retención compacta el dossier de candidatas de las
// decisiones viejas SIN borrar la decisión, respeta la ventana de días, es
// idempotente, no pisa a quien la esté corriendo y deja intacto todo lo que
// los consumidores leen (candidates->0, input_context, features, explanation).
describe("retención de decisiones de resolución (contrato)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  /** Candidata con la forma real del resolver (features incluidas). */
  function candidate(index: number) {
    return {
      candidateId: 1000 + index,
      canonicalName: `Candidata ${index}`,
      score: Math.max(0, 1 - index / 1000),
      action: index === 0 ? "AUTO_MATCH" : "NO_MATCH",
      nameBasis: "canonical_exact",
      autoEligible: index === 0,
      hasContextSupport: true,
      hardConflicts: [],
      features: [{ key: "name.exact", label: "nombre", value: Math.max(0, 1 - index / 1000), weight: 1, contribution: 1, polarity: "for", evidence: `evidencia de la candidata ${index}` }],
    };
  }

  async function insertDecision(options: { name: string; candidates: number; daysAgo: number }): Promise<number> {
    const list = Array.from({ length: options.candidates }, (_, index) => candidate(index));
    const { rows } = await getPool().query<{ id: string }>(`
      INSERT INTO ingest.entity_resolution_decisions(
        decision_hash, entity_kind, input_name_original, input_name_normalized, input_context,
        score, action, features, candidates, thresholds, explanation, decided_by, created_at)
      VALUES($1,'PERSON',$2,$2,$3::jsonb,$4,'AUTO_MATCH',$5::jsonb,$6::jsonb,$7::jsonb,'explicacion de la decision','deterministic', now() - make_interval(days => $8::int))
      RETURNING id`,
    [
      createHash("sha256").update(`hash-${options.name}`).digest("hex"), options.name,
      JSON.stringify({ kind: "PERSON", name: options.name, bands: ["Banda"] }),
      1, JSON.stringify([{ key: "name.exact" }]), JSON.stringify(list), JSON.stringify({ autoMatch: 0.9 }),
      options.daysAgo,
    ]);
    return Number(rows[0]!.id);
  }

  async function decisionRow(id: number) {
    const { rows } = await getPool().query<{
      compacted_at: Date | null; candidates_count: number | null; candidates: unknown[]; features: unknown;
      input_context: Record<string, unknown>; explanation: string; action: string; score: number;
    }>("SELECT compacted_at, candidates_count, candidates, features, input_context, explanation, action, score FROM ingest.entity_resolution_decisions WHERE id=$1", [id]);
    return rows[0]!;
  }

  it("dry-run cuenta pendientes sin escribir; la corrida real compacta solo lo viejo", async () => {
    const vieja = await insertDecision({ name: "Vieja con 100 candidatas", candidates: 100, daysAgo: 10 });
    const reciente = await insertDecision({ name: "Reciente", candidates: 100, daysAgo: 0 });
    const corta = await insertDecision({ name: "Vieja con 3 candidatas", candidates: 3, daysAgo: 5 });

    const dry = await compactEntityResolutionDecisions({ dryRun: true, keepFullDays: 3 });
    expect(dry).toMatchObject({ status: "ok", dryRun: true, pending: 2, compacted: 0 });
    expect((await decisionRow(vieja)).compacted_at).toBeNull();

    const run = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3 });
    expect(run).toMatchObject({ status: "ok", pending: 2, compacted: 2 });

    // La vieja conserva la decisión y solo pierde el dossier largo.
    const compacted = await decisionRow(vieja);
    expect(compacted.compacted_at).not.toBeNull();
    expect(compacted.candidates_count).toBe(100);
    expect(compacted.candidates).toHaveLength(KEEP_CANDIDATES);
    expect(compacted.candidates[0]).toEqual({ candidateId: 1000, canonicalName: "Candidata 0", score: 1, action: "AUTO_MATCH" });
    // Nada más cambia: features, explanation, acción, score e input_context intactos.
    expect(compacted.features).toEqual([{ key: "name.exact" }]);
    expect(compacted.explanation).toBe("explicacion de la decision");
    expect(compacted.score).toBe(1);
    expect(compacted.input_context).toEqual({ kind: "PERSON", name: "Vieja con 100 candidatas", bands: ["Banda"] });

    // La reciente no se toca: su dossier sigue completo.
    const fresh = await decisionRow(reciente);
    expect(fresh.compacted_at).toBeNull();
    expect(fresh.candidates).toHaveLength(100);

    // Una lista corta también se marca (no se pierde nada): 3 candidatas quedan 3.
    const short = await decisionRow(corta);
    expect(short.compacted_at).not.toBeNull();
    expect(short.candidates_count).toBe(3);
    expect(short.candidates).toHaveLength(3);
  });

  it("los consumidores siguen leyendo lo mismo: candidates->0 y el conteo", async () => {
    const id = await insertDecision({ name: "Consumidores", candidates: 50, daysAgo: 9 });
    await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3 });
    const { rows } = await getPool().query<{ top: string; total: string }>(
      "SELECT candidates->0->>'candidateId' AS top, jsonb_array_length(candidates)::text AS total FROM ingest.entity_resolution_decisions WHERE id=$1", [id]);
    expect(rows[0]!.top).toBe("1000");
    expect(Number(rows[0]!.total)).toBe(KEEP_CANDIDATES);
    expect((await decisionRow(id)).candidates_count).toBe(50);
  });

  it("es idempotente y la ventana manda: sin pendientes no hace nada", async () => {
    const again = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3 });
    expect(again).toMatchObject({ status: "ok", pending: 0, compacted: 0 });

    const id = await insertDecision({ name: "Ventana amplia", candidates: 40, daysAgo: 5 });
    const wide = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 30 });
    expect(wide.compacted).toBe(0);
    expect((await decisionRow(id)).compacted_at).toBeNull();

    const dry = await compactEntityResolutionDecisions({ dryRun: true, keepFullDays: 0 });
    const narrow = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 0 });
    expect(narrow.pending).toBe(dry.pending);
    expect(narrow.compacted).toBe(dry.pending);
    expect((await decisionRow(id)).compacted_at).not.toBeNull();
  });

  it("con el candado tomado por otro proceso responde skipped y no toca nada", async () => {
    const id = await insertDecision({ name: "Con candado", candidates: 20, daysAgo: 9 });
    const holder = await getPool().connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [ER_RETENTION_LOCK]);
      const result = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3 });
      expect(result).toMatchObject({ status: "skipped", compacted: 0 });
      expect((await decisionRow(id)).compacted_at).toBeNull();
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [ER_RETENTION_LOCK]);
      holder.release();
    }
    const after = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3 });
    expect(after.compacted).toBeGreaterThanOrEqual(1);
    expect((await decisionRow(id)).compacted_at).not.toBeNull();
  });

  it("--max-rows acota la corrida y lo pendiente se retoma después", async () => {
    const first = await insertDecision({ name: "Tope A", candidates: 10, daysAgo: 9 });
    const second = await insertDecision({ name: "Tope B", candidates: 10, daysAgo: 9 });
    const capped = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3, maxRows: 1, batchSize: 1 });
    expect(capped.compacted).toBe(1);
    const rest = await compactEntityResolutionDecisions({ dryRun: false, keepFullDays: 3 });
    expect(rest.compacted).toBeGreaterThanOrEqual(1);
    expect((await decisionRow(first)).compacted_at).not.toBeNull();
    expect((await decisionRow(second)).compacted_at).not.toBeNull();
  });
});
