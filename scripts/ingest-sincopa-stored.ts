// CRV · Ingiere como claims candidatos (low) el crudo local de Sincopa con el
// adapter vigente, sin red, por lotes de páginas y con avance visible. Equivale
// a la mitad de ingesta de `scrape source sincopa --all` para cuando el
// rastreo ya se hizo aparte. Cada lote es un run propio (deshacible por run).
// La deduplicación de claims no depende de la versión del extractor: lo ya
// ingerido se reutiliza y no cambia el estado de la cola.
//   tsx scripts/ingest-sincopa-stored.ts [--section=jazz,latin_pop,...] [--batch=40] [--except-rock]
// Sin --section recorre las secciones no rock primero y rock/pop al final.
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb } from "../src/db/client.js";
import { withCandidateSnapshot } from "../src/er/repository.js";
import { ingestAdapterSnapshots, loadStoredAdapterPages } from "../src/ingest/runner.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const sectionOf = (url: string) => new URL(url).pathname.split("/")[1] ?? "";

async function main(): Promise<void> {
  const adapter = new SincopaAdapter();
  const batchSize = Number(arg("batch") ?? 40);
  const only = arg("section")?.split(",");
  const pages = (await loadStoredAdapterPages("sincopa", adapter))
    .filter((page) => (only ? only.includes(sectionOf(page.url)) : true))
    .filter((page) => !(process.argv.includes("--except-rock") && sectionOf(page.url) === "rock_pop"));
  // Primero lo que se pidió ampliar; el rock ya cargado, al final.
  pages.sort((a, b) => Number(sectionOf(a.url) === "rock_pop") - Number(sectionOf(b.url) === "rock_pop"));
  const started = Date.now();
  const total = { pages: pages.length, done: 0, inserted: 0, reused: 0, merges: 0 };
  const actions: Record<string, number> = {};
  for (let from = 0; from < pages.length; from += batchSize) {
    const batch = pages.slice(from, from + batchSize);
    // Una instantánea de candidatos por lote: los claims low no escriben en el core.
    const result = await withCandidateSnapshot(() => ingestAdapterSnapshots("sincopa", adapter, batch, { confidence: "low" }));
    total.done += batch.length; total.inserted += result.claimsInserted; total.reused += result.claimsReused; total.merges += result.merges.length;
    for (const merge of result.merges) actions[merge.action] = (actions[merge.action] ?? 0) + 1;
    const minutes = (Date.now() - started) / 60000;
    console.log(JSON.stringify({ progress: `${total.done}/${total.pages}`, section: sectionOf(batch[0]!.url), runId: result.runId,
      inserted: result.claimsInserted, reused: result.claimsReused, minutes: Number(minutes.toFixed(1)),
      etaMinutes: Math.round(minutes / total.done * (total.pages - total.done)) }));
  }
  console.log(JSON.stringify({ final: true, ...total, actions, minutes: Math.round((Date.now() - started) / 60000) }));
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
