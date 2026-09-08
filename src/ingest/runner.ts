// Orquestación de parser → normalización → claims → merge. Un run es la
// unidad trazable; dry-run construye exactamente el mismo plan sin INSERT,
// UPDATE ni acceso de red.
import { getDb } from "../db/client.js";
import { scrapeRuns, sources } from "../db/schema/ingest.js";
import { asc, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "../config/env.js";
import type { RawRecord } from "../adapters/contracts.js";
import { rawRecordSchema, type SourceAdapter, type StoredPage } from "../adapters/contracts.js";
import { load } from "cheerio";
import { normalizeRecord, type NormalizedClaim } from "../normalization/claims.js";
import { persistClaim, type Actor, type ClaimToPersist, type Confidence } from "../claims/persistence.js";
import { mergeClaim, resolveArtistId, type MergeOutcome } from "../merge/engine.js";

export interface IngestionOptions { dryRun?: boolean; confidence: Confidence; createdBy?: Actor; }
export interface IngestionRecord { record: RawRecord; rawPageId?: number; }
export interface IngestionPlan { field: string; entityKind: string; action: string; detail: string; }
export interface IngestionResult { runId?: number; claimsInserted: number; claimsReused: number; merges: MergeOutcome[]; plan: IngestionPlan[]; }

function result(): IngestionResult { return { claimsInserted: 0, claimsReused: 0, merges: [], plan: [] }; }

async function sourceFor(slug: string) {
  const [source] = await getDb().select().from(sources).where(eq(sources.slug, slug));
  if (!source) throw new Error(`fuente desconocida: ${slug}`);
  return source;
}

function planClaim(claim: NormalizedClaim, confidence: Confidence): IngestionPlan {
  if (confidence === "low") return { field: claim.field, entityKind: claim.entityKind, action: "candidate", detail: "low: abriría revisión" };
  if (claim.entityKind === "artist") return { field: claim.field, entityKind: claim.entityKind, action: "merge", detail: "evaluaría merge determinista de artist" };
  return { field: claim.field, entityKind: claim.entityKind, action: "candidate", detail: "tipo aún no conectado al merge base" };
}

/** Punto reutilizable por fixtures y futuros adapters. */
export async function ingestRecords(sourceSlug: string, records: Array<RawRecord | IngestionRecord>, options: IngestionOptions): Promise<IngestionResult> {
  const source = await sourceFor(sourceSlug);
  const output = result();
  if (options.dryRun) {
    for (const item of records) {
      const record = "record" in item ? item.record : item;
      for (const claim of normalizeRecord(record)) output.plan.push(planClaim(claim, options.confidence));
    }
    return output;
  }
  const [run] = await getDb().insert(scrapeRuns).values({
    kind: "scrape_source", sourceId: source.id, status: "running", params: { mode: "ingest", sourceSlug },
  }).returning();
  if (!run) throw new Error("no se pudo crear run de ingestión");
  output.runId = run.id;
  try {
    for (const item of records) {
      const record = "record" in item ? item.record : item;
      const rawPageId = "record" in item ? item.rawPageId : undefined;
      const normalized = normalizeRecord(record);
      let artistId = record.entityKind === "artist" ? await resolveArtistId(normalized[0]?.identity ?? "") : undefined;
      for (const claim of normalized) {
        const input: ClaimToPersist = {
          ...claim, sourceId: source.id, runId: run.id, confidence: options.confidence,
          ...(rawPageId === undefined ? {} : { rawPageId }),
          ...(artistId === undefined ? {} : { artistId }),
          ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
        };
        const persisted = await persistClaim(input);
        if (persisted.inserted) output.claimsInserted += 1; else output.claimsReused += 1;
        const merge = await mergeClaim(input, persisted);
        output.merges.push(merge);
        output.plan.push({ field: claim.field, entityKind: claim.entityKind, action: merge.action, detail: merge.detail });
        if (claim.entityKind === "artist" && merge.artistId) artistId = merge.artistId;
      }
    }
    await getDb().update(scrapeRuns).set({ status: "ok", finishedAt: new Date(), counters: { ...output, merges: output.merges.length } }).where(eq(scrapeRuns.id, run.id));
    return output;
  } catch (error) {
    await getDb().update(scrapeRuns).set({ status: "failed", finishedAt: new Date(), errorLog: String(error) }).where(eq(scrapeRuns.id, run.id));
    throw error;
  }
}

/** Ejecuta un parser exclusivamente sobre snapshots ya almacenados. */
export async function ingestAdapterSnapshots(
  sourceSlug: string,
  adapter: SourceAdapter,
  pages: StoredPage[],
  options: IngestionOptions,
): Promise<IngestionResult> {
  const records: IngestionRecord[] = [];
  for (const page of pages) {
    // Cheerio sigue siendo el parser estándar; JSON/XML estructurado puede
    // optar por conservar su cuerpo original en extractSnapshot.
    const extracted = adapter.extractSnapshot?.(page) ?? adapter.extract(load(page.body), page.url);
    for (const record of extracted) records.push({ record: rawRecordSchema.parse(record), rawPageId: page.rawPageId });
  }
  return ingestRecords(sourceSlug, records, options);
}

function pageKind(contentType: string | null, url: string): StoredPage["kind"] {
  if (contentType?.includes("json") || /[?&]alt=json\b|\/wp\/v2\//.test(url)) return "json";
  if (contentType?.includes("xml")) return "xml";
  return "html";
}

/**
 * Relee snapshots locales para un parser nuevo sin red. Para Sincopa se
 * delega la decodificación windows-1252 al adapter; los bytes crudos nunca
 * se alteran en disco.
 */
export async function loadStoredAdapterPages(sourceSlug: string, adapter: SourceAdapter): Promise<StoredPage[]> {
  const [source] = await getDb().select().from(sources).where(eq(sources.slug, sourceSlug));
  if (!source) throw new Error(`fuente desconocida: ${sourceSlug}`);
  const { rawPages } = await import("../db/schema/ingest.js");
  const rows = await getDb().select().from(rawPages).where(eq(rawPages.sourceId, source.id)).orderBy(asc(rawPages.id));
  const dataDir = getEnv().DATA_DIR;
  return Promise.all(rows.filter((row) => (row.httpStatus ?? 200) < 400).map(async (row) => {
    const bytes = await readFile(path.join(dataDir, row.storedPath));
    return {
      url: row.canonicalUrl ?? row.url,
      kind: pageKind(row.contentType, row.url),
      rawPageId: row.id,
      body: adapter.decodeBody?.(bytes) ?? bytes.toString("utf8"),
    };
  }));
}

/** Ejecuta un adapter sobre todo el crudo local de su fuente, sin volver a pedir web. */
export async function ingestStoredAdapterSource(
  sourceSlug: string,
  adapter: SourceAdapter,
  options: IngestionOptions,
): Promise<IngestionResult> {
  return ingestAdapterSnapshots(sourceSlug, adapter, await loadStoredAdapterPages(sourceSlug, adapter), options);
}
