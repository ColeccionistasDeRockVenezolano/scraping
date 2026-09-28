// Cruza fichas de álbum Sincopa en caché con álbumes aún sin evidencia.
// Exige título y artista únicos; compara año cuando ambos lo publican.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapterFor } from "../src/adapters/registry.js";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

interface Row { caseId: string; kind: string; entityId: number; title: string; artistName: string | null; year: number | null }
const ROOT = path.resolve("reports");
const key = (artist: string, title: string) => `${normalizeIdentitySecondary(artist)}::${normalizeIdentitySecondary(title)}`;

async function main(): Promise<void> {
  const inventory = (await readFile(path.join(ROOT, "genre-laya-evidence-coverage-2026-09-26-inventory.jsonl"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Row).filter((row) => row.kind === "album");
  const linked = new Set((await readFile(path.join(ROOT, "genre-laya-evidence-sincopa-2026-09-26.jsonl"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => (JSON.parse(line) as Row).caseId));
  const wanted = new Map<string, Row[]>();
  for (const row of inventory.filter((item) => !linked.has(item.caseId) && item.artistName)) {
    const id = key(row.artistName!, row.title);
    wanted.set(id, [...(wanted.get(id) ?? []), row]);
  }
  const client = await getPool().connect();
  let pages: Array<{ url: string; stored_path: string }>;
  try {
    pages = (await client.query<{ url: string; stored_path: string }>(`
      SELECT DISTINCT ON (p.url) p.url,p.stored_path
        FROM ingest.raw_pages p JOIN ingest.sources s ON s.id=p.source_id
       WHERE s.slug='sincopa' AND p.http_status=200 AND p.url LIKE '%/cdinfo_rock/%'
         AND p.stored_path IS NOT NULL ORDER BY p.url,p.fetched_at DESC`)).rows;
  } finally { client.release(); await closeDb(); }
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
    const albums = records.filter((record) => record.entityKind === "album"
      && record.fields.some((field) => field.field === "genre"));
    if (albums.length !== 1) { skip("no_single_album_genre"); continue; }
    const field = (name: string) => String(albums[0]!.fields.find((item) => item.field === name)?.value ?? "");
    const title = field("title"); const artist = field("artist_name"); const genre = field("genre");
    const matches = wanted.get(key(artist, title)) ?? [];
    if (matches.length !== 1) { skip("no_unique_identity_match"); continue; }
    const target = matches[0]!;
    const year = Number(field("release_year"));
    if (target.year !== null && Number.isSafeInteger(year) && year > 0 && target.year !== year) {
      skip("year_mismatch"); continue;
    }
    recovered.push({ caseId: target.caseId, kind: "album", entityId: target.entityId,
      source: "sincopa", rawGenre: genre, url: page.url, snapshot: page.stored_path,
      snapshotSha256: createHash("sha256").update(body).digest("hex"), title, artist,
      year: year || null, signals: ["album_title", "artist_name", ...(target.year && year ? ["release_year"] : [])] });
  }
  if (new Set(recovered.map((row) => row["caseId"])).size !== recovered.length) {
    throw new Error("múltiples páginas para un álbum: revisar manualmente");
  }
  const output = path.join(ROOT, "genre-laya-evidence-sincopa-albums-discovered-2026-09-26.jsonl");
  await writeFile(output, recovered.map((row) => JSON.stringify(row)).join("\n") + (recovered.length ? "\n" : ""));
  await writeFile(path.join(ROOT, "genre-laya-evidence-sincopa-albums-discovered-2026-09-26.json"),
    JSON.stringify({ pages: pages.length, recovered: recovered.length, skipped }, null, 2) + "\n");
  console.log(JSON.stringify({ pages: pages.length, recovered: recovered.length, skipped }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
