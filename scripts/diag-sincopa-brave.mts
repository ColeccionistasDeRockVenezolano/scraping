// Diagnóstico: qué extrae el adapter de las fichas rechazadas (primeras N).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { adapterFor } from "../src/adapters/registry.js";
import { getEnv } from "../src/config/env.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adapter = adapterFor({ slug: "sincopa", siteType: "database" })!;
const dataDir = getEnv().DATA_DIR;
const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

const N = Number(process.argv[2] ?? 8);

async function main(): Promise<void> {
  const rows = (await readFile(path.join(ROOT, "reports/covers-sincopa-brave-rejected.jsonl"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.page).slice(0, N);
  for (const row of rows) {
    const { rows: rp } = await pool.query<{ stored_path: string }>("SELECT stored_path FROM ingest.raw_pages WHERE url=$1 ORDER BY id DESC LIMIT 1", [row.page]);
    const stored = rp[0]?.stored_path;
    console.log(`\n== album ${row.id} «${row.title}» | ${row.page} | stored=${stored ?? "NO"}`);
    if (!stored) continue;
    try {
      const bytes = await readFile(path.join(dataDir, stored));
      const body = adapter.decodeBody ? adapter.decodeBody(bytes) : bytes.toString("utf8");
      const recs = adapter.extractSnapshot!({ url: row.page, kind: "html", rawPageId: 0, body });
      console.log(`   records: ${recs.length}`);
      for (const r of recs.slice(0, 4)) {
        const get = (n: string) => r.fields.find((f) => f.field === n)?.value;
        console.log(`   - ${r.entityKind} | title=${JSON.stringify(get("title"))} | artist=${JSON.stringify(get("artist_name"))} | year=${JSON.stringify(get("release_year"))} | cover=${String(get("cover_url") ?? "").slice(0, 90)}`);
      }
    } catch (error) { console.log("   err:", (error as Error).message); }
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
