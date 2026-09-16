import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { findPersonCandidates, openPersonCandidateReviews } from "../../src/review/person-candidates.js";

// E11.5 — El detector propone sin decidir, de forma idempotente y explicable.
describe("detector de candidatos de persona (contrato)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  async function one(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  }

  const newPerson = (name: string) => one("INSERT INTO public.persons(name) VALUES($1) RETURNING id", [name]);

  it("propone el par con apodo, bloquea estudios y excluye lo ya careado", async () => {
    const keep = await newPerson('Carlos "Nene" Quintero');
    const drop = await newPerson("Carlos Quintero");
    // Un estudio no es una persona: jamás se propone, aunque los nombres se parezcan.
    await newPerson("Black Cat Studio");
    await newPerson("Black Beans Music Studio");

    const scan = await findPersonCandidates();
    expect(scan.candidates.map((candidate) => [candidate.a.id, candidate.b.id]).sort())
      .toEqual([[Math.min(keep, drop), Math.max(keep, drop)]]);
    expect(scan.candidates[0]!.score).toBeGreaterThanOrEqual(0.6);
    expect(scan.candidates[0]!.priority).toBe(3);
    expect(scan.candidates[0]!.features.map((feature) => feature.key)).toContain("nickname_equal");

    // La revisión quedó abierta y el par ya no se vuelve a proponer.
    const opened = await openPersonCandidateReviews(scan.candidates, "prueba de candidatos", "prueba");
    expect(opened).toMatchObject({ opened: 1, skipped: 0 });
    const again = await findPersonCandidates();
    expect(again.candidates).toEqual([]);
  });

  it("correr dos veces no duplica la revisión viva", async () => {
    const a = await newPerson("Duplicado Idempotente A");
    const b = await newPerson("Duplicado Idempotente B");
    // Con el mismo nombre y sin contexto el score es bajo; se propone forzando el mínimo.
    const first = await findPersonCandidates({ minScore: 0 });
    const pairs = first.candidates.filter((candidate) => [candidate.a.id, candidate.b.id].includes(a));
    expect(pairs).toHaveLength(1);
    const opened = await openPersonCandidateReviews(pairs, "prueba de idempotencia", "prueba");
    expect(opened.opened).toBe(1);
    const second = await openPersonCandidateReviews(pairs, "prueba de idempotencia", "prueba");
    expect(second.opened).toBe(0);
    expect(second.skipped).toBe(1);
    expect(Number((await getPool().query<{ n: string }>(
      "SELECT count(*) n FROM ingest.review_queue WHERE kind='person_duplicate' AND person_a_id=$1 AND person_b_id=$2",
      [Math.min(a, b), Math.max(a, b)])).rows[0]!.n)).toBe(1);
  });

  it("un par descartado como «son distintas» no vuelve a proponerse", async () => {
    const a = await newPerson("Par Descartado A");
    const b = await newPerson("Par Descartado B");
    const scan = await findPersonCandidates({ minScore: 0 });
    const pair = scan.candidates.filter((candidate) => [candidate.a.id, candidate.b.id].includes(a) && [candidate.a.id, candidate.b.id].includes(b));
    expect(pair).toHaveLength(1);
    await openPersonCandidateReviews(pair, "prueba de descarte", "prueba");
    await getPool().query(
      "UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolved_at=now() WHERE kind='person_duplicate' AND person_a_id=$1 AND person_b_id=$2",
      [Math.min(a, b), Math.max(a, b)]);

    const after = await findPersonCandidates({ minScore: 0 });
    expect(after.candidates.filter((candidate) => [candidate.a.id, candidate.b.id].includes(a))).toEqual([]);
  });
});
