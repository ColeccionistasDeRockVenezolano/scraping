// CRV · Cierre de «Revisión de ingesta» de Curaduría (Brian, 2026-10-04).
//
// Tras promover lo que tenía destino (discos, pistas, personas y puentes de
// Sincopa), lo que queda abierto en las colas low_confidence y manual_review
// se cierra en UN run, por el estado de su claim:
//   · claim rechazado            → dismissed (ya decidido);
//   · claim aceptado/reemplazado → approved  (ya aplicado);
//   · claim en conflicto         → dismissed (lo lleva «Valores en disputa»);
//   · claim candidato            → dismissed «en espera»: sin destino seguro
//     (personas sin proyecto común, iniciales, discos de la lista manual). El
//     claim NO se toca: sigue candidato para la próxima pasada.
// Sin --confirm corre y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/close-ingest-review-2026-10-04.ts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Revisión de ingesta 2026-10-04 (Brian)";
const KINDS = ["low_confidence", "manual_review"];
class DryRun extends Error { constructor(readonly stats: Record<string, number>) { super("dry-run"); } }

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  let stats: Record<string, number>;
  let runId: number | null = null;
  try {
    const done = await withOperatorRun({ name: "close_ingest_review", operator: "brian", note: NOTE, params: { kinds: KINDS } }, async ({ client, runId: run }) => {
      await client.query("SET LOCAL statement_timeout = '30min'");
      const count: Record<string, number> = {};
      const close = async (label: string, status: "approved" | "dismissed", claimFilter: string, note: string): Promise<void> => {
        const result = await client.query(`
          UPDATE ingest.review_queue r
             SET status=$2::ingest.review_status, resolved_by='human', resolved_at=now(), updated_at=now(), resolution_note=$3
            FROM ingest.claims c
           WHERE c.id=r.claim_a_id AND r.status IN ('open','in_progress') AND r.kind::text = ANY($1::text[]) AND ${claimFilter}`,
        [KINDS, status, `[run ${run}] ${NOTE}: ${note}`]);
        count[label] = result.rowCount ?? 0;
      };
      await close("rechazado", "dismissed", "c.status='rejected'", "el claim ya está rechazado");
      await close("aplicado", "approved", "c.status IN ('accepted','superseded')", "el claim ya está aplicado o reemplazado");
      await close("conflicto", "dismissed", "c.status='conflict'", "el valor en disputa sigue en «Valores en disputa»");
      await close("en_espera", "dismissed", "c.status='candidate'",
        "en espera: sin destino seguro (persona sin proyecto común, iniciales, artista truncado o disco de la lista manual); el claim sigue candidato");
      const left = await client.query<{ kind: string; n: string }>(
        "SELECT kind::text, count(*)::text AS n FROM ingest.review_queue WHERE status IN ('open','in_progress') AND kind::text = ANY($1::text[]) GROUP BY 1", [KINDS]);
      for (const row of left.rows) count[`abiertas_${row.kind}`] = Number(row.n);
      if (!confirm) throw new DryRun(count);
      return count;
    });
    runId = done.runId;
    stats = done.result;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    stats = error.stats;
  }
  const line = `${confirm ? `confirm run ${runId}` : "dry-run"} · ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(" · ")}`;
  writeFileSync(`reports/revision-ingesta-2026-10-04/cierre-${confirm ? "confirm" : "dry-run"}.md`, `# Cierre de Revisión de ingesta\n\n${line}\n`);
  console.log(line);
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
