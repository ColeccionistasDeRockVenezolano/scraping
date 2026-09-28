// Encuentra artistas sin URL aceptada con ficha Sincopa en caché.
// Exige nombre exacto normalizado y al menos un álbum coincidente del catálogo.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapterFor } from "../src/adapters/registry.js";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

interface Row { caseId: string; kind: string; entityId: number; title: string }
const ROOT = path.resolve("reports");

async function main(): Promise<void> {
  const inventory = (await readFile(path.join(ROOT, "genre-laya-evidence-coverage-2026-09-26-inventory.jsonl"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Row).filter((row) => row.kind === "artist");
  const linked = new Set((await readFile(path.join(ROOT, "genre-laya-evidence-sincopa-artists-2026-09-26.jsonl"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => (JSON.parse(line) as Row).caseId));
  const names = new Map<string, Row[]>();
  for (const row of inventory.filter((item) => !linked.has(item.caseId))) {
    const key = normalizeIdentitySecondary(row.title);
    names.set(key, [...(names.get(key) ?? []), row]);
  }
  const client = await getPool().connect();
  let pages: Array<{ url: string; stored_path: string }>;
  let albums: Array<{ artist_id: string; title: string }>;
  try {
    pages = (await client.query<{ url: string; stored_path: string }>(`
      SELECT DISTINCT ON (p.url) p.url, p.stored_path
        FROM ingest.raw_pages p JOIN ingest.sources s ON s.id=p.source_id
       WHERE s.slug='sincopa' AND p.http_status=200 AND p.url LIKE '%/artist_rock/%'
         AND p.stored_path IS NOT NULL ORDER BY p.url,p.fetched_at DESC`)).rows;
    albums = (await client.query<{ artist_id: string; title: string }>(`
      SELECT a.artist_id::text,a.title FROM public.albums a
       WHERE a.artist_id = ANY($1::bigint[])`, [inventory.map((row) => row.entityId)])).rows;
  } finally { client.release(); await closeDb(); }
  const albumNames = new Map<string, Set<string>>();
  for (const album of albums) {
    const set = albumNames.get(album.artist_id) ?? new Set<string>();
    set.add(normalizeIdentitySecondary(album.title)); albumNames.set(album.artist_id, set);
  }
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa no disponible");
  const recovered: Record<string, unknown>[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const page of pages) {
    const file = path.resolve("data", page.stored_path);
    if (!file.startsWith(path.resolve("data/raw/sincopa") + path.sep)) throw new Error("snapshot fuera de Sincopa");
    const body = await readFile(file);
    const records = adapter.extractSnapshot({ url: page.url, kind: "html", rawPageId: 0,
      body: adapter.decodeBody ? adapter.decodeBody(body) : body.toString("utf8") });
    const artists = records.filter((record) => record.entityKind === "artist"
      && record.fields.some((field) => field.field === "genre"));
    if (artists.length !== 1) { skip("no_single_artist_genre"); continue; }
    const name = String(artists[0]!.fields.find((field) => field.field === "name")?.value ?? "");
    const genre = String(artists[0]!.fields.find((field) => field.field === "genre")?.value ?? "");
    const candidates = names.get(normalizeIdentitySecondary(name)) ?? [];
    if (candidates.length !== 1) { skip("no_unique_name_match"); continue; }
    const target = candidates[0]!;
    const other = albumNames.get(String(target.entityId)) ?? new Set<string>();
    const shared = records.filter((record) => record.entityKind === "album")
      .map((record) => String(record.fields.find((field) => field.field === "title")?.value ?? ""))
      .find((title) => other.has(normalizeIdentitySecondary(title)));
    if (!shared) { skip("no_album_crosscheck"); continue; }
    recovered.push({ caseId: target.caseId, kind: "artist", entityId: target.entityId,
      source: "sincopa", rawGenre: genre, url: page.url, snapshot: page.stored_path,
      snapshotSha256: createHash("sha256").update(body).digest("hex"), title: name,
      albumCrosscheck: shared, signals: ["artist_name", "album_title"] });
  }
  const unique = new Set(recovered.map((row) => row["caseId"]));
  if (unique.size !== recovered.length) throw new Error("múltiples páginas para un artista: revisar manualmente");
  const output = path.join(ROOT, "genre-laya-evidence-sincopa-artists-discovered-2026-09-26.jsonl");
  await writeFile(output, recovered.map((row) => JSON.stringify(row)).join("\n") + (recovered.length ? "\n" : ""));
  await writeFile(path.join(ROOT, "genre-laya-evidence-sincopa-artists-discovered-2026-09-26.json"),
    JSON.stringify({ pages: pages.length, recovered: recovered.length, skipped }, null, 2) + "\n");
  console.log(JSON.stringify({ pages: pages.length, recovered: recovered.length, skipped }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
