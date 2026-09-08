// Muestra candidatos normalizados de fixtures locales; no usa red ni base de datos.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { adapterFor } from "../src/adapters/registry.js";
import { normalizeRecord } from "../src/normalization/claims.js";
import type { StoredPage } from "../src/adapters/contracts.js";

const fixtureDir = path.join(process.cwd(), "test", "fixtures", "adapters");
const slugs = ["descargas-metal-venezolano", "rockzuela", "rock-de-vzla", "hippito-y-sus-chatarritas", "rhv-blogspot", "rock-hecho-en-venezuela", "sincopa", "coleccionistas-de-rock-venezolano", "el-punk-en-venezuela"] as const;
for (const slug of slugs) {
  const adapter = adapterFor({ slug, siteType: slug === "sincopa" ? "database" : "website" });
  if (!adapter) throw new Error(`adapter faltante: ${slug}`);
  const ext = slug === "sincopa" ? "html" : "json";
  const body = await readFile(path.join(fixtureDir, `${slug}.${ext}`), "utf8");
  const url = slug === "sincopa" ? "https://fixture.invalid/artist_rock/banda_fixture.htm" : `https://fixture.invalid/${slug}`;
  const page: StoredPage = { url, kind: ext === "json" ? "json" : "html", rawPageId: 1, body };
  const claims = (adapter.extractSnapshot?.(page) ?? adapter.extract((await import("cheerio")).load(body), page.url)).flatMap(normalizeRecord);
  console.log(JSON.stringify({ source: slug, candidates: claims }, null, 2));
}
