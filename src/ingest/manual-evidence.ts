// Entrada humana para fuentes limitadas. Este módulo no importa fetcher,
// cache, Cheerio ni el motor de claims: conserva el hallazgo como trabajo
// pendiente hasta que una persona lo interprete y apruebe.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { manualEvidenceInputSchema, type ManualEvidenceInput } from "../adapters/contracts.js";
import { adapterRegistrationFor } from "../adapters/registry.js";
import { reviewQueue, scrapeRuns, sources } from "../db/schema/ingest.js";

export interface ManualEvidenceResult {
  sourceId: number;
  runId: number;
  reviewId: number;
  evidenceHash: string;
}

export async function registerManualEvidence(
  sourceSlug: string,
  inputValue: ManualEvidenceInput,
): Promise<ManualEvidenceResult> {
  const input = manualEvidenceInputSchema.parse(inputValue);
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, sourceSlug));
  if (!source) throw new Error(`fuente desconocida: ${sourceSlug}`);
  if (!source.url) throw new Error(`fuente sin URL raíz autorizada: ${sourceSlug}`);

  const registration = adapterRegistrationFor(source);
  if (!registration || registration.status !== "limited" || registration.mode !== "manual") {
    throw new Error(`la fuente ${sourceSlug} no admite entrada de evidencia manual`);
  }
  if (!registration.isAllowedEvidenceUrl(input.evidenceUrl, source.url)) {
    throw new Error(`URL de evidencia fuera del alcance autorizado para ${sourceSlug}`);
  }

  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({ sourceSlug, evidenceUrl: input.evidenceUrl, excerpt: input.excerpt }))
    .digest("hex");
  const now = new Date();

  // Idempotencia: el hash identifica (fuente, URL, extracto). Registrar dos
  // veces la misma captura devuelve el ítem existente en vez de duplicar la
  // cola de revisión con trabajo que ya está pendiente.
  const [existing] = await db.select({ id: reviewQueue.id, runId: sql<number>`(${reviewQueue.payload}->>'runId')::bigint` })
    .from(reviewQueue)
    .where(and(
      eq(reviewQueue.kind, "manual_review"),
      sql`${reviewQueue.payload}->>'evidenceHash' = ${evidenceHash}`,
    ))
    .limit(1);
  if (existing) {
    return { sourceId: source.id, runId: Number(existing.runId), reviewId: existing.id, evidenceHash };
  }

  return db.transaction(async (tx) => {
    const [run] = await tx.insert(scrapeRuns).values({
      kind: "manual",
      sourceId: source.id,
      status: "ok",
      startedAt: now,
      finishedAt: now,
      params: { action: "register_manual_evidence", sourceSlug, networkAccess: false },
      counters: { evidence: 1, reviews: 1 },
    }).returning({ id: scrapeRuns.id });
    if (!run) throw new Error("no se pudo registrar el run manual");

    const [review] = await tx.insert(reviewQueue).values({
      kind: "manual_review",
      priority: 5,
      payload: {
        type: "manual_source_evidence",
        sourceId: source.id,
        runId: run.id,
        sourceSlug,
        sourceRootUrl: source.url,
        evidenceUrl: input.evidenceUrl,
        excerpt: input.excerpt,
        evidenceHash,
        adapterStatus: registration.status,
        accessMode: registration.mode,
        automation: registration.automation,
        capturedBy: "human",
      },
      notes: input.notes ?? `Evidencia aportada manualmente para ${source.name}; pendiente de interpretación.`,
    }).returning({ id: reviewQueue.id });
    if (!review) throw new Error("no se pudo abrir la revisión manual");

    return { sourceId: source.id, runId: run.id, reviewId: review.id, evidenceHash };
  });
}
