// Muestra ciega de 20 álbumes para evaluar género de iTunes con identidad triple.
import { appendFile, readFile } from "node:fs/promises";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

const OUTPUT = "reports/genre-laya-evidence-itunes-album-sample-2026-09-26.jsonl";

async function main(): Promise<void> {
  const reference = (await readFile("reports/genre-laya-blind-40-reference-2026-09-26.jsonl", "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
      caseId: string; kind: string; title: string; primaryGenre: string;
    }).filter((row) => row.kind === "album");
  if (reference.length !== 20) throw new Error("se esperaban 20 álbumes");
  const ids = reference.map((row) => Number(row.caseId.split(":")[1]));
  const client = await getPool().connect();
  let details: Array<{ id: string; artist: string; year: number | null }>;
  try {
    details = (await client.query<{ id: string; artist: string; year: number | null }>(`
      SELECT a.id::text, ar.name AS artist, a.release_year AS year
        FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
       WHERE a.id=ANY($1::bigint[])`, [ids])).rows;
  } finally { client.release(); await closeDb(); }
  const byId = new Map(details.map((row) => [row.id, row]));
  let existing = "";
  try { existing = await readFile(OUTPUT, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const done = new Set(existing.split(/\r?\n/u).filter(Boolean).map((line) =>
    (JSON.parse(line) as { caseId: string }).caseId));
  let queried = 0;
  for (const item of reference) {
    if (done.has(item.caseId)) continue;
    if (queried > 0) await new Promise((resolve) => setTimeout(resolve, 4200));
    const detail = byId.get(item.caseId.split(":")[1]!);
    if (!detail) throw new Error(`álbum inexistente: ${item.caseId}`);
    const url = new URL("https://itunes.apple.com/search");
    for (const [key, value] of Object.entries({ term: `${detail.artist} ${item.title}`, media: "music",
      entity: "album", country: "VE", limit: "50" })) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { "User-Agent": `CRV-generos/1.0 (${getEnv().GENRES_EXTERNAL_CONTACT})` },
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`iTunes ${response.status}: ${item.caseId}`);
    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    const matches = (payload.results ?? []).filter((row) =>
      normalizeIdentitySecondary(String(row["artistName"] ?? "")) === normalizeIdentitySecondary(detail.artist)
      && normalizeIdentitySecondary(String(row["collectionName"] ?? "")) === normalizeIdentitySecondary(item.title))
      .map((row) => ({ collectionId: row["collectionId"], artistId: row["artistId"],
        artistName: row["artistName"], collectionName: row["collectionName"],
        releaseDate: row["releaseDate"], primaryGenreName: row["primaryGenreName"],
        collectionViewUrl: row["collectionViewUrl"] }));
    await appendFile(OUTPUT, JSON.stringify({ caseId: item.caseId, title: item.title,
      artist: detail.artist, year: detail.year, reference: item.primaryGenre,
      url: url.toString(), status: response.status, matches }) + "\n");
    queried += 1;
    console.log(`${done.size + queried}/20 ${item.caseId}: ${matches.length} coincidencias`);
  }
  console.log(JSON.stringify({ total: reference.length, previouslyDone: done.size, processedNow: queried, output: OUTPUT }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
