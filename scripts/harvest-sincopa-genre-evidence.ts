// Recupera el campo Genre explícito de fichas Sincopa ya descargadas.
// Solo produce un ledger verificable; nunca confirma géneros ni toca core.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapterFor } from "../src/adapters/registry.js";
import type { RawRecord } from "../src/adapters/contracts.js";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

const ROOT = path.resolve(process.cwd());
const INVENTORY = path.join(ROOT, "reports/genre-laya-evidence-coverage-2026-09-26-inventory.jsonl");
const OUTPUT = path.join(ROOT, "reports/genre-laya-evidence-sincopa-2026-09-26.jsonl");
const REPORT = path.join(ROOT, "reports/genre-laya-evidence-sincopa-2026-09-26.json");
const REJECTED = path.join(ROOT, "reports/genre-laya-evidence-sincopa-rejected-2026-09-26.jsonl");

interface InventoryRow {
  caseId: string; kind: "album" | "artist"; entityId: number; title: string; artistName: string | null; year: number | null;
  sourceLinks: Array<{ source: string; url: string; snapshot: string | null }>;
}

function field(record: RawRecord, name: string): string | null {
  const value = record.fields.find((item) => item.field === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function agrees(value: string | null, alternatives: string[]): boolean {
  if (!value) return false;
  const normalized = normalizeIdentitySecondary(value);
  return alternatives.some((alternative) => normalizeIdentitySecondary(alternative) === normalized);
}

async function main(): Promise<void> {
  const inventory = (await readFile(INVENTORY, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as InventoryRow);
  const fetched = new Map<string, string>();
  const fetchReport = path.join(ROOT, "reports/genre-laya-evidence-sincopa-fetch-2026-09-26.jsonl");
  try {
    for (const line of (await readFile(fetchReport, "utf8")).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { url: string; status?: number; snapshot?: string };
      if (entry.status === 200 && entry.snapshot) fetched.set(entry.url, entry.snapshot);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const snapshotFor = (link: InventoryRow["sourceLinks"][number]) => link.snapshot ?? fetched.get(link.url) ?? null;
  const targets = inventory.filter((row) => row.kind === "album"
    && row.sourceLinks.some((link) => link.source === "sincopa" && snapshotFor(link)));
  const ids = targets.map((row) => row.entityId);
  const client = await getPool().connect();
  let accepted: Array<{ album_id: string; field: string; value: string }>;
  try {
    const { rows } = await client.query<{ album_id: string; field: string; value: string }>(`
      SELECT c.album_id::text, c.field::text, c.raw_value #>> '{}' AS value
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.album_id = ANY($1::bigint[]) AND c.entity_kind = 'album' AND s.slug = 'sincopa'
         AND c.field IN ('title','artist_name') AND c.status::text = 'accepted'`, [ids]);
    accepted = rows;
  } finally {
    client.release();
    await closeDb();
  }
  const aliases = new Map<string, { title: string[]; artist_name: string[] }>();
  for (const row of accepted) {
    const entry = aliases.get(row.album_id) ?? { title: [], artist_name: [] };
    entry[row.field as "title" | "artist_name"].push(row.value);
    aliases.set(row.album_id, entry);
  }
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa sin extractSnapshot");
  const results: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  const skipped: Record<string, number> = {};
  const skip = (row: InventoryRow, reason: string, parsed?: RawRecord) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    rejected.push({ caseId: row.caseId, reason, expectedTitle: row.title, expectedArtist: row.artistName,
      parsedTitle: parsed ? field(parsed, "title") : null, parsedArtist: parsed ? field(parsed, "artist_name") : null,
      parsedGenre: parsed ? field(parsed, "genre") : null,
      url: row.sourceLinks.find((link) => link.source === "sincopa" && snapshotFor(link))?.url ?? null });
  };
  for (const row of targets) {
    const link = row.sourceLinks.find((item) => item.source === "sincopa" && snapshotFor(item));
    if (!link) continue;
    const snapshot = snapshotFor(link)!;
    const file = path.resolve(ROOT, "data", snapshot);
    if (!file.startsWith(path.resolve(ROOT, "data/raw/sincopa") + path.sep)) throw new Error(`snapshot fuera de Sincopa: ${file}`);
    let body: Buffer;
    try { body = await readFile(file); } catch { skip(row, "snapshot_missing"); continue; }
    const text = adapter.decodeBody ? adapter.decodeBody(body) : body.toString("utf8");
    const records = adapter.extractSnapshot({ url: link.url, kind: "html", rawPageId: 0, body: text });
    const albums = records.filter((record) => record.entityKind === "album");
    if (albums.length !== 1) { skip(row, "not_one_album_record", albums[0]); continue; }
    const parsed = albums[0]!;
    const genre = field(parsed, "genre");
    if (!genre) { skip(row, "no_explicit_genre", parsed); continue; }
    const known = aliases.get(String(row.entityId)) ?? { title: [], artist_name: [] };
    if (!agrees(field(parsed, "title"), [row.title, ...known.title])) { skip(row, "title_mismatch", parsed); continue; }
    if (!agrees(field(parsed, "artist_name"), [row.artistName ?? "", ...known.artist_name])) { skip(row, "artist_mismatch", parsed); continue; }
    const parsedYear = Number(field(parsed, "release_year"));
    if (row.year !== null && Number.isSafeInteger(parsedYear) && parsedYear > 0 && row.year !== parsedYear) {
      skip(row, "year_mismatch", parsed); continue;
    }
    results.push({
      caseId: row.caseId, kind: "album", entityId: row.entityId, source: "sincopa", rawGenre: genre,
      url: link.url, snapshot, snapshotSha256: createHash("sha256").update(body).digest("hex"),
      title: field(parsed, "title"), artist: field(parsed, "artist_name"), year: parsedYear || null,
      signals: ["accepted_source_url", "album_title", "artist_name", ...(row.year && parsedYear ? ["release_year"] : [])],
    });
  }
  if (new Set(results.map((row) => row["caseId"])).size !== results.length) throw new Error("entidades duplicadas en ledger");
  await writeFile(OUTPUT, `${results.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(REJECTED, `${rejected.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(REPORT, `${JSON.stringify({ scanned: targets.length, recovered: results.length, skipped }, null, 2)}\n`);
  console.log(JSON.stringify({ scanned: targets.length, recovered: results.length, skipped }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
