// Infraestructura F4/F5 contra fixtures: ningún acceso a Internet. Prueba la
// cadena completa parser-contract → normalización → claim/evidencia → merge,
// incluida la idempotencia que exige el contrato y un dry-run sin mutaciones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { claims, entityResolutionDecisions, mergeAudit, rawPages, reviewQueue, scrapeRuns, sources } from "../../src/db/schema/ingest.js";
import { artists } from "../../src/db/schema/core.js";
import { ingestAdapterSnapshots, ingestRecords } from "../../src/ingest/runner.js";
import type { RawRecord, SourceAdapter } from "../../src/adapters/contracts.js";
import { registerManualEvidence } from "../../src/ingest/manual-evidence.js";
import { proposeSource } from "../../src/ingest/sources.js";
import { approveEntity } from "../../src/review/approval.js";

const caramelosFixture: RawRecord = {
  entityKind: "artist",
  identity: "  Caramelos de Cianuro ",
  extractor: "fixture-html",
  extractorVersion: "1",
  fields: [
    { field: "name", value: "Caramelos de Cianuro", evidence: { url: "https://fixture.invalid/caramelos", selector: "h1", excerpt: "Caramelos de Cianuro" } },
    { field: "origin_city", value: " Caracas ", evidence: { url: "https://fixture.invalid/caramelos", selector: ".city", excerpt: "Caracas" } },
  ],
};

describe("motor de ingestión con fixtures", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    await getDb().insert(sources).values({
      slug: "fixture-caramelos", name: "Fixture local (no fuente de producción)", url: "https://fixture.invalid",
      siteType: "website", trustLevel: "high", enabled: true,
    });
    await getDb().insert(sources).values({
      slug: "hemeroteka", name: "Hemeroteka", url: "https://www.instagram.com/hemeroteka/",
      siteType: "instagram", trustLevel: "low", enabled: false,
    });
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("doble ingestión crea runs pero no duplica claims, evidencia ni artista", async () => {
    const first = await ingestRecords("fixture-caramelos", [caramelosFixture], { confidence: "high" });
    const second = await ingestRecords("fixture-caramelos", [caramelosFixture], { confidence: "high" });
    expect(first).toMatchObject({ claimsInserted: 2, claimsReused: 0 });
    expect(second).toMatchObject({ claimsInserted: 0, claimsReused: 2 });

    const db = getDb();
    expect(await db.select().from(claims)).toHaveLength(2);
    const artistRows = await db.select().from(artists).where(eq(artists.name, "Caramelos de Cianuro"));
    expect(artistRows).toHaveLength(1);
    expect(artistRows[0]?.originCity).toBe("Caracas");
    expect(await db.select().from(mergeAudit)).toHaveLength(2);
    expect(await db.select().from(scrapeRuns)).toHaveLength(2);
  });

  it("dry-run muestra el plan sin crear claims, merge ni artista", async () => {
    const beforeClaims = (await getDb().select().from(claims)).length;
    const plan = await ingestRecords("fixture-caramelos", [{
      ...caramelosFixture,
      identity: "Artista Solo Dry Run",
      fields: caramelosFixture.fields.map((field) => ({ ...field, value: field.field === "name" ? "Artista Solo Dry Run" : field.value })),
    }], { confidence: "high", dryRun: true });
    expect(plan.runId).toBeUndefined();
    expect(plan.plan).toHaveLength(2);
    expect(plan.plan.map((entry) => entry.action)).toEqual(["merge", "merge"]);
    expect((await getDb().select().from(claims)).length).toBe(beforeClaims);
    expect(await getDb().select().from(artists).where(eq(artists.name, "Artista Solo Dry Run"))).toHaveLength(0);
  });

  it("un adapter recibe Cheerio sobre un snapshot y conserva su límite de dry-run", async () => {
    const adapter: SourceAdapter = {
      slug: "fixture-parser", requiresBrowser: false,
      async *listPages() { yield { url: "https://fixture.invalid/parser", kind: "html" as const }; },
      extract($, url) {
        return [{ entityKind: "artist", identity: $("h1").text(), extractor: "fixture-cheerio", extractorVersion: "1", fields: [
          { field: "name", value: $("h1").text(), evidence: { url, selector: "h1" } },
        ] }];
      },
    };
    const plan = await ingestAdapterSnapshots("fixture-caramelos", adapter, [{
      url: "https://fixture.invalid/parser", kind: "html", rawPageId: 999, body: "<h1>Cheerio Fixture</h1>",
    }], { confidence: "high", dryRun: true });
    expect(plan.plan).toEqual([expect.objectContaining({ field: "name", action: "merge" })]);
  });

  it("claim low queda candidato y persiste revisión sin tocar el core", async () => {
    const lowRecord: RawRecord = {
      ...caramelosFixture,
      identity: "Artista Low Fixture",
      fields: [{ field: "name", value: "Artista Low Fixture", evidence: { url: "https://fixture.invalid/low" } }],
    };
    const low = await ingestRecords("fixture-caramelos", [lowRecord], { confidence: "low" });
    expect(low.merges[0]?.action).toBe("candidate");
    expect(await getDb().select().from(artists).where(eq(artists.name, "Artista Low Fixture"))).toHaveLength(0);
    expect((await getDb().select().from(reviewQueue)).some((item) => item.kind === "low_confidence")).toBe(true);

    const [candidate] = await getDb().select().from(claims).where(eq(claims.rawValue, "Artista Low Fixture"));
    await approveEntity("artist", candidate!.identityKey!, "fixture aprobada por una persona");
    const before = {
      audits: (await getDb().select().from(mergeAudit)).length,
      decisions: (await getDb().select().from(entityResolutionDecisions)).length,
      reviews: (await getDb().select().from(reviewQueue)).length,
    };

    const repeated = await ingestRecords("fixture-caramelos", [lowRecord], { confidence: "low" });
    expect(repeated).toMatchObject({ claimsInserted: 0, claimsReused: 1 });
    expect(repeated.merges[0]).toMatchObject({ action: "unchanged" });
    expect((await getDb().select().from(claims).where(eq(claims.id, candidate!.id)))[0]?.status).toBe("accepted");
    expect((await getDb().select().from(reviewQueue)).length).toBe(before.reviews);
    expect((await getDb().select().from(entityResolutionDecisions)).length).toBe(before.decisions);
    expect((await getDb().select().from(mergeAudit)).length).toBe(before.audits);
  });

  it("Hemeroteka registra evidencia humana sin red, raw page, claim ni entidad", async () => {
    const db = getDb();
    const before = {
      rawPages: (await db.select().from(rawPages)).length,
      claims: (await db.select().from(claims)).length,
      artists: (await db.select().from(artists)).length,
    };
    const result = await registerManualEvidence("hemeroteka", {
      evidenceUrl: "https://www.instagram.com/p/AbC_123/",
      excerpt: "Crédito y fecha transcritos por el operador desde una publicación pública.",
      notes: "Pendiente de contrastar antes de crear claims.",
    });

    const [review] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, result.reviewId));
    expect(review?.kind).toBe("manual_review");
    expect(review?.payload).toMatchObject({
      type: "manual_source_evidence",
      runId: result.runId,
      sourceSlug: "hemeroteka",
      evidenceUrl: "https://www.instagram.com/p/AbC_123/",
      adapterStatus: "limited",
      accessMode: "manual",
      automation: "disabled",
      capturedBy: "human",
    });
    expect((await db.select().from(rawPages)).length).toBe(before.rawPages);
    expect((await db.select().from(claims)).length).toBe(before.claims);
    expect((await db.select().from(artists)).length).toBe(before.artists);

    await expect(registerManualEvidence("hemeroteka", {
      evidenceUrl: "https://example.com/p/AbC_123/",
      excerpt: "Fuera de alcance",
    })).rejects.toThrow("fuera del alcance autorizado");
  });

  it("una fuente nueva nace deshabilitada y con su revisión en la misma operación", async () => {
    const result = await proposeSource({
      name: "Fuente Futura Fixture",
      url: "https://future.fixture.invalid/catalogo",
      siteType: "website",
      justification: "propuesta de contrato; no autoriza red",
    });
    const [source] = await getDb().select().from(sources).where(eq(sources.id, result.sourceId));
    const [review] = await getDb().select().from(reviewQueue).where(eq(reviewQueue.id, result.reviewId));
    expect(source).toMatchObject({ slug: "fuente-futura-fixture", enabled: false, trustLevel: "low" });
    expect(review).toMatchObject({ kind: "new_source", status: "open" });
    expect(review?.payload).toMatchObject({ sourceId: result.sourceId, url: "https://future.fixture.invalid/catalogo" });
  });
});
