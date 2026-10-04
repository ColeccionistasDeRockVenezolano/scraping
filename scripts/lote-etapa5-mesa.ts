// CRV · Etapa 5 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md):
// los 3 pares de personas que el bloque `titulares` mandó a la mesa (run 13224)
// se funden por decisión de Brian (2026-10-04): mismo nombre exacto y la ficha
// doble solo canta temas de su repertorio en recopilatorios venezolanos (VA),
// que la regla de proyecto común excluye. Queda la titular de la ficha de
// artista; la otra pasa a alias. Un run reversible (`crv runs undo <run>`) que
// también cierra la revisión `person_duplicate` de cada par.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa5-mesa.ts [--confirm]
import { closeDb } from "../src/db/client.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";

const CONFIRM = process.argv.includes("--confirm");
const OPERATOR = "claude-code (delegado por Brian)";
const NOTE = "Nuevo lote 2026-10-02, etapa 5: Brian decide fundir los pares de la mesa (run 13224); la ficha doble solo aparece en recopilatorios VA";
const PAIRS = [
  { review: 1833500, keep: { id: 24366, name: "Felipe Pirela" }, drop: { id: 12032, name: "Felipe Pirela" } },
  { review: 1833501, keep: { id: 29343, name: "Mirla Castellanos" }, drop: { id: 12006, name: "Mirla Castellanos" } },
  { review: 1833502, keep: { id: 29792, name: "Pecos Kanvas" }, drop: { id: 12090, name: "Pecos Kanvas" } },
];

class DryRun extends Error {}

async function main(): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  let runId = 0;
  try {
    await withOperatorRun({ name: "lote-2026-10-02:etapa5:mesa", operator: OPERATOR, note: NOTE, params: { confirm: CONFIRM } }, async (context) => {
      runId = context.runId;
      for (const pair of PAIRS) {
        const names = await context.client.query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons WHERE id = ANY($1::bigint[])", [[pair.keep.id, pair.drop.id]]);
        for (const ref of [pair.keep, pair.drop]) {
          const found = names.rows.find((row) => Number(row.id) === ref.id);
          if (found?.name !== ref.name) throw new Error(`persona ${ref.id}: se esperaba «${ref.name}», hay «${found?.name ?? "nada"}»`);
        }
        const review = await context.client.query("SELECT 1 FROM ingest.review_queue WHERE id=$1 AND status IN ('open','in_progress') AND kind='person_duplicate'", [pair.review]);
        if (!review.rowCount) throw new Error(`revisión ${pair.review} no está abierta`);
        const preview = await previewEntityMerge(context.client, "person", pair.keep.id, pair.drop.id, { lock: true });
        const merged = await mergeEntities(context, { kind: "person", keepId: pair.keep.id, dropId: pair.drop.id, previewHash: preview.previewHash, keepDropNameAsAlias: true });
        await context.client.query(`
          UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
           WHERE id=$1`, [pair.review, `${OPERATOR}: misma persona, fusionadas ${pair.drop.id} → ${pair.keep.id} en el run ${context.runId}`]);
        const row = { keep: pair.keep.id, drop: pair.drop.id, name: pair.keep.name, review: pair.review, moved: merged.moved, conflicts: preview.fieldConflicts.map((item) => item.field), warnings: preview.warnings };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
      if (!CONFIRM) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  console.log(`${CONFIRM ? "confirm" : "dry-run (todo se deshizo)"} · run ${runId} · ${rows.length} fusiones`);
}

main().finally(() => closeDb());
