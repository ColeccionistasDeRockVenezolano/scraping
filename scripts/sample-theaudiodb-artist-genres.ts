// Ensayo de cobertura de TheAudioDB con 20 artistas de la muestra ciega.
// La ficha de la fuente permanece en evaluación; no escribe en la base.
import { readFile, writeFile } from "node:fs/promises";
import { getEnv } from "../src/config/env.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

async function main(): Promise<void> {
  const reference = (await readFile("reports/genre-laya-blind-40-reference-2026-09-26.jsonl", "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
      caseId: string; kind: string; title: string; primaryGenre: string;
    }).filter((row) => row.kind === "artist");
  if (reference.length !== 20) throw new Error("la muestra ciega debe contener 20 artistas");
  const rows: Record<string, unknown>[] = [];
  for (const [index, item] of reference.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 3200));
    const url = new URL("https://www.theaudiodb.com/api/v1/json/123/search.php");
    url.searchParams.set("s", item.title);
    const response = await fetch(url, { headers: {
      "User-Agent": `CRV-generos/1.0 (${getEnv().GENRES_EXTERNAL_CONTACT})`,
    }, signal: AbortSignal.timeout(20_000) });
    const payload = await response.json() as { artists?: Array<Record<string, unknown>> | null };
    const matches = (payload.artists ?? []).filter((artist) =>
      normalizeIdentitySecondary(String(artist["strArtist"] ?? "")) === normalizeIdentitySecondary(item.title));
    rows.push({ caseId: item.caseId, title: item.title, reference: item.primaryGenre,
      status: response.status, url: url.toString(),
      matches: matches.map((artist) => ({ id: artist["idArtist"], name: artist["strArtist"],
        country: artist["strCountry"], genre: artist["strGenre"], style: artist["strStyle"],
        mbid: artist["strMusicBrainzID"] ?? artist["Music_Brainz_Artist_ID"] ?? null })) });
    console.log(`${index + 1}/20 ${item.caseId}: ${matches.length} coincidencias`);
  }
  await writeFile("reports/genre-laya-evidence-theaudiodb-artist-sample-2026-09-26.json",
    JSON.stringify({ fetchedAt: new Date().toISOString(), rows }, null, 2) + "\n");
  console.log(JSON.stringify({ cases: rows.length, matched: rows.filter((row) => (row["matches"] as unknown[]).length > 0).length,
    withGenre: rows.filter((row) => (row["matches"] as Array<{ genre: unknown }>).some((match) => !!match.genre)).length }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
