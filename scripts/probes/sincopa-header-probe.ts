// Sonda de solo lectura: ¿la cabecera de las fichas de disco sale bien en todas las secciones?
import { loadStoredAdapterPages } from "../../src/ingest/runner.js";
import { SincopaAdapter } from "../../src/adapters/sincopa.js";
import { closeDb } from "../../src/db/client.js";

const adapter = new SincopaAdapter();
const pages = await loadStoredAdapterPages("sincopa", adapter);
const INSTRUMENT = /^(piano|violin|guitar|cello|flute|organ|clarinet|trombone|bass|drums|saxophone|trumpet|vocals?|cuatro|harp|percussion)\b/i;
let albums = 0; const suspicious: string[] = []; const sample: string[] = [];
for (const page of pages) {
  if (!/\/cdinfo/.test(page.url)) continue;
  for (const record of adapter.extractSnapshot(page)) {
    if (record.entityKind !== "album") continue;
    albums += 1;
    const get = (name: string) => record.fields.find((field) => field.field === name)?.value;
    const title = String(get("title") ?? ""); const label = String(get("label") ?? ""); const genre = String(get("genre") ?? "");
    if ((label && INSTRUMENT.test(label)) || (label && title.toLowerCase().endsWith(` ${label.toLowerCase()}`)) || !genre) suspicious.push(`${page.url} | ${title} | ${label} | ${genre}`);
    else if (Math.random() < 0.004) sample.push(`${title} | ${label} | ${genre}`);
  }
}
console.log({ albums, suspicious: suspicious.length });
console.log(suspicious.slice(0, 25).join("\n"));
console.log("--- muestra\n" + sample.join("\n"));
await closeDb();
