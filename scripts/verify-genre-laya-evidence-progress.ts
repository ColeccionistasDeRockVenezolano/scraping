// Mide el progreso sobre las 4.128 fichas del inventario inicial sin cambiarlo.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";

const ROOT = path.resolve("reports");
const INVENTORY = path.join(ROOT, "genre-laya-evidence-coverage-2026-09-26-inventory.jsonl");
const LEDGERS = ["genre-laya-evidence-sincopa-2026-09-26.jsonl",
  "genre-laya-evidence-sincopa-artists-2026-09-26.jsonl",
  "genre-laya-evidence-sincopa-albums-discovered-2026-09-26.jsonl"].map((name) => path.join(ROOT, name));
const OUTPUT = path.join(ROOT, "genre-laya-evidence-progress-2026-09-26.json");

async function main(): Promise<void> {
  const inventory = (await readFile(INVENTORY, "utf8")).split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line) as { caseId: string; kind: "album" | "artist"; entityId: number;
      sourceLinks: Array<{ source: string; url: string }> });
  if (inventory.length !== 4128 || new Set(inventory.map((row) => row.caseId)).size !== inventory.length) {
    throw new Error("inventario base no contiene 4.128 fichas únicas");
  }
  const original = new Set(inventory.map((row) => row.caseId));
  const originalById = new Map(inventory.map((row) => [row.caseId, row]));
  const sincopa = new Set<string>();
  for (const line of (await Promise.all(LEDGERS.map((file) => readFile(file, "utf8")))).join("\n").split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line) as { caseId: string; kind: string; entityId: number; source: string;
      rawGenre: string; snapshot: string; snapshotSha256: string };
    if (!original.has(row.caseId) || row.caseId !== `${row.kind}:${row.entityId}` || row.source !== "sincopa"
      || !row.rawGenre.trim() || sincopa.has(row.caseId)) throw new Error(`ledger inválido: ${row.caseId}`);
    const file = path.resolve("data", row.snapshot);
    if (!file.startsWith(path.resolve("data/raw/sincopa") + path.sep)) throw new Error("snapshot fuera de Sincopa");
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== row.snapshotSha256) {
      throw new Error(`hash no coincide: ${row.caseId}`);
    }
    sincopa.add(row.caseId);
  }
  const wikidata = new Set<string>();
  const wikidataLedger = path.join(ROOT, "genre-laya-evidence-wikidata-artists-2026-09-26.jsonl");
  for (const line of (await readFile(wikidataLedger, "utf8")).split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line) as { caseId: string; kind: string; entityId: number; source: string;
      qid: string; url: string; genres: Array<{ qid: string; label: string }>; signals: string[];
      sampleSnapshot: string; sampleSha256: string; corrobSnapshot: string; corrobSha256: string };
    if (!original.has(row.caseId) || row.caseId !== `artist:${row.entityId}` || row.kind !== "artist"
      || row.source !== "wikidata" || !/^Q\d+$/u.test(row.qid)
      || row.url !== `https://www.wikidata.org/wiki/${row.qid}` || !row.genres?.length
      || !row.signals?.includes("artist_name")
      || !row.signals.some((signal) => signal === "discogs_id" || signal === "album_title")
      || wikidata.has(row.caseId)) throw new Error(`ledger Wikidata inválido: ${row.caseId}`);
    for (const [filename, hash] of [[row.sampleSnapshot, row.sampleSha256],
      [row.corrobSnapshot, row.corrobSha256]] as Array<[string, string]>) {
      const absolute = path.resolve(filename);
      if (!absolute.startsWith(ROOT + path.sep) || !/^[a-f0-9]{64}$/u.test(hash)
        || createHash("sha256").update(await readFile(absolute)).digest("hex") !== hash) {
        throw new Error(`snapshot Wikidata inválido: ${row.caseId}`);
      }
    }
    wikidata.add(row.caseId);
  }
  const prose = new Set<string>();
  const proseLedgers = ["genre-laya-evidence-rockdevzla-artists-2026-09-26.jsonl",
    "genre-laya-evidence-rockzuela-artists-2026-09-26.jsonl"].map((name) => path.join(ROOT, name));
  for (const line of (await Promise.all(proseLedgers.map((file) => readFile(file, "utf8"))))
    .join("\n").split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line) as { caseId: string; kind: string; entityId: number; source: string;
      rawGenre: string; excerpt: string; url: string; snapshot: string; snapshotSha256: string; signals: string[] };
    if (!original.has(row.caseId) || row.caseId !== `artist:${row.entityId}` || row.kind !== "artist"
      || !["rock-de-vzla", "rockzuela"].includes(row.source) || !row.rawGenre?.trim() || !row.excerpt?.trim()
      || !row.signals?.includes("direct_artist_genre_phrase") || prose.has(row.caseId)
      || !originalById.get(row.caseId)?.sourceLinks.some((link) => link.source === row.source && link.url === row.url)
      || !new RegExp(`^raw/${row.source}/[a-f0-9]{64}\\.json$`, "u").test(row.snapshot)
      || !/^[a-f0-9]{64}$/u.test(row.snapshotSha256)
      || createHash("sha256").update(await readFile(path.resolve("data", row.snapshot))).digest("hex") !== row.snapshotSha256) {
      throw new Error(`ledger de prosa inválido: ${row.caseId}`);
    }
    prose.add(row.caseId);
  }
  const albums = inventory.filter((row) => row.kind === "album").map((row) => row.entityId);
  const artists = inventory.filter((row) => row.kind === "artist").map((row) => row.entityId);
  const client = await getPool().connect();
  const external = new Set<string>();
  try {
    const { rows } = await client.query<{ kind: string; id: string }>(`
      SELECT 'album' AS kind, album_id::text AS id FROM ingest.album_genres
       WHERE album_id = ANY($1::bigint[]) AND source_kind = 'external' AND status = 'suggested'
      UNION ALL
      SELECT 'artist', artist_id::text FROM ingest.artist_genres
       WHERE artist_id = ANY($2::bigint[]) AND source_kind = 'external' AND status = 'suggested'`, [albums, artists]);
    for (const row of rows) external.add(`${row.kind}:${row.id}`);
  } finally { client.release(); await closeDb(); }
  const covered = new Set([...sincopa, ...external, ...wikidata, ...prose]);
  const residual = inventory.filter((row) => !covered.has(row.caseId));
  const byKind = Object.fromEntries(["album", "artist"].map((kind) => {
    const all = inventory.filter((row) => row.kind === kind);
    return [kind, { baseline: all.length, sincopa: all.filter((row) => sincopa.has(row.caseId)).length,
      wikidata: all.filter((row) => wikidata.has(row.caseId)).length,
      prose: all.filter((row) => prose.has(row.caseId)).length,
      external: all.filter((row) => external.has(row.caseId)).length,
      covered: all.filter((row) => covered.has(row.caseId)).length,
      remaining: all.filter((row) => !covered.has(row.caseId)).length }];
  }));
  const result = { generatedAt: new Date().toISOString(), baseline: inventory.length,
    sincopa: sincopa.size, wikidata: wikidata.size, prose: prose.size, external: external.size,
    overlap: [...sincopa].filter((id) => external.has(id)).length,
    covered: covered.size, remaining: residual.length, byKind,
    definition: "Género explícito Sincopa, frase directa de artista Rock De Vzla, P136 Wikidata con identidad corroborada y snapshot verificado, o sugerencia externa en base; no equivale a acierto ni decisión final de Laya",
    remainingIds: residual.map((row) => row.caseId) };
  await writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ baseline: result.baseline, sincopa: result.sincopa, wikidata: result.wikidata, prose: result.prose, external: result.external,
    overlap: result.overlap, covered: result.covered, remaining: result.remaining, byKind }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
