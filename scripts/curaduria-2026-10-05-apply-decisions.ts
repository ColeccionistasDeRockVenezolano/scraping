// CRV · Curaduría 2026-10-05: aplica decisiones sobre conflictos de campo.
//
// Entrada: JSON [{ reviewId, choice?: "canonical"|"proposed", value?, note }].
// Cada decisión pasa por `resolveReviewConflict` (su propio run del diario,
// reversible con `crv runs undo`).
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-apply-decisions.ts <decisiones.json> [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { resolveReviewConflict } from "../src/review/operator-review.js";

const OPERATOR = "claude-code";
interface Decision { reviewId: number; choice?: "canonical" | "proposed"; value?: string | number | null; note: string }

async function main(): Promise<void> {
  const file = process.argv[2]!;
  const confirm = process.argv.includes("--confirm");
  const decisions = JSON.parse(readFileSync(file, "utf8")) as Decision[];
  const results: Array<Record<string, unknown>> = [];
  let ok = 0; let failed = 0;
  for (const decision of decisions) {
    if (!confirm) { results.push({ ...decision, dryRun: true }); continue; }
    try {
      const input = decision.value !== undefined
        ? { operator: OPERATOR, note: decision.note, value: decision.value }
        : { operator: OPERATOR, note: decision.note, choice: decision.choice! };
      const result = await resolveReviewConflict(decision.reviewId, input);
      results.push({ reviewId: decision.reviewId, runId: result.runId, detail: result.detail });
      ok += 1;
    } catch (error) {
      results.push({ reviewId: decision.reviewId, error: error instanceof Error ? error.message : String(error) });
      failed += 1;
    }
  }
  writeFileSync(file.replace(/\.json$/u, confirm ? "-applied.json" : "-dry.json"), JSON.stringify(results, null, 1));
  console.log(`${decisions.length} decisiones · aplicadas ${ok} · fallidas ${failed}`);
  await closeDb();
}
void main();
