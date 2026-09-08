import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { reviewQueue } from "../db/schema/ingest.js";

export async function listReviews() {
  return getDb().select().from(reviewQueue).where(eq(reviewQueue.status, "open")).orderBy(desc(reviewQueue.priority), desc(reviewQueue.createdAt));
}

export async function showReview(id: number) {
  const [review] = await getDb().select().from(reviewQueue).where(eq(reviewQueue.id, id));
  return review;
}

export async function resolveReview(id: number, resolution: "approved" | "dismissed", note: string): Promise<void> {
  if (!note.trim()) throw new Error("resolution note obligatoria");
  const current = await showReview(id);
  if (!current || (current.status !== "open" && current.status !== "in_progress")) throw new Error(`review abierta inexistente: ${id}`);
  if (resolution === "approved" && current.kind === "field_conflict") {
    throw new Error("un field_conflict se aprueba eligiendo A/B mediante resolveFieldConflict");
  }
  if (resolution === "approved" && current.kind === "ai_biography") {
    throw new Error("una ai_biography se aprueba mediante approveBiographyDraft para mantener trazabilidad");
  }
  const result = await getDb().update(reviewQueue).set({
    status: resolution,
    resolvedBy: "human",
    resolutionNote: note,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(reviewQueue.id, id), inArray(reviewQueue.status, ["open", "in_progress"]))).returning({ id: reviewQueue.id });
  if (!result.length) throw new Error(`review inexistente: ${id}`);
}

export async function approveReview(id: number, note: string): Promise<void> {
  await resolveReview(id, "approved", note);
}

export async function dismissReview(id: number, note: string): Promise<void> {
  await resolveReview(id, "dismissed", note);
}
