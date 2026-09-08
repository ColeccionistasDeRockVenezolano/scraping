// A0 · Aprobación por lotes. Lo que se prueba no es que "apruebe muchos", sino
// las tres cosas que un bucle ingenuo haría mal: respetar el orden de
// dependencia del core, dejar rastro consultable, y previsualizar sin mutar.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { reviewQueue, scrapeRuns, sources } from "../../src/db/schema/ingest.js";
import { albums, artists } from "../../src/db/schema/core.js";
import { ingestRecords } from "../../src/ingest/runner.js";
import { planBatch, runBatch, BATCH_ORDER } from "../../src/review/batch.js";
import type { RawRecord } from "../../src/adapters/contracts.js";

const where = { url: "https://fixture.invalid/lote", selector: "p", excerpt: "Los Kings" };

// El disco depende del artista: albums.artist_id es NOT NULL. Si el lote
// aprobara por orden de llegada, "Vol. 1" fallaría por no tener a quién colgarse.
const registros: RawRecord[] = [
  {
    entityKind: "artist", identity: "Los Kings", extractor: "fixture-lote", extractorVersion: "1",
    fields: [
      { field: "name", value: "Los Kings", evidence: where },
      { field: "origin_city", value: "Caracas", evidence: where },
    ],
  },
  {
    entityKind: "album", identity: "Los Kings::Vol. 1", extractor: "fixture-lote", extractorVersion: "1",
    fields: [
      { field: "title", value: "Vol. 1", evidence: where },
      { field: "artist_name", value: "Los Kings", evidence: where },
      { field: "release_year", value: "1975", evidence: where },
    ],
  },
];

describe("aprobación por lotes", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await getDb().insert(sources).values({
      slug: "fixture-lote", name: "Fixture local (no fuente de producción)", url: "https://fixture.invalid",
      siteType: "website", trustLevel: "low", enabled: true,
    });
    // confidence "low" es la puerta real de las fuentes web: todo queda candidato.
    await ingestRecords("fixture-lote", registros, { confidence: "low" });
  }, 120_000);

  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  it("previsualiza en orden de dependencia y no toca el core", async () => {
    const plan = await planBatch({ sourceSlug: "fixture-lote" });
    const kinds = plan.items.map((item) => item.entityKind);
    expect(kinds).toContain("artist");
    expect(kinds).toContain("album");
    // el artista va antes que el disco, y el orden es el declarado, no el de llegada
    expect(kinds.indexOf("artist")).toBeLessThan(kinds.indexOf("album"));
    expect(kinds).toEqual([...BATCH_ORDER].filter((kind) => kinds.includes(kind)));
    expect(plan.totalEntities).toBe(2);

    // previsualizar no es aprobar
    expect(await getDb().select().from(artists)).toHaveLength(0);
    expect(await getDb().select().from(scrapeRuns).where(eq(scrapeRuns.kind, "merge_run"))).toHaveLength(0);
  });

  it("aprueba el conjunto respetando la dependencia y deja el disco colgado del artista", async () => {
    const result = await runBatch("approve", { sourceSlug: "fixture-lote" }, "barrido inicial de la fuente");
    expect(result.failed).toBe(0);
    expect(result.entities).toBe(2);
    expect(result.applied).toBeGreaterThan(0);

    const [artista] = await getDb().select().from(artists);
    const [disco] = await getDb().select().from(albums);
    expect(artista?.name).toBe("Los Kings");
    expect(disco?.title).toBe("Vol. 1");
    expect(disco?.releaseYear).toBe(1975);
    // la prueba de que el orden funcionó: el disco existe Y apunta al artista
    expect(disco?.artistId).toBe(artista?.id);
  });

  it("deja rastro consultable: run merge_run y el id del lote en cada nota", async () => {
    const [run] = await getDb().select().from(scrapeRuns).where(eq(scrapeRuns.kind, "merge_run"));
    expect(run?.status).toBe("ok");
    expect(run?.params).toMatchObject({ action: "approve", note: "barrido inicial de la fuente" });
    expect(run?.counters).toMatchObject({ entities: 2, failed: 0 });

    const cerradas = (await getDb().select().from(reviewQueue).where(eq(reviewQueue.status, "approved")));
    expect(cerradas.length).toBeGreaterThan(0);
    for (const item of cerradas) {
      expect(item.resolutionNote?.startsWith(`[lote ${run?.id}] `)).toBe(true);
      expect(item.resolvedBy).toBe("human");
    }
  });

  it("es idempotente: repetir el lote no duplica entidades", async () => {
    const antes = await getDb().select().from(artists);
    const plan = await planBatch({ sourceSlug: "fixture-lote" });
    expect(plan.totalEntities).toBe(0);
    expect(await getDb().select().from(artists)).toHaveLength(antes.length);
  });

  it("rechaza tipos que el motor no sabe promover, en vez de fingir que los aprobó", async () => {
    await expect(planBatch({ entityKind: "youtube_video" })).rejects.toThrow(/no aprobable por lote/);
    await expect(runBatch("approve", { entityKind: "album_format" }, "x")).rejects.toThrow(/no aprobable por lote/);
  });

  it("exige nota de resolución", async () => {
    await expect(runBatch("approve", {}, "   ")).rejects.toThrow(/nota de resolución/);
  });
});
