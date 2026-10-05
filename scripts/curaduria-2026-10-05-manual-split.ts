// CRV · Curaduría 2026-10-05: fichas de dos compositores que splitPerson no puede dividir (el nombre
// coincide con varias personas homónimas sin proyecto común). Cada compositor recibe su crédito:
// la persona existente cuando la obra es del mismo repertorio, o una ficha nueva si no hay vínculo.
//   «E. Hidalgo - J. Villarroel» (Presagio, Trío Acústico Venezolano): dos fichas nuevas.
//   «Ricardo Pérez - Rafael Izaza» / inversa (aguinaldos de El Cuarteto): 7360 y 7362, autores de los
//   aguinaldos del Orfeón Lamas.
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-manual-split.ts
import { closeDb } from "../src/db/client.js";
import { createEntity, createRelation, withOperatorRun } from "../src/merge/operator.js";
import { deleteEntity } from "../src/merge/operator.js";
import { removeRelation } from "../src/merge/removals.js";

const NOTE = "Curaduría 2026-10-05: dos compositores en una ficha; cada uno recibe su crédito";
const PLAN: Array<{ from: number; to: Array<number | string> }> = [
  { from: 33576, to: ["E. Hidalgo", "J. Villarroel"] },
  { from: 33719, to: [7360, 7362] },
  { from: 33720, to: [7362, 7360] },
];
const { runId } = await withOperatorRun({ name: "curation:manual-split-composers", operator: "claude-code", note: NOTE }, async (context) => {
  for (const item of PLAN) {
    const { rows: credits } = await context.client.query<{ id: string; track_id: string; credit_type: string; credit_role: string | null }>(
      "SELECT id::text, track_id::text, credit_type::text, role AS credit_role FROM public.track_credits WHERE person_id=$1", [item.from]);
    const ids: number[] = [];
    for (const target of item.to) {
      if (typeof target === "number") { ids.push(target); continue; }
      const created = await createEntity(context, "person", { name: target }, { allowSimilar: true });
      ids.push(created.id);
    }
    for (const credit of credits) {
      for (const personId of ids) {
        const exists = await context.client.query("SELECT 1 FROM public.track_credits WHERE track_id=$1 AND person_id=$2 AND credit_type=$3", [credit.track_id, personId, credit.credit_type]);
        if (!exists.rowCount) await createRelation(context, "track_credit", { trackId: Number(credit.track_id), personId }, { credit_type: credit.credit_type, credit_role: credit.credit_role });
      }
      await removeRelation(context.client, "track_credit", Number(credit.id), { note: NOTE, runId: context.runId });
    }
    await deleteEntity(context, "person", item.from);
  }
});
console.log(`run ${runId}`);
await closeDb();
