// CRV · Valores en disputa sin revisión viva (PLAN_CURADURIA E7.1/E7.2).
//
// `conflictos_abiertos` son conflictos de `ingest.conflicts` cuya revisión se
// cerró por otra vía (la pareja conflicto+revisión nace junta en
// src/conflicts/engine.ts, pero nada impide cerrar la revisión sin resolver el
// conflicto): la tarjeta necesita resolverlos igual, con la evidencia de cada
// fuente, y la acción de grupo «aplicar la fuente de mayor confianza» decide
// por `trust_level` cuando no hay empate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { runCurationScan } from "../../src/curation/scan.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { persistClaim, type ClaimToPersist } from "../../src/claims/persistence.js";
import { mergeClaim } from "../../src/merge/engine.js";

const TOKEN = "token-de-prueba-conflictos-abiertos-01234";
const OPERATOR = "Tester Conflictos";

interface FindingRow { id: string; evidence: Record<string, unknown> }

describe("valores en disputa sin revisión viva (E7)", () => {
  let container: PgContainer;
  let app: FastifyInstance;
  let sourceHigh: number;
  let sourceLow: number;
  let evidence = 0;

  const pool = () => getPool();
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pool().query(sql, params)).rows[0] as T;

  async function write(method: "POST", url: string, payload: Record<string, unknown>) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}`, "x-crv-operator": OPERATOR }, payload });
  }

  /** Claim de una fuente, como lo dejaría la ingesta, pasado por el merge (igual que api-write.test.ts). */
  async function sourceClaim(sourceId: number, field: string, value: unknown, albumId: number) {
    evidence += 1;
    const normalized = normalizeRecord({
      entityKind: "album", identity: `Curaduria Conflictos::disco ${albumId}`, extractor: "curation-conflicts-fixture", extractorVersion: "1",
      fields: [{ field, value, evidence: { url: `https://fixture.invalid/curation-conflicts/${evidence}` } }],
    })[0]!;
    const input: ClaimToPersist = { ...normalized, sourceId, confidence: "high", albumId };
    const persisted = await persistClaim(input);
    return { persisted, outcome: await mergeClaim(input, persisted) };
  }

  /**
   * Deja un conflicto abierto SIN revisión viva: crea el par conflicto+revisión
   * (como el motor de conflictos lo hace siempre) y cierra la revisión por otra
   * vía, sin pasar por `resolveFieldConflict` — el escenario exacto de
   * `conflictos_abiertos` (src/curation/detectors/queue.ts).
   */
  async function orphanConflict(title: string, first: number, second: number) {
    // `allowSimilar`: los títulos de esta prueba comparten prefijo a propósito
    // (son discos huérfanos de la misma banda) y el ER los marcaría parecidos.
    const album = Number((await write("POST", "/albums", { artistId: await artistId(), title, allowSimilar: true })).json().id);
    const a = await sourceClaim(sourceHigh, "release_year", first, album);
    expect(a.outcome.action).toBe("applied");
    const b = await sourceClaim(sourceLow, "release_year", second, album);
    expect(b.outcome.action).toBe("conflict");
    const conflict = await one<{ id: string }>(
      "SELECT id::text FROM ingest.conflicts WHERE claim_b_id=$1", [b.persisted.id]);
    await pool().query(
      "UPDATE ingest.review_queue SET status='dismissed',resolved_by='system',resolution_note='cerrada sin resolver (fixture)',resolved_at=now() WHERE conflict_id=$1",
      [conflict.id]);
    return { albumId: album, conflictId: Number(conflict.id) };
  }

  let cachedArtistId: number | undefined;
  async function artistId(): Promise<number> {
    if (cachedArtistId !== undefined) return cachedArtistId;
    cachedArtistId = Number((await write("POST", "/artists", { name: "Banda de Conflictos Abiertos" })).json().id);
    return cachedArtistId;
  }

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    sourceHigh = Number((await one<{ id: string }>(
      "INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled) VALUES('fuente-alta','Fuente Alta','https://fuente-alta.invalid','website','high',true) RETURNING id")).id);
    sourceLow = Number((await one<{ id: string }>(
      "INSERT INTO ingest.sources(slug,name,url,site_type,trust_level,enabled) VALUES('fuente-baja','Fuente Baja','https://fuente-baja.invalid','website','low',true) RETURNING id")).id);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close(); await closeDb();
    delete process.env["CRV_OPERATOR_TOKEN"]; resetEnvCache();
    await container.stop();
  }, 60_000);

  it("un conflicto sin revisión viva aparece como conflictos_abiertos con la evidencia de cada fuente", async () => {
    const { conflictId } = await orphanConflict("Disco Huérfano Uno", 1990, 1991);
    const scan = await runCurationScan({ trigger: "manual" });
    expect(scan.status).toBe("ok");

    const rows = (await pool().query<FindingRow>(
      "SELECT id::text, evidence FROM ingest.curation_findings WHERE detector='conflictos_abiertos' AND status='open' AND (evidence->>'conflictId')::bigint=$1",
      [conflictId])).rows;
    expect(rows).toHaveLength(1);
    const finding = rows[0]!;
    const sourceA = finding.evidence["sourceA"] as { name: string; trustLevel: string; url: string | null; at: string };
    const sourceB = finding.evidence["sourceB"] as { name: string; trustLevel: string; url: string | null; at: string };
    expect([sourceA.trustLevel, sourceB.trustLevel].sort()).toEqual(["high", "low"]);
    expect([sourceA.name, sourceB.name].sort()).toEqual(["Fuente Alta", "Fuente Baja"]);
    expect([sourceA.url, sourceB.url].sort()).toEqual(["https://fuente-alta.invalid", "https://fuente-baja.invalid"]);
    expect(new Date(sourceA.at).toString()).not.toBe("Invalid Date");
  });

  it("resuelve el conflicto con un valor propio y cierra el hallazgo en la siguiente verificación", async () => {
    const { albumId, conflictId } = await orphanConflict("Disco Huérfano Dos", 1980, 1985);
    await runCurationScan({ trigger: "manual" });
    const finding = await one<{ id: string }>(
      "SELECT id::text FROM ingest.curation_findings WHERE detector='conflictos_abiertos' AND status='open' AND (evidence->>'conflictId')::bigint=$1",
      [conflictId]);

    const resolved = await write("POST", `/curation/findings/${finding.id}/resolve-conflict`, { note: "la contraportada dice 1997", value: 1997 });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ action: "resolved", conflictId });

    expect((await one<{ release_year: number }>("SELECT release_year FROM public.albums WHERE id=$1", [albumId])).release_year).toBe(1997);
    expect((await one<{ status: string }>("SELECT status::text FROM ingest.conflicts WHERE id=$1", [conflictId])).status).not.toBe("open");

    // Repetirlo devuelve 409: el conflicto ya no está abierto.
    const repeated = await write("POST", `/curation/findings/${finding.id}/resolve-conflict`, { note: "otra vez", value: 1998 });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe("not_open");
  });

  it("elegir un lado cierra el conflicto sin afirmar un valor nuevo", async () => {
    const { albumId, conflictId } = await orphanConflict("Disco Huérfano Tres", 2001, 2002);
    await runCurationScan({ trigger: "manual" });
    const finding = await one<{ id: string }>(
      "SELECT id::text FROM ingest.curation_findings WHERE detector='conflictos_abiertos' AND status='open' AND (evidence->>'conflictId')::bigint=$1",
      [conflictId]);

    const resolved = await write("POST", `/curation/findings/${finding.id}/resolve-conflict`, { note: "la fuente alta manda", choice: "a" });
    expect(resolved.statusCode).toBe(200);
    const state = await one<{ status: string; year: number }>(`
      SELECT c.status::text, a.release_year AS year FROM ingest.conflicts c JOIN public.albums a ON a.id=$2 WHERE c.id=$1`,
    [conflictId, albumId]);
    expect(state.status).toBe("resolved_a");
    expect([2001, 2002]).toContain(state.year);
  });

  it("un hallazgo que no es conflictos_abiertos no se puede resolver por esta vía", async () => {
    const findings = await write("POST", "/curation/findings/999999999/resolve-conflict", { note: "x", choice: "a" });
    expect(findings.statusCode).toBe(404);
  });

  it("«aplicar la fuente de mayor confianza»: resuelve donde hay diferencia, deja los empates sin tocar", async () => {
    const decided = await orphanConflict("Disco Grupo Uno", 1970, 1975);
    const tied = (async () => {
      const album = Number((await write("POST", "/albums", { artistId: await artistId(), title: "Disco Grupo Empate", allowSimilar: true })).json().id);
      const a = await sourceClaim(sourceHigh, "release_year", 1960, album);
      expect(a.outcome.action).toBe("applied");
      const b = await sourceClaim(sourceHigh, "release_year", 1965, album);
      expect(b.outcome.action).toBe("conflict");
      const conflict = await one<{ id: string }>("SELECT id::text FROM ingest.conflicts WHERE claim_b_id=$1", [b.persisted.id]);
      await pool().query(
        "UPDATE ingest.review_queue SET status='dismissed',resolved_by='system',resolution_note='fixture',resolved_at=now() WHERE conflict_id=$1",
        [conflict.id]);
      return { albumId: album, conflictId: Number(conflict.id) };
    })();
    const tiedResult = await tied;
    await runCurationScan({ trigger: "manual" });

    const result = await write("POST", "/curation/findings/resolve-conflicts-group", {
      category: "valores_en_disputa", detector: "conflictos_abiertos", note: "confianza declarada de la fuente",
    });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.applied).toBeGreaterThanOrEqual(1);
    expect(body.tied).toBeGreaterThanOrEqual(1);

    expect((await one<{ status: string }>("SELECT status::text FROM ingest.conflicts WHERE id=$1", [decided.conflictId])).status).not.toBe("open");
    expect((await one<{ status: string }>("SELECT status::text FROM ingest.conflicts WHERE id=$1", [tiedResult.conflictId])).status).toBe("open");
  });

  it("la acción de grupo rechaza un filtro que no sea conflictos_abiertos", async () => {
    const result = await write("POST", "/curation/findings/resolve-conflicts-group", {
      category: "nombres_sucios", detector: "caracteres_invisibles", note: "x",
    });
    expect(result.statusCode).toBe(400);
  });
});
