// CRV · Decisiones de conflictos desde Curaduría (PLAN_CURADURIA E7).
//
// A/B reutiliza resolveFieldConflict; «otro valor» reutiliza settleEntityField.
// Toda escritura queda dentro de withOperatorRun y conserva claims/evidencia.
import { createHash } from "node:crypto";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";
import { resolveFieldConflict } from "../merge/engine.js";
import { settleEntityField, withOperatorRun } from "../merge/operator.js";
import { resolvableSpec, type ResolvableClaimKind } from "../merge/specs.js";
import {
  CurationError, listGroupFindings, type FindingGroupFilter, type FindingRow,
} from "./repository.js";
import { notifyCatalogWrite } from "./watcher.js";

export type SourceTrustLevel = "api" | "high" | "medium" | "low";
export type ConflictSide = "a" | "b";

const TRUST_RANK: Readonly<Record<SourceTrustLevel, number>> = {
  api: 4, high: 3, medium: 2, low: 1,
};

export interface ConflictClaimEvidence {
  id: number;
  side: ConflictSide;
  value: unknown;
  confidence: string;
  status: string;
  sourceName: string;
  sourceTrustLevel: SourceTrustLevel;
  sourceUrl: string | null;
  evidenceUrl: string | null;
  claimCreatedAt: string;
}

export interface ConflictDecisionDetail {
  id: number;
  status: string;
  entityKind: string;
  targetId: number | null;
  field: string;
  valueA: unknown;
  valueB: unknown;
  claimA: ConflictClaimEvidence;
  claimB: ConflictClaimEvidence;
}

type RawConflict = {
  id: string; status: string; entity_kind: string; field: string; value_a: unknown; value_b: unknown;
  claim_a_id: string; claim_b_id: string; target_id: string | null;
  a_confidence: string; a_status: string; a_source_name: string; a_trust: SourceTrustLevel;
  a_source_url: string | null; a_evidence_url: string | null; a_created_at: Date;
  b_confidence: string; b_status: string; b_source_name: string; b_trust: SourceTrustLevel;
  b_source_url: string | null; b_evidence_url: string | null; b_created_at: Date;
};

const CONFLICT_SELECT = `
  SELECT cf.id::text,cf.status::text,cf.entity_kind::text,cf.field,cf.value_a,cf.value_b,
         cf.claim_a_id::text,cf.claim_b_id::text,
         COALESCE(a.artist_id,a.person_id,a.organization_id,a.album_id,a.track_id)::text AS target_id,
         a.confidence::text AS a_confidence,a.status::text AS a_status,
         sa.name AS a_source_name,sa.trust_level::text AS a_trust,sa.url AS a_source_url,
         COALESCE(aev.url,arp.canonical_url,arp.url,sa.url) AS a_evidence_url,a.created_at AS a_created_at,
         b.confidence::text AS b_confidence,b.status::text AS b_status,
         sb.name AS b_source_name,sb.trust_level::text AS b_trust,sb.url AS b_source_url,
         COALESCE(bev.url,brp.canonical_url,brp.url,sb.url) AS b_evidence_url,b.created_at AS b_created_at
    FROM ingest.conflicts cf
    JOIN ingest.claims a ON a.id=cf.claim_a_id
    JOIN ingest.sources sa ON sa.id=a.source_id
    LEFT JOIN ingest.raw_pages arp ON arp.id=a.raw_page_id
    LEFT JOIN LATERAL (
      SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=a.id ORDER BY e.id LIMIT 1
    ) aev ON true
    JOIN ingest.claims b ON b.id=cf.claim_b_id
    JOIN ingest.sources sb ON sb.id=b.source_id
    LEFT JOIN ingest.raw_pages brp ON brp.id=b.raw_page_id
    LEFT JOIN LATERAL (
      SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=b.id ORDER BY e.id LIMIT 1
    ) bev ON true
`;

function claim(row: RawConflict, side: ConflictSide): ConflictClaimEvidence {
  if (side === "a") {
    return {
      id: Number(row.claim_a_id), side, value: row.value_a, confidence: row.a_confidence, status: row.a_status,
      sourceName: row.a_source_name, sourceTrustLevel: row.a_trust, sourceUrl: row.a_source_url,
      evidenceUrl: row.a_evidence_url, claimCreatedAt: new Date(row.a_created_at).toISOString(),
    };
  }
  return {
    id: Number(row.claim_b_id), side, value: row.value_b, confidence: row.b_confidence, status: row.b_status,
    sourceName: row.b_source_name, sourceTrustLevel: row.b_trust, sourceUrl: row.b_source_url,
    evidenceUrl: row.b_evidence_url, claimCreatedAt: new Date(row.b_created_at).toISOString(),
  };
}

function toDetail(row: RawConflict): ConflictDecisionDetail {
  return {
    id: Number(row.id), status: row.status, entityKind: row.entity_kind,
    targetId: row.target_id === null ? null : Number(row.target_id), field: row.field,
    valueA: row.value_a, valueB: row.value_b, claimA: claim(row, "a"), claimB: claim(row, "b"),
  };
}

async function loadConflictDetails(ids: readonly number[]): Promise<Map<number, ConflictDecisionDetail>> {
  if (!ids.length) return new Map();
  const { rows } = await getPool().query<RawConflict>(
    `${CONFLICT_SELECT} WHERE cf.id=ANY($1::bigint[]) ORDER BY cf.id`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((row) => [Number(row.id), toDetail(row)]));
}

export async function getConflictDecision(id: number): Promise<ConflictDecisionDetail> {
  const found = (await loadConflictDetails([id])).get(id);
  if (!found) throw new CurationError("not_found", `conflicto inexistente: ${id}`);
  return found;
}

function assertResolvable(detail: ConflictDecisionDetail): asserts detail is ConflictDecisionDetail & {
  entityKind: ResolvableClaimKind; targetId: number;
} {
  if (!resolvableSpec(detail.entityKind as ResolvableClaimKind) || detail.targetId === null) {
    throw new CurationError("not_fixable", `el conflicto ${detail.id} (${detail.entityKind}.${detail.field}) requiere revisión manual`);
  }
}

async function resolveOne(
  id: number,
  decision: { side: ConflictSide } | { value: string | number | boolean | null },
  operator: string,
  note: string,
  notify: boolean,
): Promise<{ conflictId: number; runId: number; action: "a" | "b" | "custom" }> {
  const cleanNote = note.trim();
  if (!cleanNote) throw new CurationError("invalid", "nota obligatoria");
  const before = await getConflictDecision(id);
  if (before.status !== "open") throw new CurationError("not_open", `el conflicto ${id} ya no está abierto`);
  assertResolvable(before);

  try {
    const action = "side" in decision ? decision.side : "custom";
    const { runId } = await withOperatorRun({
      name: "api:curation:resolve-conflict", operator, note: cleanNote,
      params: { conflictId: id, decision: action },
    }, async (context) => {
      if ("side" in decision) {
        await resolveFieldConflict(id, decision.side === "a" ? "resolved_a" : "resolved_b", {
          actor: "human", note: context.note, runId: context.runId, client: context.client,
        });
        return;
      }
      await settleEntityField(context, before.entityKind, before.targetId, before.field, decision.value);
    });
    if (notify) notifyCatalogWrite(operator || null, "POST /curation/conflicts/:id/resolve");
    return { conflictId: id, runId, action };
  } catch (error) {
    if (error instanceof CurationError) throw error;
    throw new CurationError("stale", error instanceof Error ? error.message : "el conflicto cambió mientras se resolvía");
  }
}

export async function resolveConflictDecision(
  id: number,
  decision: { side: ConflictSide } | { value: string | number | boolean | null },
  operator: string,
  note: string,
): Promise<{ conflictId: number; runId: number; action: "a" | "b" | "custom" }> {
  return resolveOne(id, decision, operator, note, true);
}

function conflictIdOf(finding: FindingRow): number | null {
  if (finding.entity.kind === "conflict" && finding.entity.id !== null) return finding.entity.id;
  const value = finding.evidence["conflictId"];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface TrustedConflictPreviewItem {
  findingId: number;
  conflictId: number | null;
  title: string;
  eligible: boolean;
  chosen: ConflictSide | null;
  reason: string;
  claimA: ConflictClaimEvidence | null;
  claimB: ConflictClaimEvidence | null;
}

export interface TrustedConflictPreview {
  previewHash: string;
  filter: FindingGroupFilter;
  total: number;
  truncated: boolean;
  eligible: number;
  ties: number;
  unavailable: number;
  items: TrustedConflictPreviewItem[];
}

function previewHash(filter: FindingGroupFilter, total: number, items: readonly TrustedConflictPreviewItem[]): string {
  return createHash("sha256").update(JSON.stringify([
    filter, total,
    items.map((item) => [
      item.findingId, item.conflictId, item.eligible, item.chosen,
      item.claimA && [item.claimA.id, item.claimA.value, item.claimA.sourceTrustLevel, item.claimA.claimCreatedAt],
      item.claimB && [item.claimB.id, item.claimB.value, item.claimB.sourceTrustLevel, item.claimB.claimCreatedAt],
    ]),
  ])).digest("hex");
}

export async function previewTrustedConflicts(filter: FindingGroupFilter): Promise<TrustedConflictPreview> {
  const limit = getEnv().CRV_CURATION_FIX_PREVIEW_MAX;
  const { rows: findings, total } = await listGroupFindings(filter, limit);
  const details = await loadConflictDetails(
    findings.map(conflictIdOf).filter((id): id is number => id !== null),
  );
  const items = findings.map((finding): TrustedConflictPreviewItem => {
    const conflictId = conflictIdOf(finding);
    const conflict = conflictId === null ? undefined : details.get(conflictId);
    if (!conflict || conflict.status !== "open") {
      return {
        findingId: finding.id, conflictId, title: finding.title, eligible: false, chosen: null,
        reason: "El conflicto ya no está abierto o no está disponible.", claimA: conflict?.claimA ?? null, claimB: conflict?.claimB ?? null,
      };
    }
    const rankA = TRUST_RANK[conflict.claimA.sourceTrustLevel];
    const rankB = TRUST_RANK[conflict.claimB.sourceTrustLevel];
    if (rankA === rankB) {
      return {
        findingId: finding.id, conflictId, title: finding.title, eligible: false, chosen: null,
        reason: `Empate de confianza (${conflict.claimA.sourceTrustLevel}); requiere decisión individual.`,
        claimA: conflict.claimA, claimB: conflict.claimB,
      };
    }
    const chosen: ConflictSide = rankA > rankB ? "a" : "b";
    return {
      findingId: finding.id, conflictId, title: finding.title, eligible: true, chosen,
      reason: `Se propone ${chosen.toUpperCase()}: la fuente tiene mayor trust_level.`,
      claimA: conflict.claimA, claimB: conflict.claimB,
    };
  });
  return {
    previewHash: previewHash(filter, total, items), filter, total, truncated: total > findings.length,
    eligible: items.filter((item) => item.eligible).length,
    ties: items.filter((item) => item.reason.startsWith("Empate")).length,
    unavailable: items.filter((item) => !item.eligible && !item.reason.startsWith("Empate")).length,
    items,
  };
}

export async function applyTrustedConflicts(
  filter: FindingGroupFilter,
  input: { previewHash: string; excludeConflictIds?: readonly number[] | undefined; note: string },
  operator: string,
): Promise<{
  previewHash: string; applied: number; skippedStale: number; failed: number; remaining: number;
  outcomes: Array<{ findingId: number; conflictId: number | null; status: "applied" | "skipped_stale" | "failed"; error: string | null }>;
}> {
  if (!input.note.trim()) throw new CurationError("invalid", "nota obligatoria");
  const preview = await previewTrustedConflicts(filter);
  if (preview.previewHash !== input.previewHash) {
    throw new CurationError("stale_preview", "los conflictos cambiaron desde la vista previa; vuelve a previsualizar");
  }

  const excluded = new Set(input.excludeConflictIds ?? []);
  const candidates = preview.items.filter((item) => item.eligible && item.conflictId !== null && !excluded.has(item.conflictId));
  const batch = candidates.slice(0, getEnv().CRV_CURATION_FIX_BATCH_MAX);
  const outcomes: Array<{ findingId: number; conflictId: number | null; status: "applied" | "skipped_stale" | "failed"; error: string | null }> = [];

  for (const item of batch) {
    try {
      const current = await getConflictDecision(item.conflictId!);
      const rankA = TRUST_RANK[current.claimA.sourceTrustLevel];
      const rankB = TRUST_RANK[current.claimB.sourceTrustLevel];
      const chosen: ConflictSide | null = rankA === rankB ? null : rankA > rankB ? "a" : "b";
      if (current.status !== "open" || chosen !== item.chosen) {
        outcomes.push({ findingId: item.findingId, conflictId: item.conflictId, status: "skipped_stale", error: "cambió el conflicto o la confianza de sus fuentes" });
        continue;
      }
      await resolveOne(item.conflictId!, { side: item.chosen! }, operator, `${input.note.trim()} · fuente de mayor trust_level`, false);
      outcomes.push({ findingId: item.findingId, conflictId: item.conflictId, status: "applied", error: null });
    } catch (error) {
      const stale = error instanceof CurationError && ["stale", "not_open", "not_found"].includes(error.code);
      outcomes.push({
        findingId: item.findingId, conflictId: item.conflictId, status: stale ? "skipped_stale" : "failed",
        error: error instanceof Error ? error.message : "falló la resolución",
      });
    }
  }
  if (outcomes.some((item) => item.status === "applied")) notifyCatalogWrite(operator || null, "POST /curation/conflicts/trust-apply");
  return {
    previewHash: preview.previewHash,
    applied: outcomes.filter((item) => item.status === "applied").length,
    skippedStale: outcomes.filter((item) => item.status === "skipped_stale").length,
    failed: outcomes.filter((item) => item.status === "failed").length,
    remaining: Math.max(0, candidates.length - batch.length) + (preview.truncated ? Math.max(0, preview.total - preview.items.length) : 0),
    outcomes,
  };
}
