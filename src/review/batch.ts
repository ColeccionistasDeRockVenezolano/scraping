// CRV · Aprobación por lotes (PHASES F5).
//
// El motor exige una decisión humana para que un candidato entre al core, y
// eso no cambia aquí: `approveBatch` NO relaja ninguna guarda, sigue llamando
// a `approveEntity`, que re-ejecuta el merge con createdBy="human". Lo único
// que cambia es la ergonomía: la persona expresa UNA decisión sobre un
// conjunto ("todo lo candidato de Sincopa") en vez de repetirla diez mil
// veces. Sin esto un barrido completo no llena el catálogo, llena la cola.
//
// Tres invariantes que el lote sí añade sobre el bucle ingenuo:
//
//  1. ORDEN DE DEPENDENCIA. `albums.artist_id` es NOT NULL y las relaciones
//     necesitan sus dos extremos, así que aprobar por orden de llegada deja
//     discos sin artista y puentes sin destino. BATCH_ORDER lo fija.
//  2. TRAZABILIDAD. El lote es una fila real en ingest.scrape_runs (kind
//     'merge_run'): su id va en la nota de resolución de cada revisión que
//     cierra, así que "qué aprobó este lote" es una consulta, no un recuerdo.
//  3. AISLAMIENTO DEL FALLO. Una entidad que falla no aborta el resto; se
//     acumula en `errors` y el lote termina 'partial'.
import { getDb } from "../db/client.js";
import { scrapeRuns, sources } from "../db/schema/ingest.js";
import { eq } from "drizzle-orm";
import { approveEntity, dismissEntity, pendingEntities, type PendingEntity } from "./approval.js";
import { finishRun } from "../ingest/runs.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("review:batch");

/**
 * Orden de dependencia del core. Un sello existe antes que el disco que lo
 * cita (albums.label_id), un artista antes que su disco (artist_id NOT NULL),
 * un disco antes que sus pistas, y los tres puentes al final porque necesitan
 * sus dos extremos ya resueltos.
 */
export const BATCH_ORDER = [
  "organization", "artist", "person", "album", "track",
  "artist_membership", "album_credit", "track_credit",
] as const;

export type BatchEntityKind = (typeof BATCH_ORDER)[number];

export interface BatchFilter {
  /** Un solo tipo; por defecto recorre BATCH_ORDER completo. */
  entityKind?: string;
  /** Selecciona qué entidades entran al lote, no qué claims se promueven. */
  sourceSlug?: string;
  /** Techo por tipo de entidad, no del lote entero. */
  limitPerKind?: number;
}

export interface BatchPlanItem {
  entityKind: BatchEntityKind;
  entities: number;
  claims: number;
  /** Primeras identidades, para que la persona vea qué está aprobando. */
  samples: string[];
}

export interface BatchPlan {
  filter: BatchFilter;
  items: BatchPlanItem[];
  totalEntities: number;
  totalClaims: number;
}

export interface BatchError {
  entityKind: string;
  identityKey: string;
  error: string;
}

export interface BatchResult {
  /** id del ingest.scrape_runs que ancla el lote. */
  runId: number;
  action: "approve" | "dismiss";
  note: string;
  filter: BatchFilter;
  entities: number;
  applied: number;
  unchanged: number;
  stillCandidate: number;
  unsupported: number;
  reviewsClosed: number;
  failed: number;
  errors: BatchError[];
}

function isBatchKind(kind: string): kind is BatchEntityKind {
  return (BATCH_ORDER as readonly string[]).includes(kind);
}

function kindsFor(filter: BatchFilter): BatchEntityKind[] {
  if (filter.entityKind === undefined) return [...BATCH_ORDER];
  if (!isBatchKind(filter.entityKind)) {
    throw new Error(`tipo no aprobable por lote: ${filter.entityKind} (admitidos: ${BATCH_ORDER.join(", ")})`);
  }
  return [filter.entityKind];
}

async function sourceIdFor(slug: string): Promise<number> {
  const [row] = await getDb().select({ id: sources.id }).from(sources).where(eq(sources.slug, slug));
  if (!row) throw new Error(`fuente desconocida: ${slug}`);
  return row.id;
}

async function candidatesByKind(filter: BatchFilter): Promise<Map<BatchEntityKind, PendingEntity[]>> {
  const byKind = new Map<BatchEntityKind, PendingEntity[]>();
  for (const kind of kindsFor(filter)) {
    const pending = await pendingEntities({
      entityKind: kind,
      ...(filter.sourceSlug === undefined ? {} : { sourceSlug: filter.sourceSlug }),
      limit: filter.limitPerKind ?? 5_000,
    });
    if (pending.length > 0) byKind.set(kind, pending);
  }
  return byKind;
}

/** Qué haría el lote, sin tocar nada. Es la pantalla que la persona aprueba. */
export async function planBatch(filter: BatchFilter = {}): Promise<BatchPlan> {
  if (filter.sourceSlug !== undefined) await sourceIdFor(filter.sourceSlug);
  const byKind = await candidatesByKind(filter);
  const items: BatchPlanItem[] = [];
  for (const kind of kindsFor(filter)) {
    const pending = byKind.get(kind);
    if (pending === undefined) continue;
    items.push({
      entityKind: kind,
      entities: pending.length,
      claims: pending.reduce((sum, item) => sum + item.claims, 0),
      samples: pending.slice(0, 5).map((item) => item.identityRaw),
    });
  }
  return {
    filter,
    items,
    totalEntities: items.reduce((sum, item) => sum + item.entities, 0),
    totalClaims: items.reduce((sum, item) => sum + item.claims, 0),
  };
}

/**
 * Aprueba (o descarta) todo lo candidato que encaje en el filtro, respetando
 * el orden de dependencia. Cada entidad pasa por `approveEntity`, así que el
 * camino al core es exactamente el mismo que en la aprobación individual.
 */
export async function runBatch(
  action: "approve" | "dismiss",
  filter: BatchFilter,
  note: string,
): Promise<BatchResult> {
  if (!note.trim()) throw new Error("nota de resolución obligatoria");
  const sourceId = filter.sourceSlug === undefined ? undefined : await sourceIdFor(filter.sourceSlug);
  const byKind = await candidatesByKind(filter);

  const [run] = await getDb().insert(scrapeRuns).values({
    kind: "merge_run",
    status: "running",
    ...(sourceId === undefined ? {} : { sourceId }),
    params: { action, filter, note, order: kindsFor(filter) },
  }).returning();
  if (!run) throw new Error("no se pudo abrir el run del lote");

  // La nota lleva el id del lote delante: recuperar lo que hizo este lote es
  // un LIKE sobre resolution_note, no arqueología sobre timestamps.
  const batchNote = `[lote ${run.id}] ${note.trim()}`;
  const result: BatchResult = {
    runId: run.id, action, note: batchNote, filter,
    entities: 0, applied: 0, unchanged: 0, stillCandidate: 0,
    unsupported: 0, reviewsClosed: 0, failed: 0, errors: [],
  };

  for (const kind of kindsFor(filter)) {
    for (const item of byKind.get(kind) ?? []) {
      try {
        const outcome = action === "approve"
          ? await approveEntity(kind, item.identityKey, batchNote)
          : await dismissEntity(kind, item.identityKey, batchNote);
        result.entities += 1;
        result.applied += outcome.applied;
        result.unchanged += outcome.unchanged;
        result.stillCandidate += outcome.stillCandidate;
        result.unsupported += outcome.unsupported;
        result.reviewsClosed += outcome.reviewsClosed;
      } catch (error) {
        // Un candidato roto no puede tumbar el lote: se anota y se sigue.
        result.failed += 1;
        if (result.errors.length < 50) {
          result.errors.push({ entityKind: kind, identityKey: item.identityKey, error: (error as Error).message });
        }
      }
    }
  }

  const status = result.failed === 0 ? "ok" : "partial";
  await finishRun(run.id, status, {
    entities: result.entities, applied: result.applied, unchanged: result.unchanged,
    stillCandidate: result.stillCandidate, unsupported: result.unsupported,
    reviewsClosed: result.reviewsClosed, failed: result.failed,
  }, result.errors.length === 0 ? undefined : JSON.stringify(result.errors));

  log.info({ ...result, errors: result.errors.length }, "lote de revisión cerrado");
  return result;
}

export const approveBatch = (filter: BatchFilter, note: string): Promise<BatchResult> => runBatch("approve", filter, note);
export const dismissBatch = (filter: BatchFilter, note: string): Promise<BatchResult> => runBatch("dismiss", filter, note);
