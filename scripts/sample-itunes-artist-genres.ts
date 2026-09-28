// Muestra ciega de 20 artistas para evaluar la cobertura de género de iTunes.
// Guarda solo metadatos de búsqueda, nunca artwork ni previews.
import { appendFile, readFile } from "node:fs/promises";
import { getEnv } from "../src/config/env.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

const OUTPUT = "reports/genre-laya-evidence-itunes-artist-sample-2026-09-26.jsonl";

async function main(): Promise<void> {
  const cases = (await readFile("reports/genre-laya-blind-40-reference-2026-09-26.jsonl", "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
      caseId: string; kind: string; title: string; primaryGenre: string;
    }).filter((row) => row.kind === "artist");
  if (cases.length !== 20) throw new Error("se esperaban 20 artistas");
  let existing = "";
  try { existing = await readFile(OUTPUT, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const done = new Set(existing.split(/\r?\n/u).filter(Boolean).map((line) =>
    (JSON.parse(line) as { caseId: string }).caseId));
  let queried = 0;
  for (const item of cases) {
    if (done.has(item.caseId)) continue;
    if (queried > 0) await new Promise((resolve) => setTimeout(resolve, 4200));
    const url = new URL("https://itunes.apple.com/search");
    for (const [key, value] of Object.entries({ term: item.title, media: "music", entity: "musicArtist", country: "VE", limit: "25" })) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, { headers: { "User-Agent": `CRV-generos/1.0 (${getEnv().GENRES_EXTERNAL_CONTACT})` },
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`iTunes ${response.status}: ${item.caseId}`);
    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    const matches = (payload.results ?? []).filter((row) =>
      normalizeIdentitySecondary(String(row["artistName"] ?? "")) === normalizeIdentitySecondary(item.title))
      .map((row) => ({ artistId: row["artistId"], artistName: row["artistName"],
        primaryGenreName: row["primaryGenreName"], artistLinkUrl: row["artistLinkUrl"] }));
    await appendFile(OUTPUT, JSON.stringify({ caseId: item.caseId, title: item.title,
      reference: item.primaryGenre, url: url.toString(), status: response.status, matches }) + "\n");
    queried += 1;
    console.log(`${done.size + queried}/20 ${item.caseId}: ${matches.length} coincidencias`);
  }
  console.log(JSON.stringify({ total: cases.length, previouslyDone: done.size, processedNow: queried, output: OUTPUT }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
