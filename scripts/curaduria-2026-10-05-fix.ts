// CRV · Curaduría 2026-10-05: lotes de corrección con la acción recomendada.
//
// El mismo marco que la web (vista previa → aplicar → verificar → deshacer):
// selecciona hallazgos abiertos de un detector (y subgrupo, o una lista de ids),
// previsualiza el lote con la acción recomendada de cada uno (o `--action`),
// vuelca la vista previa y, con --confirm, lo aplica excluyendo los ítems de
// `--exclude=<archivo con ids de hallazgo>`.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-fix.ts --detector=<clave> [--signature=…] [--ids=<archivo>]
//        [--action=<acción>] [--exclude=<archivo>] [--note="…"] [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { applyFixBatch, getFixBatch, previewFixBatch, type FixBatchView } from "../src/curation/actions/batches.js";

const OPERATOR = "claude-code";
const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

async function allItems(batchId: number): Promise<FixBatchView["items"]> {
  const items: FixBatchView["items"] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await getFixBatch(batchId, { limit: 500, offset });
    items.push(...page.items);
    if (items.length >= page.pagination.total) break;
  }
  return items;
}

async function main(): Promise<void> {
  const detector = arg("detector")!;
  const signature = arg("signature");
  const idsFile = arg("ids");
  const exclude = new Set<number>(arg("exclude") ? (JSON.parse(readFileSync(arg("exclude")!, "utf8")) as number[]) : []);
  let ids: number[];
  if (idsFile) ids = JSON.parse(readFileSync(idsFile, "utf8")) as number[];
  else {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id::text FROM ingest.curation_findings WHERE status='open' AND detector=$1 AND ($2::text IS NULL OR signature=$2) ORDER BY id`,
      [detector, signature ?? null]);
    ids = rows.map((row) => Number(row.id));
  }
  ids = ids.filter((id) => !exclude.has(id));
  const tag = `${detector}${signature ? `-${signature}` : ""}`.replace(/[^\w-]+/gu, "_");
  const out = `reports/curaduria-2026-10-05/fix-${tag}`;
  const summary: Record<string, number> = {};
  const views: unknown[] = [];
  for (let start = 0; start < ids.length; start += 400) {
    const chunk = ids.slice(start, start + 400);
    const preview = await previewFixBatch({ mode: "selected", findingIds: chunk, ...(arg("action") ? { actionKey: arg("action") } : {}) }, OPERATOR);
    const items = await allItems(preview.id);
    for (const item of items) {
      summary[item.status] = (summary[item.status] ?? 0) + 1;
      views.push({ findingId: item.findingId, label: item.finding?.entity.label, action: item.actionKey, status: item.status,
        before: item.before, after: item.after, blocked: item.blocked, warnings: item.warnings, collisions: item.collisions, proposal: item.proposal });
    }
    if (process.argv.includes("--confirm")) {
      const pending = items.filter((item) => item.status === "pending");
      if (pending.length) {
        const applied = await applyFixBatch(preview.id, { previewHash: preview.previewHash, note: arg("note") ?? `Curaduría 2026-10-05: corrección recomendada (${detector})` },
          OPERATOR, { limit: 1, offset: 0 }, { verify: "background" });
        console.log(`lote ${preview.id}: ${applied.status}`, applied.counts);
      }
    } else {
      console.log(`lote ${preview.id} (vista previa)`);
    }
  }
  writeFileSync(`${out}${process.argv.includes("--confirm") ? "-applied" : "-preview"}.json`, JSON.stringify(views, null, 1));
  console.log(ids.length, "hallazgos", summary);
  await closeDb();
}
void main();
