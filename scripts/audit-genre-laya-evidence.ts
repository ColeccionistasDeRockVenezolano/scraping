// Auditoría de solo lectura de evidencia del mismo nivel en la cola de géneros.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { genreEntityDetail, listGenreQueue, type QueueItem } from "../src/genres/curation.js";
import { parseTagPolicy, type TagPolicy } from "../src/genres/external/mapping.js";
import { loadSheetsFile } from "../src/genres/external/sheets.js";
import {
  buildLayaPilotCase, type PilotAssignment, type PilotBiography, type PilotExternalIdentity, type PilotSource,
} from "../src/genres/laya-pilot.js";
import { loadTaxonomy } from "../src/genres/store.js";

type Kind = "album" | "artist";
type EvidenceFlags = { genre: boolean; biography: boolean; external: boolean };
const empty = (): EvidenceFlags => ({ genre: false, biography: false, external: false });
const key = (kind: Kind, id: number) => `${kind}:${id}`;

async function allQueue(client: PoolClient): Promise<QueueItem[]> {
  const first = await listGenreQueue(client, { limit: 200 });
  const items = [...first.items];
  for (let offset = 200; offset < first.total; offset += 200) {
    const page = await listGenreQueue(client, { limit: 200, offset });
    if (page.total !== first.total) throw new Error("la cola cambió durante la auditoría; repite el conteo");
    items.push(...page.items);
  }
  if (items.length !== first.total) throw new Error("cola incompleta");
  return items;
}

async function flagsFor(client: PoolClient, items: QueueItem[]): Promise<Map<string, EvidenceFlags>> {
  const albumIds = items.filter((item) => item.kind === "album").map((item) => item.entityId);
  const artistIds = items.filter((item) => item.kind === "artist").map((item) => item.entityId);
  const flags = new Map(items.map((item) => [key(item.kind, item.entityId), empty()]));
  const { rows: claims } = await client.query<{ kind: Kind; entity_id: string; field: string }>(`
    SELECT c.entity_kind::text AS kind, COALESCE(c.album_id, c.artist_id)::text AS entity_id, c.field::text
      FROM ingest.claims c
     WHERE ((c.entity_kind = 'album' AND c.album_id = ANY($1::bigint[]) AND c.field = 'genre')
         OR (c.entity_kind = 'artist' AND c.artist_id = ANY($2::bigint[]) AND c.field IN ('genre','biography')))
       AND c.status::text IN ('accepted','conflict') AND btrim(COALESCE(c.raw_value #>> '{}','')) <> ''
     GROUP BY 1,2,3`, [albumIds, artistIds]);
  for (const row of claims) {
    const flag = flags.get(key(row.kind, Number(row.entity_id)));
    if (flag) {
      if (row.field === "genre") flag.genre = true;
      if (row.field === "biography") flag.biography = true;
    }
  }
  const { rows: external } = await client.query<{ kind: Kind; entity_id: string }>(`
    SELECT 'album'::text AS kind, album_id::text AS entity_id FROM ingest.album_genres
     WHERE album_id = ANY($1::bigint[]) AND status = 'suggested' AND source_kind = 'external'
    UNION ALL
    SELECT 'artist', artist_id::text FROM ingest.artist_genres
     WHERE artist_id = ANY($2::bigint[]) AND status = 'suggested' AND source_kind = 'external'`, [albumIds, artistIds]);
  for (const row of external) {
    const flag = flags.get(key(row.kind, Number(row.entity_id)));
    if (flag) flag.external = true;
  }
  return flags;
}

async function biographies(client: PoolClient, artistId: number): Promise<PilotBiography[]> {
  const { rows } = await client.query<{ id: string; value: string | null; source_slug: string; url: string | null }>(`
    SELECT c.id::text, c.raw_value #>> '{}' AS value, s.slug AS source_slug, ev.url
      FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
      LEFT JOIN LATERAL (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id = c.id ORDER BY e.id LIMIT 1) ev ON true
     WHERE c.entity_kind = 'artist' AND c.artist_id = $1 AND c.field = 'biography' AND c.status::text = 'accepted'
     ORDER BY c.id DESC LIMIT 3`, [artistId]);
  return rows.filter((row) => row.value?.trim()).map((row) => ({
    claimId: Number(row.id), sourceSlug: row.source_slug, text: row.value!, url: row.url,
  }));
}

async function externalPolicies(client: PoolClient): Promise<Map<string, TagPolicy>> {
  const sheets = new Map((await loadSheetsFile()).map((sheet) => [sheet.slug, sheet]));
  const { rows } = await client.query<{ slug: string; status: string; import_enabled: boolean; tag_policy: unknown }>(
    "SELECT slug, status, import_enabled, tag_policy FROM ingest.genre_external_sources");
  const allowed = new Map<string, TagPolicy>();
  for (const row of rows) {
    if (row.status !== "authorized" || !row.import_enabled) continue;
    const db = parseTagPolicy(row.tag_policy);
    const file = sheets.get(row.slug)?.tagPolicy;
    allowed.set(row.slug, file ? {
      ...db, acceptKinds: db.acceptKinds.filter((kind) => file.acceptKinds.includes(kind)),
      minTagCount: Math.max(db.minTagCount, file.minTagCount),
      maxValues: Math.min(db.maxValues, file.maxValues),
      ignore: [...new Set([...db.ignore, ...file.ignore])], buckets: { ...db.buckets, ...file.buckets },
    } : db);
  }
  return allowed;
}

function counts() { return { total: 0, evidence: 0, noEvidence: 0, genreClaim: 0, biography: 0, externalSuggestion: 0, layaReady: 0, evidenceWithoutOptions: 0 }; }

async function main(): Promise<void> {
  const client = await getPool().connect();
  try {
    const items = await allQueue(client);
    const flags = await flagsFor(client, items);
    const taxonomy = await loadTaxonomy(client);
    const policies = await externalPolicies(client);
    const byKind = { album: counts(), artist: counts() };
    const examples: Record<string, Array<{ caseId: string; title: string }>> = { noEvidence: [], evidenceWithoutOptions: [] };
    const noEvidenceIds = { album: [] as number[], artist: [] as number[] };
    const discovery = {
      album: { sourceLink: 0, matchedExternalIdentity: 0, radio: 0, withTracks: 0 },
      artist: { sourceLink: 0, matchedExternalIdentity: 0, radio: 0, withTracks: 0 },
    };
    const discoverySources: Record<Kind, Record<string, number>> = { album: {}, artist: {} };
    const inventory: Array<{
      caseId: string; kind: Kind; entityId: number; title: string; artistName: string | null;
      year: number | null; radio: boolean; trackCount: number;
      sourceLinks: Array<{ source: string; url: string; snapshot: string | null }>;
      matchedExternalIdentities: Array<{ source: string; externalId: string }>;
    }> = [];
    const inventoryById = new Map<string, typeof inventory[number]>();
    let inspected = 0;
    for (const item of items) {
      const summary = byKind[item.kind];
      const flag = flags.get(key(item.kind, item.entityId)) ?? empty();
      summary.total += 1;
      if (flag.genre) summary.genreClaim += 1;
      if (flag.biography) summary.biography += 1;
      if (flag.external) summary.externalSuggestion += 1;
      if (!flag.genre && !flag.biography && !flag.external) {
        summary.noEvidence += 1;
        noEvidenceIds[item.kind].push(item.entityId);
        const entry = { caseId: key(item.kind, item.entityId), kind: item.kind, entityId: item.entityId,
          title: item.title, artistName: item.artistName, year: item.year, radio: item.radio,
          trackCount: item.trackCount,
          sourceLinks: [] as Array<{ source: string; url: string; snapshot: string | null }>,
          matchedExternalIdentities: [] as Array<{ source: string; externalId: string }> };
        inventory.push(entry);
        inventoryById.set(entry.caseId, entry);
        if (item.radio) discovery[item.kind].radio += 1;
        if (item.trackCount > 0) discovery[item.kind].withTracks += 1;
        if (examples["noEvidence"]!.length < 10) examples["noEvidence"]!.push({ caseId: key(item.kind, item.entityId), title: item.title });
        continue;
      }
      summary.evidence += 1;
      const detail = await genreEntityDetail(client, item.kind, item.entityId);
      const built = detail && buildLayaPilotCase({
        kind: item.kind, entityId: item.entityId, title: item.title, categories: item.categories,
        sources: (detail["sources"] ?? []) as PilotSource[],
        assignments: (detail["assignments"] ?? []) as PilotAssignment[],
        externalIdentities: (detail["externalIdentities"] ?? []) as PilotExternalIdentity[],
        biographies: item.kind === "artist" ? await biographies(client, item.entityId) : [],
        externalPolicies: policies, taxonomy,
      });
      if (built) summary.layaReady += 1;
      else {
        summary.evidenceWithoutOptions += 1;
        if (examples["evidenceWithoutOptions"]!.length < 10) examples["evidenceWithoutOptions"]!.push({ caseId: key(item.kind, item.entityId), title: item.title });
      }
      inspected += 1;
      if (inspected % 100 === 0) console.error(`audit: ${inspected} fichas con evidencia revisadas`);
    }
    const { rows: links } = await client.query<{ kind: Kind; entity_id: string; source_slug: string; url: string; snapshot: string | null }>(`
      SELECT c.entity_kind::text AS kind, COALESCE(c.album_id,c.artist_id)::text AS entity_id,
             s.slug AS source_slug, c.raw_value #>> '{}' AS url, p.stored_path AS snapshot
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
        LEFT JOIN LATERAL (
          SELECT stored_path FROM ingest.raw_pages p
           WHERE p.source_id = c.source_id AND p.http_status = 200
             AND (p.url = c.raw_value #>> '{}' OR p.canonical_url = c.raw_value #>> '{}')
           ORDER BY p.fetched_at DESC LIMIT 1
        ) p ON true
       WHERE ((c.entity_kind = 'album' AND c.album_id = ANY($1::bigint[]))
           OR (c.entity_kind = 'artist' AND c.artist_id = ANY($2::bigint[])))
         AND c.field IN ('source_url','web_url') AND c.status::text = 'accepted'
         AND btrim(COALESCE(c.raw_value #>> '{}','')) <> ''
       GROUP BY 1,2,3,4,5`, [noEvidenceIds.album, noEvidenceIds.artist]);
    const linked = new Set<string>();
    for (const row of links) {
      const id = key(row.kind, Number(row.entity_id));
      if (!linked.has(id)) { discovery[row.kind].sourceLink += 1; linked.add(id); }
      discoverySources[row.kind][row.source_slug] = (discoverySources[row.kind][row.source_slug] ?? 0) + 1;
      const entry = inventoryById.get(id);
      if (entry && !entry.sourceLinks.some((link) => link.source === row.source_slug && link.url === row.url)) {
        entry.sourceLinks.push({ source: row.source_slug, url: row.url, snapshot: row.snapshot });
      }
    }
    const { rows: matches } = await client.query<{ kind: Kind; entity_id: string; source_slug: string; external_id: string }>(`
      SELECT i.entity_kind::text AS kind, i.entity_id::text, s.slug AS source_slug, i.external_id
        FROM ingest.genre_external_identities i JOIN ingest.genre_external_sources s ON s.id = i.source_id
       WHERE i.status = 'matched' AND ((i.entity_kind = 'album' AND i.entity_id = ANY($1::bigint[]))
                                   OR (i.entity_kind = 'artist' AND i.entity_id = ANY($2::bigint[])))
       GROUP BY 1,2,3,4`, [noEvidenceIds.album, noEvidenceIds.artist]);
    const matched = new Set<string>();
    for (const row of matches) {
      const id = key(row.kind, Number(row.entity_id));
      if (!matched.has(id)) { discovery[row.kind].matchedExternalIdentity += 1; matched.add(id); }
      inventoryById.get(id)?.matchedExternalIdentities.push({ source: row.source_slug, externalId: row.external_id });
    }
    const total = Object.fromEntries(Object.keys(byKind.album).map((field) => [field,
      byKind.album[field as keyof typeof byKind.album] + byKind.artist[field as keyof typeof byKind.artist]]));
    const report = { generatedAt: new Date().toISOString(), definition: {
      evidence: "claim de género vigente del mismo nivel, biografía aceptada del artista o sugerencia externa de género",
      layaReady: "el exportador actual puede producir al menos una opción activa respaldada por evidencia y la política de fuente",
    }, total, byKind, discovery, discoverySources, examples };
    const base = path.resolve("reports/genre-laya-evidence-coverage-2026-09-26");
    await mkdir(path.dirname(base), { recursive: true });
    await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(`${base}-inventory.jsonl`, `${inventory.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const lines = ["# Evidencia para Laya en la cola de géneros", "", `Medido: ${report.generatedAt}`, "",
      "| Nivel | Pendientes | Con evidencia textual | Sin evidencia | Listos para Laya | Evidencia sin opción válida |",
      "|---|---:|---:|---:|---:|---:|",
      ...(["album", "artist"] as const).map((kind) => {
        const row = byKind[kind];
        return `| ${kind === "album" ? "Álbumes" : "Artistas"} | ${row.total} | ${row.evidence} | ${row.noEvidence} | ${row.layaReady} | ${row.evidenceWithoutOptions} |`;
      }),
      `| **Total** | **${total["total"]}** | **${total["evidence"]}** | **${total["noEvidence"]}** | **${total["layaReady"]}** | **${total["evidenceWithoutOptions"]}** |`,
      "", "Los tipos de evidencia se solapan. Se cuentan claims de género aceptados o en conflicto, biografías aceptadas y sugerencias externas. Estas últimas solo pasan a 'listos' si cumplen la política vigente.", "",
      `Claims de género: ${total["genreClaim"]}; biografías de artista: ${total["biography"]}; sugerencias externas: ${total["externalSuggestion"]}.`, "",
      "## Pistas para buscar evidencia en los casos vacíos", "",
      "| Nivel | Sin evidencia | Con enlace de fuente aceptado | Con identidad externa enlazada | En Radio CRV | Con pistas |",
      "|---|---:|---:|---:|---:|---:|",
      ...(["album", "artist"] as const).map((kind) => {
        const row = discovery[kind];
        return `| ${kind === "album" ? "Álbumes" : "Artistas"} | ${byKind[kind].noEvidence} | ${row.sourceLink} | ${row.matchedExternalIdentity} | ${row.radio} | ${row.withTracks} |`;
      }), "", "Un enlace de fuente o una identidad externa solo orienta la búsqueda: no prueba un género por sí mismo.", "",
      "Fuentes con más enlaces de fichas todavía sin evidencia de género:", "",
      ...(["album", "artist"] as const).map((kind) => {
        const top = Object.entries(discoverySources[kind]).sort((a, b) => b[1] - a[1]).slice(0, 8);
        return `- ${kind === "album" ? "Álbumes" : "Artistas"}: ${top.map(([slug, n]) => `${slug} (${n})`).join(", ") || "ninguna"}.`;
      }), "",
      "El inventario por ficha está en `reports/genre-laya-evidence-coverage-2026-09-26-inventory.jsonl`.", "",
      "No se escribió ninguna asignación de género en la base.", ""];
    await writeFile(`${base}.md`, lines.join("\n"));
    console.log(JSON.stringify(report.total));
    console.log(`${base}.md`);
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
