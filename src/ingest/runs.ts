import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { scrapeRuns } from "../db/schema/ingest.js";

export async function listRuns(limit = 50) {
  return getDb().select().from(scrapeRuns).orderBy(desc(scrapeRuns.startedAt)).limit(limit);
}

export async function createArtistEnrichmentRun(artist: string) {
  const [run] = await getDb().insert(scrapeRuns).values({
    kind: "enrich_artist", status: "running", params: { artist },
  }).returning();
  if (!run) throw new Error("no se pudo crear run de enriquecimiento");
  return run;
}

export async function finishRun(id: number, status: "ok" | "partial" | "failed", counters: object, errorLog?: string) {
  await getDb().update(scrapeRuns).set({ status, finishedAt: new Date(), counters, ...(errorLog === undefined ? {} : { errorLog }) }).where(eq(scrapeRuns.id, id));
}
