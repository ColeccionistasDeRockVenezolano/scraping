import { desc, eq, sql } from "drizzle-orm";
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
  // `finished_at` sale del reloj de la BASE, no de JS: `started_at` llega de
  // `now()` con microsegundos y un run que termina dentro del mismo
  // milisegundo quedaba con `finished_at < started_at` y tumbaba el CHECK
  // `scrape_runs_time_chk` (visto en CI: review-decisions, 2026-09-18). El
  // resto de los escritores del proyecto ya usa `now()`.
  await getDb().update(scrapeRuns).set({ status, finishedAt: sql`now()`, counters, ...(errorLog === undefined ? {} : { errorLog }) }).where(eq(scrapeRuns.id, id));
}
