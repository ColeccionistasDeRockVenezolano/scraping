// Corrobora identidad Wikidata por Discogs ID o álbum, antes de exponer P136 a Laya.
// Solo escribe un ledger; la fuente sigue en estado evaluating en la base.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

interface Base { caseId: string; kind: string; entityId: number; title: string }
interface SampleRow { qid: string; name: string; genreQid: string; genre: string; instanceQid: string | null; mbid: string | null }
interface Binding { artist: { value: string }; discogs?: { value: string }; albumLabel?: { value: string } }
const SAMPLE = path.resolve("reports/genre-laya-evidence-wikidata-artist-sample-2026-09-26.json");
const CORROB = path.resolve("reports/genre-laya-evidence-wikidata-artist-corrob-2026-09-26.json");

async function main(): Promise<void> {
  const inventory = (await readFile("reports/genre-laya-evidence-coverage-2026-09-26-inventory.jsonl", "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Base).filter((row) => row.kind === "artist");
  const covered = new Set((await readFile("reports/genre-laya-evidence-sincopa-artists-2026-09-26.jsonl", "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => (JSON.parse(line) as Base).caseId));
  const sampleBody = await readFile(SAMPLE);
  const corrobBody = await readFile(CORROB);
  const sample = (JSON.parse(sampleBody.toString()) as { rows: SampleRow[] }).rows;
  const bindings = (JSON.parse(corrobBody.toString()) as { data: { results: { bindings: Binding[] } } }).data.results.bindings;
  const targetByName = new Map<string, Base[]>();
  for (const row of inventory.filter((item) => !covered.has(item.caseId))) {
    const key = normalizeIdentitySecondary(row.title);
    targetByName.set(key, [...(targetByName.get(key) ?? []), row]);
  }
  const byQid = new Map<string, SampleRow[]>();
  for (const row of sample) byQid.set(row.qid, [...(byQid.get(row.qid) ?? []), row]);
  const client = await getPool().connect();
  let albums: Array<{ artist_id: string; title: string }>;
  let identities: Array<{ entity_id: string; external_id: string }>;
  try {
    albums = (await client.query<{ artist_id: string; title: string }>(`
      SELECT artist_id::text,title FROM public.albums
       WHERE artist_id = ANY($1::bigint[])`, [inventory.map((row) => row.entityId)])).rows;
    identities = (await client.query<{ entity_id: string; external_id: string }>(`
      SELECT i.entity_id::text,i.external_id FROM ingest.genre_external_identities i
        JOIN ingest.genre_external_sources s ON s.id=i.source_id
       WHERE s.slug='discogs' AND i.entity_kind='artist' AND i.status='matched'
         AND i.entity_id = ANY($1::bigint[])`, [inventory.map((row) => row.entityId)])).rows;
  } finally { client.release(); await closeDb(); }
  const albumNames = new Map<string, Set<string>>();
  for (const album of albums) {
    const names = albumNames.get(album.artist_id) ?? new Set<string>();
    names.add(normalizeIdentitySecondary(album.title)); albumNames.set(album.artist_id, names);
  }
  const discogsById = new Map(identities.map((row) => [row.entity_id, row.external_id]));
  const proof = new Map<string, { discogs: Set<string>; albums: Set<string> }>();
  for (const row of bindings) {
    const qid = row.artist.value.split("/").pop() ?? "";
    const entry = proof.get(qid) ?? { discogs: new Set<string>(), albums: new Set<string>() };
    if (row.discogs?.value) entry.discogs.add(row.discogs.value);
    if (row.albumLabel?.value) entry.albums.add(normalizeIdentitySecondary(row.albumLabel.value));
    proof.set(qid, entry);
  }
  const qidsByName = new Map<string, Set<string>>();
  for (const [qid, rows] of byQid) {
    const name = normalizeIdentitySecondary(rows[0]?.name ?? "");
    const set = qidsByName.get(name) ?? new Set<string>(); set.add(qid); qidsByName.set(name, set);
  }
  const recovered: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];
  for (const [qid, rows] of byQid) {
    const first = rows[0]!;
    const key = normalizeIdentitySecondary(first.name);
    const targets = targetByName.get(key) ?? [];
    if (targets.length !== 1 || qidsByName.get(key)?.size !== 1) continue;
    const target = targets[0]!;
    if (!rows.some((row) => row.instanceQid === "Q5" || row.instanceQid === "Q215380")) {
      rejected.push({ caseId: target.caseId, qid, reason: "not_musical_artist_type" }); continue;
    }
    const corroboration = proof.get(qid);
    const discogs = discogsById.get(String(target.entityId));
    const discogsMatch = !!discogs && !!corroboration?.discogs.has(discogs);
    const sharedAlbum = [...(corroboration?.albums ?? [])].find((name) =>
      albumNames.get(String(target.entityId))?.has(name));
    if (!discogsMatch && !sharedAlbum) {
      rejected.push({ caseId: target.caseId, qid, reason: "no_second_identity_signal" }); continue;
    }
    const genres = [...new Map(rows.filter((row) => row.genre && /^Q\d+$/u.test(row.genreQid))
      .map((row) => [row.genreQid, { qid: row.genreQid, label: row.genre }])).values()];
    if (!genres.length) continue;
    recovered.push({ caseId: target.caseId, kind: "artist", entityId: target.entityId,
      title: target.title, source: "wikidata", qid, genres,
      url: `https://www.wikidata.org/wiki/${qid}`,
      sampleSnapshot: path.relative(process.cwd(), SAMPLE), sampleSha256: createHash("sha256").update(sampleBody).digest("hex"),
      corrobSnapshot: path.relative(process.cwd(), CORROB), corrobSha256: createHash("sha256").update(corrobBody).digest("hex"),
      signals: ["artist_name", "venezuela", ...(discogsMatch ? ["discogs_id"] : []), ...(sharedAlbum ? ["album_title"] : [])],
      ...(discogsMatch ? { discogsId: discogs } : {}), ...(sharedAlbum ? { albumCrosscheck: sharedAlbum } : {}) });
  }
  const output = "reports/genre-laya-evidence-wikidata-artists-2026-09-26.jsonl";
  await writeFile(output, recovered.map((row) => JSON.stringify(row)).join("\n") + (recovered.length ? "\n" : ""));
  await writeFile("reports/genre-laya-evidence-wikidata-artists-2026-09-26.json",
    JSON.stringify({ examined: byQid.size, recovered: recovered.length, rejected }, null, 2) + "\n");
  console.log(JSON.stringify({ examined: byQid.size, recovered: recovered.length, rejected: rejected.length }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
