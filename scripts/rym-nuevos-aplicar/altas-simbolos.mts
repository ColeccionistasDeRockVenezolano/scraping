// RYM «nuevos» · altas de discos cuyo título no tiene letras ni cifras («^^^^^», «$$$$$», «#####»).
// El ER los normaliza a vacío y los da por iguales a «@@@@@» (Arca); Brian 2026-10-06: «crear los
// símbolos». Se crean con allowSimilar, uno por edición de RYM (plan-altas-simbolos.jsonl, formato de
// plan-altas.py), en un run reversible.
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/altas-simbolos.mts [--confirm]
import { readFileSync } from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { createEntity, withOperatorRun } from "../../src/merge/operator.js";

interface Item { rym_href: string; url: string; nombre: string; values: Record<string, unknown>; parent: { artist_id: number } }
const confirm = process.argv.includes("--confirm");
const items = readFileSync("reports/rym-nuevos-aplicacion-2026-10-05/plan-altas-simbolos.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as Item);
const creadas: unknown[] = [];
try {
  const { runId } = await withOperatorRun({
    name: "claude-code:altas-simbolos", operator: "claude-code (delegado por Brian)",
    note: "RYM «nuevos» 2026-10-06: disco con título de solo símbolos; el ER lo confunde con otro de símbolos distintos; se crea aparte (fuente citada por fila)",
    params: { urls: items.map((i) => i.url) },
  }, async (context) => {
    for (const it of items) {
      const r = await createEntity(context, "album", it.values, { artistId: it.parent.artist_id, allowSimilar: true });
      creadas.push({ id: r.id, title: it.nombre, url: it.url });
    }
    if (!confirm) throw new Error("__ensayo__");
  });
  console.log(JSON.stringify({ modo: "aplicado", runId, creadas }));
} catch (error) {
  if (!(error instanceof Error && error.message === "__ensayo__")) throw error;
  console.log(JSON.stringify({ modo: "ensayo (revertido)", creadas }));
}
await closeDb();
