// Recupera el Genre explícito de fichas de artista Sincopa enlazadas al core.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapterFor } from "../src/adapters/registry.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

const inventory = path.resolve("reports/genre-laya-evidence-coverage-2026-09-26-inventory.jsonl");
const output = path.resolve("reports/genre-laya-evidence-sincopa-artists-2026-09-26.jsonl");
const report = path.resolve("reports/genre-laya-evidence-sincopa-artists-2026-09-26.json");

async function main(): Promise<void> {
  const rows = (await readFile(inventory, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
    caseId: string; kind: string; entityId: number; title: string;
    sourceLinks: Array<{ source: string; url: string; snapshot: string | null }>;
  });
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa no disponible");
  const accepted: Record<string, number> = {};
  const recovered: Record<string, unknown>[] = [];
  for (const row of rows.filter((item) => item.kind === "artist")) {
    const link = row.sourceLinks.find((item) => item.source === "sincopa" && item.snapshot);
    if (!link) continue;
    const url = new URL(link.url);
    if (url.hostname !== "sincopa.com" || !url.pathname.includes("/artist_")) {
      accepted["not_artist_detail"] = (accepted["not_artist_detail"] ?? 0) + 1; continue;
    }
    const filename = path.resolve("data", link.snapshot!);
    if (!filename.startsWith(path.resolve("data/raw/sincopa") + path.sep)) throw new Error("snapshot fuera de Sincopa");
    const body = await readFile(filename);
    const parsed = adapter.extractSnapshot({ url: link.url, kind: "html", rawPageId: 0,
      body: adapter.decodeBody ? adapter.decodeBody(body) : body.toString("utf8") });
    const artists = parsed.filter((item) => item.entityKind === "artist" && item.fields.some((field) => field.field === "genre"));
    if (artists.length !== 1) { accepted["no_single_artist_genre"] = (accepted["no_single_artist_genre"] ?? 0) + 1; continue; }
    const artist = artists[0]!;
    const name = String(artist.fields.find((field) => field.field === "name")?.value ?? "");
    const genre = String(artist.fields.find((field) => field.field === "genre")?.value ?? "");
    if (normalizeIdentitySecondary(name) !== normalizeIdentitySecondary(row.title)) {
      accepted["name_mismatch"] = (accepted["name_mismatch"] ?? 0) + 1; continue;
    }
    recovered.push({ caseId: row.caseId, kind: "artist", entityId: row.entityId, source: "sincopa",
      rawGenre: genre, url: link.url, snapshot: link.snapshot,
      snapshotSha256: createHash("sha256").update(body).digest("hex"), title: name,
      signals: ["accepted_source_url", "artist_name"] });
  }
  await writeFile(output, recovered.map((item) => JSON.stringify(item)).join("\n") + (recovered.length ? "\n" : ""));
  await writeFile(report, JSON.stringify({ recovered: recovered.length, skipped: accepted }, null, 2) + "\n");
  console.log(JSON.stringify({ recovered: recovered.length, skipped: accepted }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
