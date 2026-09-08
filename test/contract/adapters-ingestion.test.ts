// Prueba de persistencia real: cada fixture se procesa dos veces contra
// PostgreSQL y el segundo pase reutiliza todos los claims. La confianza low
// es deliberada para que estas fuentes web sólo creen candidatos, nunca filas
// canónicas de artists durante la extracción automática.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters");
const slugs = ["descargas-metal-venezolano", "rockzuela", "rock-de-vzla", "hippito-y-sus-chatarritas", "rhv-blogspot", "rock-hecho-en-venezuela", "sincopa", "coleccionistas-de-rock-venezolano", "el-punk-en-venezuela"] as const;

async function recordsFor(slug: typeof slugs[number]) {
  const adapter = adapterFor({ slug, siteType: slug === "sincopa" ? "database" : "website" });
  if (!adapter) throw new Error(`adapter faltante: ${slug}`);
  const ext = slug === "sincopa" ? "html" : "json";
  const body = await readFile(path.join(fixtureDir, `${slug}.${ext}`), "utf8");
  const url = slug === "sincopa" ? "https://fixture.invalid/artist_rock/banda_fixture.htm" : `https://fixture.invalid/${slug}`;
  const page: StoredPage = { url, kind: ext === "json" ? "json" : "html", rawPageId: 1, body };
  return adapter.extractSnapshot?.(page) ?? [];
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
