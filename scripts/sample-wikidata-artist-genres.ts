// Ensayo de solo lectura: extrae géneros P136 de artistas venezolanos.
// No habilita la fuente ni escribe sugerencias en la base.
import { writeFile } from "node:fs/promises";
import { getEnv } from "../src/config/env.js";

const query = `SELECT DISTINCT ?artist ?artistLabel ?genre ?genreLabel ?instance ?mbid WHERE {
  ?artist wdt:P136 ?genre .
  { ?artist wdt:P27 wd:Q717 . } UNION { ?artist wdt:P495 wd:Q717 . }
  OPTIONAL { ?artist wdt:P31 ?instance . }
  OPTIONAL { ?artist wdt:P434 ?mbid . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
} LIMIT 5000`;

async function main(): Promise<void> {
  const contact = getEnv().GENRES_EXTERNAL_CONTACT;
  if (!contact) throw new Error("GENRES_EXTERNAL_CONTACT es obligatorio");
  const url = new URL("https://query.wikidata.org/sparql");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, { headers: {
    "User-Agent": `CRV-generos/1.0 (${contact})`, "Accept": "application/sparql-results+json",
  }, signal: AbortSignal.timeout(65_000) });
  if (!response.ok) throw new Error(`Wikidata respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json() as { results?: { bindings?: Array<Record<string, { value: string }>> } };
  const rows = (payload.results?.bindings ?? []).map((row) => ({
    qid: row["artist"]?.value?.split("/").pop() ?? "", name: row["artistLabel"]?.value ?? "",
    genreQid: row["genre"]?.value?.split("/").pop() ?? "", genre: row["genreLabel"]?.value ?? "",
    instanceQid: row["instance"]?.value?.split("/").pop() ?? null, mbid: row["mbid"]?.value ?? null,
  }));
  await writeFile("reports/genre-laya-evidence-wikidata-artist-sample-2026-09-26.json",
    JSON.stringify({ fetchedAt: new Date().toISOString(), endpoint: url.origin + url.pathname,
      query, rows }, null, 2) + "\n");
  console.log(JSON.stringify({ rows: rows.length, uniqueArtists: new Set(rows.map((row) => row.qid)).size }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
