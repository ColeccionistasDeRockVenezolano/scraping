// Muestra candidatos normalizados de fixtures locales; no usa red ni base de datos.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { adapterFor } from "../src/adapters/registry.js";
import { normalizeRecord } from "../src/normalization/claims.js";
import type { StoredPage } from "../src/adapters/contracts.js";
// Qué fixture representa a cada fuente vive en un solo sitio: duplicarlo aquí
// ya rompió una vez, cuando CRV WordPress pasó de JSON a HTML.
import { ADAPTER_SLUGS, FIXTURE_DIR, fixturesFor, siteTypeFor } from "../test/support/adapter-fixtures.js";

for (const slug of ADAPTER_SLUGS) {
  const adapter = adapterFor({ slug, siteType: siteTypeFor(slug) });
  if (!adapter) throw new Error(`adapter faltante: ${slug}`);
  const candidates = [];
  for (const fixture of fixturesFor(slug)) {
    const body = await readFile(path.join(FIXTURE_DIR, fixture.file), "utf8");
    const page: StoredPage = { url: fixture.url, kind: fixture.kind, rawPageId: 1, body };
    const records = adapter.extractSnapshot?.(page) ?? adapter.extract(load(body), page.url);
    candidates.push(...records.flatMap(normalizeRecord));
  }
  console.log(JSON.stringify({ source: slug, candidates }, null, 2));
}
