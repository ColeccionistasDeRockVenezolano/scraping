// Exportador de solo lectura para el piloto Laya de géneros.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { genreEntityDetail, listGenreQueue, type QueueCategory, type QueueItem } from "../src/genres/curation.js";
import { parseTagPolicy, type TagPolicy } from "../src/genres/external/mapping.js";
import { loadSheetsFile } from "../src/genres/external/sheets.js";
import {
  buildLayaPilotCase, type PilotAssignment, type PilotBiography, type PilotCase, type PilotExternalIdentity, type PilotSource,
} from "../src/genres/laya-pilot.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { loadTaxonomy } from "../src/genres/store.js";

const GROUPS: Array<{ category: QueueCategory; kind?: GenreEntityKind }> = [
  { category: "disagreement" }, { category: "genre_unknown" }, { category: "compound" },
  { category: "external_suggestion" }, { category: "unclassified", kind: "artist" },
];

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function artistBiographies(client: PoolClient, artistId: number): Promise<PilotBiography[]> {
  const { rows } = await client.query<{
    id: string; value: string | null; source_slug: string; url: string | null;
  }>(`
    SELECT c.id::text, c.raw_value #>> '{}' AS value, s.slug AS source_slug, ev.url
      FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
      LEFT JOIN LATERAL (
        SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id = c.id ORDER BY e.id LIMIT 1
      ) ev ON true
     WHERE c.entity_kind = 'artist' AND c.artist_id = $1 AND c.field = 'biography'
       AND c.status::text = 'accepted'
     ORDER BY c.id DESC LIMIT 3`, [artistId]);
  return rows.filter((row) => row.value?.trim()).map((row) => ({
    claimId: Number(row.id), sourceSlug: row.source_slug, text: row.value!, url: row.url,
  }));
}

async function currentExternalPolicies(client: PoolClient): Promise<Map<string, TagPolicy>> {
  const sheets = new Map((await loadSheetsFile()).map((sheet) => [sheet.slug, sheet]));
  const { rows } = await client.query<{ slug: string; status: string; import_enabled: boolean; tag_policy: unknown }>(
    "SELECT slug, status, import_enabled, tag_policy FROM ingest.genre_external_sources");
  const allowed = new Map<string, TagPolicy>();
  for (const row of rows) {
    if (row.status !== "authorized" || !row.import_enabled) continue;
    const dbPolicy = parseTagPolicy(row.tag_policy);
    const filePolicy = sheets.get(row.slug)?.tagPolicy;
    allowed.set(row.slug, filePolicy ? {
      ...dbPolicy,
      acceptKinds: dbPolicy.acceptKinds.filter((kind) => filePolicy.acceptKinds.includes(kind)),
      minTagCount: Math.max(dbPolicy.minTagCount, filePolicy.minTagCount),
      maxValues: Math.min(dbPolicy.maxValues, filePolicy.maxValues),
      ignore: [...new Set([...dbPolicy.ignore, ...filePolicy.ignore])],
      buckets: { ...dbPolicy.buckets, ...filePolicy.buckets },
    } : dbPolicy);
  }
  return allowed;
}

async function build(client: PoolClient, item: Pick<QueueItem, "kind" | "entityId" | "title"> & { categories: string[] },
                     taxonomy: Awaited<ReturnType<typeof loadTaxonomy>>,
                     externalPolicies: ReadonlyMap<string, TagPolicy>, allowConfirmedForEvaluation = false,
                     extraSources: PilotSource[] = []): Promise<PilotCase | null> {
  const detail = await genreEntityDetail(client, item.kind, item.entityId);
  if (!detail) return null;
  const sources = [...((detail["sources"] ?? []) as PilotSource[]), ...extraSources];
  const assignments = (detail["assignments"] ?? []) as PilotAssignment[];
  const externalIdentities = (detail["externalIdentities"] ?? []) as PilotExternalIdentity[];
  const biographies = item.kind === "artist" ? await artistBiographies(client, item.entityId) : [];
  return buildLayaPilotCase({
    kind: item.kind, entityId: item.entityId, title: item.title, categories: item.categories,
    sources, assignments, biographies, externalIdentities, externalPolicies, allowConfirmedForEvaluation, taxonomy,
  });
}

function interleave(groups: PilotCase[][], limit: number): PilotCase[] {
  const seen = new Set<string>();
  const selected: PilotCase[] = [];
  for (let index = 0; selected.length < limit && groups.some((group) => index < group.length); index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (!item || seen.has(item.caseId)) continue;
      selected.push(item);
      seen.add(item.caseId);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

async function main(): Promise<void> {
  const limit = Number(arg("limit") ?? "80");
  const mode = arg("mode") ?? "pending";
  if (mode !== "pending" && mode !== "reviewed" && mode !== "ledger"
    && mode !== "wikidata-ledger" && mode !== "prose-ledger") {
    throw new Error("--mode debe ser pending, reviewed, ledger, wikidata-ledger o prose-ledger");
  }
  const maxLimit = mode === "ledger" || mode === "wikidata-ledger" || mode === "prose-ledger" ? 500 : 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`--limit debe estar entre 1 y ${maxLimit}`);
  }
  const excluded = new Set<string>();
  if (arg("exclude")) {
    for (const line of (await readFile(path.resolve(arg("exclude")!), "utf8")).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { caseId?: unknown };
      if (typeof row.caseId !== "string") throw new Error("--exclude contiene un caso sin caseId");
      excluded.add(row.caseId);
    }
  }
  const output = path.resolve(arg("out") ?? "reports/genre-laya-cases.jsonl");
  const goldOutput = path.resolve(arg("gold-template") ?? "reports/genre-laya-gold-template.jsonl");
  if (output === goldOutput) throw new Error("--out y --gold-template deben ser rutas distintas");
  for (const file of [output, goldOutput]) {
    if (await stat(file).then(() => true, () => false)) throw new Error(`el archivo ya existe: ${file}`);
  }
  const client = await getPool().connect();
  let cases: PilotCase[];
  const reviewedGold = new Map<string, { primaryGenre: string; reviewer: string }>();
  try {
    const taxonomy = await loadTaxonomy(client);
    const externalPolicies = await currentExternalPolicies(client);
    if (mode === "reviewed") {
      const { rows } = await client.query<{
        kind: GenreEntityKind; entity_id: string; title: string; slug: string; reviewer: string;
      }>(`
        SELECT 'album' AS kind, x.album_id::text AS entity_id, a.title, g.slug, x.decided_by AS reviewer
          FROM ingest.album_genres x JOIN public.albums a ON a.id = x.album_id
          JOIN ingest.genres g ON g.id = x.genre_id
         WHERE x.decision_kind = 'human' AND x.status = 'confirmed' AND x.role = 'primary'
        UNION ALL
        SELECT 'artist', x.artist_id::text, a.name, g.slug, x.decided_by
          FROM ingest.artist_genres x JOIN public.artists a ON a.id = x.artist_id
          JOIN ingest.genres g ON g.id = x.genre_id
         WHERE x.decision_kind = 'human' AND x.status = 'confirmed' AND x.role = 'primary'
        ORDER BY kind, entity_id`);
      cases = [];
      for (const row of rows) {
        if (excluded.has(`${row.kind}:${row.entity_id}`)) continue;
        const built = await build(client, {
          kind: row.kind, entityId: Number(row.entity_id), title: row.title, categories: ["human_reviewed"],
        }, taxonomy, externalPolicies, true);
        if (!built) continue;
        cases.push(built);
        reviewedGold.set(built.caseId, { primaryGenre: row.slug, reviewer: row.reviewer });
        if (cases.length >= limit) break;
      }
    } else if (mode === "prose-ledger") {
      const file = arg("ledger");
      if (!file) throw new Error("--mode=prose-ledger necesita --ledger=<jsonl>");
      const rows = (await readFile(path.resolve(file), "utf8")).split(/\r?\n/u).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          caseId: string; kind: string; entityId: number; title: string; source: string; rawGenre: string;
          excerpt: string; url: string; snapshot: string; snapshotSha256: string; signals: string[];
        });
      cases = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (cases.length >= limit) break;
        if (row.kind !== "artist" || row.caseId !== `artist:${row.entityId}` || seen.has(row.caseId)
          || !["rock-de-vzla", "rockzuela"].includes(row.source)
          || new URL(row.url).hostname !== (row.source === "rockzuela" ? "rockzuela.blogspot.com" : "rockdevzla.blogspot.com")
          || !new RegExp(`^raw/${row.source}/[a-f0-9]{64}\\.json$`, "u").test(row.snapshot)
          || !/^[a-f0-9]{64}$/u.test(row.snapshotSha256) || !row.rawGenre?.trim()
          || !row.excerpt?.trim() || !row.signals?.includes("direct_artist_genre_phrase")) {
          throw new Error(`fila de prosa inválida: ${row.caseId}`);
        }
        seen.add(row.caseId);
        if (excluded.has(row.caseId)) continue;
        const snapshot = await readFile(path.resolve("data", row.snapshot));
        if (createHash("sha256").update(snapshot).digest("hex") !== row.snapshotSha256) {
          throw new Error(`snapshot modificado: ${row.caseId}`);
        }
        const source: PilotSource = {
          claimId: 0, ref: `snapshot:${row.source}:${row.snapshotSha256}:${row.entityId}`,
          level: "artist", status: "accepted", rawValue: row.rawGenre,
          sourceSlug: row.source, evidence: [{ url: row.url, excerpt: row.excerpt }],
        };
        const built = await build(client, { kind: "artist", entityId: row.entityId, title: row.title,
          categories: ["artist_prose_evidence"] }, taxonomy, externalPolicies, false, [source]);
        if (built) cases.push(built);
      }
    } else if (mode === "wikidata-ledger") {
      const file = arg("ledger");
      if (!file) throw new Error("--mode=wikidata-ledger necesita --ledger=<jsonl>");
      const rows = (await readFile(path.resolve(file), "utf8")).split(/\r?\n/u).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          caseId: string; kind: string; entityId: number; title: string; source: string; qid: string;
          url: string; genres: Array<{ qid: string; label: string }>;
          sampleSnapshot: string; sampleSha256: string; corrobSnapshot: string; corrobSha256: string;
          signals: string[];
        });
      cases = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (cases.length >= limit) break;
        if (row.kind !== "artist" || row.caseId !== `artist:${row.entityId}` || seen.has(row.caseId)
          || row.source !== "wikidata" || !/^Q\d+$/u.test(row.qid)
          || row.url !== `https://www.wikidata.org/wiki/${row.qid}`
          || !row.genres?.length || !row.signals?.includes("artist_name")
          || !row.signals.some((signal) => signal === "discogs_id" || signal === "album_title")) {
          throw new Error(`fila Wikidata inválida: ${row.caseId}`);
        }
        seen.add(row.caseId);
        if (excluded.has(row.caseId)) continue;
        for (const [filename, hash] of [[row.sampleSnapshot, row.sampleSha256],
          [row.corrobSnapshot, row.corrobSha256]] as Array<[string, string]>) {
          const absolute = path.resolve(filename);
          if (!absolute.startsWith(path.resolve("reports") + path.sep) || !/^[a-f0-9]{64}$/u.test(hash)) {
            throw new Error(`snapshot Wikidata inválido: ${row.caseId}`);
          }
          if (createHash("sha256").update(await readFile(absolute)).digest("hex") !== hash) {
            throw new Error(`snapshot Wikidata modificado: ${row.caseId}`);
          }
        }
        if (row.genres.some((genre) => !/^Q\d+$/u.test(genre.qid) || !genre.label.trim())) {
          throw new Error(`género Wikidata inválido: ${row.caseId}`);
        }
        const sources: PilotSource[] = row.genres.map((genre) => ({
          claimId: 0, ref: `wikidata:${row.qid}:${genre.qid}`, level: "artist", status: "accepted",
          rawValue: genre.label, sourceSlug: "wikidata", evidence: [{ url: row.url, excerpt: `P136: ${genre.label}` }],
        }));
        const built = await build(client, { kind: "artist", entityId: row.entityId, title: row.title,
          categories: ["wikidata_evidence_pilot"] }, taxonomy, externalPolicies, false, sources);
        if (built) cases.push(built);
      }
    } else if (mode === "ledger") {
      const file = arg("ledger");
      if (!file) throw new Error("--mode=ledger necesita --ledger=<jsonl>");
      const rows = (await readFile(path.resolve(file), "utf8")).split(/\r?\n/u).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          caseId: string; kind: string; entityId: number; title: string; source: string; rawGenre: string;
          url: string; snapshot: string; snapshotSha256: string;
        });
      cases = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (cases.length >= limit) break;
        if ((row.kind !== "album" && row.kind !== "artist") || row.caseId !== `${row.kind}:${row.entityId}` || seen.has(row.caseId)
          || row.source !== "sincopa" || !row.url.startsWith("https://sincopa.com/")
          || !/^raw\/sincopa\/[a-f0-9]{64}\.html$/u.test(row.snapshot)
          || !/^[a-f0-9]{64}$/u.test(row.snapshotSha256) || !row.rawGenre?.trim()) {
          throw new Error(`fila de ledger inválida: ${row.caseId}`);
        }
        seen.add(row.caseId);
        if (excluded.has(row.caseId)) continue;
        const snapshot = await readFile(path.resolve("data", row.snapshot));
        if (createHash("sha256").update(snapshot).digest("hex") !== row.snapshotSha256) {
          throw new Error(`snapshot modificado: ${row.caseId}`);
        }
        const source: PilotSource = {
          claimId: 0, ref: `snapshot:sincopa:${row.snapshotSha256}:${row.entityId}`,
          level: row.kind, status: "accepted", rawValue: row.rawGenre,
          sourceSlug: "sincopa", evidence: [{ url: row.url, excerpt: `Genre: ${row.rawGenre}` }],
        };
        const built = await build(client, { kind: row.kind, entityId: row.entityId, title: row.title, categories: ["snapshot_evidence"] },
          taxonomy, externalPolicies, false, [source]);
        if (built) cases.push(built);
      }
    } else {
      const groups: PilotCase[][] = [];
      for (const group of GROUPS) {
        const items = (await listGenreQueue(client, { ...group, limit: 200 })).items;
        const casesForGroup: PilotCase[] = [];
        for (const item of items) {
          if (excluded.has(`${item.kind}:${item.entityId}`)) continue;
          const built = await build(client, item, taxonomy, externalPolicies);
          if (built) casesForGroup.push(built);
          if (casesForGroup.length >= limit) break;
        }
        groups.push(casesForGroup);
      }
      cases = interleave(groups, limit);
    }
  } finally {
    client.release();
    await closeDb();
  }
  if (!cases.length) throw new Error("no hay casos pendientes con evidencia y candidatos válidos");
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.dirname(goldOutput), { recursive: true });
  await writeFile(output, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, { flag: "wx" });
  try {
    await writeFile(goldOutput, `${cases.map((item) => JSON.stringify({
      caseId: item.caseId, reviewed: mode === "reviewed",
      primaryGenre: reviewedGold.get(item.caseId)?.primaryGenre ?? null,
      reviewer: reviewedGold.get(item.caseId)?.reviewer ?? "", note: "",
    })).join("\n")}\n`, { flag: "wx" });
  } catch (error) {
    await unlink(output);
    throw error;
  }
  console.log(`Piloto Laya (${mode}): ${cases.length} casos con evidencia → ${output}`);
  console.log(`Plantilla de revisión humana → ${goldOutput}`);
  console.log("No se escribió ninguna asignación de género en la base.");
}

main().catch(async (error: unknown) => {
  console.error(`genre-laya-export: ${error instanceof Error ? error.message : String(error)}`);
  await closeDb();
  process.exitCode = 1;
});
