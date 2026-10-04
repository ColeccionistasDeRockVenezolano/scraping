// Etapa 4 «Altas» — cierra avisos de la cola de revisión con la función sancionada
// (resolveReview de src/review/queue.ts, la misma del operator-review y la Mesa).
//
// Uso:
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/resolver-avisos.mts \
//     --ids=1810432,1810433 --verdict=dismissed --nota="motivo firmado"
import { closeDb } from "../../src/db/client.js";
import { resolveReview } from "../../src/review/queue.js";

const args = process.argv.slice(2);
const argVal = (n: string) => args.find((v) => v.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const idsRaw = argVal("ids") ?? "";
const idsFile = argVal("ids-file");
let ids = idsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
if (idsFile) {
  const { readFileSync } = await import("node:fs");
  ids = readFileSync(idsFile, "utf8").split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}
const verdict = (argVal("verdict") ?? "dismissed") as "approved" | "dismissed";
const nota = argVal("nota") ?? "";

if (!ids.length) throw new Error("faltan --ids=<csv> o --ids-file=<ruta>");
if (!nota.trim()) throw new Error("falta --nota=");
if (verdict !== "approved" && verdict !== "dismissed") throw new Error("--verdict=approved|dismissed");

let ok = 0;
const errores: Array<{ id: number; error: string }> = [];
for (const id of ids) {
  try {
    await resolveReview(id, verdict, nota);
    ok += 1;
    console.log(`aviso ${id}: ${verdict}`);
  } catch (error) {
    errores.push({ id, error: (error instanceof Error ? error.message : String(error)).slice(0, 160) });
    console.log(`aviso ${id}: ERROR ${errores.at(-1)!.error}`);
  }
}
console.log(`total: ${ok}/${ids.length} cerrados`);
if (errores.length) console.log(JSON.stringify(errores));
await closeDb();
