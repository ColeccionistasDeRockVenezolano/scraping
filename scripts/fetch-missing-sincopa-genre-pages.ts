// Recupera fichas Sincopa enlazadas por claims aceptados y aún no cacheadas.
// Usa el fetcher oficial: robots.txt, cortesía por dominio y caché de crudos.
import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fetchAndCache } from "../src/cache/raw-pages.js";
import { closeDb } from "../src/db/client.js";

const inventory = path.resolve("reports/genre-laya-evidence-coverage-2026-09-26-inventory.jsonl");
const report = path.resolve("reports/genre-laya-evidence-sincopa-fetch-2026-09-26.jsonl");

async function main(): Promise<void> {
  const rows = (await readFile(inventory, "utf8")).split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; sourceLinks: Array<{ source: string; url: string; snapshot: string | null }> });
  const urls = [...new Set(rows.filter((row) => row.kind === "album")
    .flatMap((row) => row.sourceLinks.filter((link) => link.source === "sincopa" && !link.snapshot).map((link) => link.url)))];
  const done = new Set<string>();
  if (await stat(report).then(() => true, () => false)) {
    for (const line of (await readFile(report, "utf8")).split(/\r?\n/u)) {
      if (line.trim()) done.add((JSON.parse(line) as { url: string }).url);
    }
  }
  let fetched = 0;
  for (const url of urls) {
    if (done.has(url)) continue;
    const result: Record<string, unknown> = { url };
    try {
      const page = await fetchAndCache("sincopa", url);
      result["status"] = page.status;
      result["snapshot"] = page.storedPath;
      result["sha256"] = page.sha256;
      result["cached"] = page.cached;
    } catch (error) {
      result["error"] = error instanceof Error ? error.message : String(error);
    }
    await appendFile(report, `${JSON.stringify(result)}\n`);
    fetched += 1;
    if (fetched % 20 === 0) console.log(`Sincopa: ${fetched}/${urls.length - done.size} URL procesadas`);
  }
  console.log(JSON.stringify({ urls: urls.length, previouslyDone: done.size, processedNow: fetched, report }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { await closeDb(); });
