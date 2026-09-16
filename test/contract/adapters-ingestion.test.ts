// Prueba de persistencia real: cada fixture se procesa dos veces contra
// PostgreSQL y el segundo pase reutiliza todos los claims. La confianza low
// es deliberada para que estas fuentes web sólo creen candidatos, nunca filas
// canónicas de artists durante la extracción automática.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { claims, sources } from "../../src/db/schema/ingest.js";
import { artists } from "../../src/db/schema/core.js";
import { adapterFor } from "../../src/adapters/registry.js";
import { ingestRecords } from "../../src/ingest/runner.js";
import type { StoredPage } from "../../src/adapters/contracts.js";
import { ADAPTER_SLUGS, FIXTURE_DIR, fixturesFor, siteTypeFor, type AdapterSlug } from "../support/adapter-fixtures.js";

const slugs = ADAPTER_SLUGS;

async function recordsFor(slug: AdapterSlug) {
  const adapter = adapterFor({ slug, siteType: siteTypeFor(slug) });
  if (!adapter) throw new Error(`adapter faltante: ${slug}`);
  const perPage = await Promise.all(fixturesFor(slug).map(async (input) => {
    const body = await readFile(path.join(FIXTURE_DIR, input.file), "utf8");
    const page: StoredPage = { url: input.url, kind: input.kind, rawPageId: 1, body };
    return adapter.extractSnapshot?.(page) ?? [];
  }));
  return perPage.flat();
}

describe("persistencia idempotente de fixtures de adapters", () => {
  let container: PgContainer;
  beforeAll(async () => {
    container = await startPgContainer(); process.env["DATABASE_URL"] = container.databaseUrl; resetEnvCache();
    await applyCore(container.name); await migrateUp();
    await getDb().insert(sources).values(slugs.map((slug) => ({ slug, name: `Fixture ${slug}`, url: `https://fixture.invalid/${slug}`, siteType: slug === "sincopa" ? "database" : "website", trustLevel: "low" as const, enabled: true })));
  }, 120_000);
  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  it.each(slugs)("%s: segundo pase no duplica claims ni entidades canónicas", async (slug) => {
    const records = await recordsFor(slug);
    const first = await ingestRecords(slug, records, { confidence: "low" });
    const second = await ingestRecords(slug, records, { confidence: "low" });
    expect(first.claimsInserted).toBeGreaterThan(0);
    expect(second).toMatchObject({ claimsInserted: 0, claimsReused: first.claimsInserted });
    const [source] = await getDb().select().from(sources).where(eq(sources.slug, slug));
    expect((await getDb().select().from(claims).where(eq(claims.sourceId, source!.id))).length).toBe(first.claimsInserted);
    expect(await getDb().select().from(artists)).toHaveLength(0);
  });
});
