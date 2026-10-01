// Sonda de solo lectura: extrae con el adapter de Sincopa las secciones no rock
// ya descargadas y resume qué sale por sección (sin red ni escritura).
import { loadStoredAdapterPages } from "../../src/ingest/runner.js";
import { SincopaAdapter } from "../../src/adapters/sincopa.js";
import { closeDb } from "../../src/db/client.js";

const adapter = new SincopaAdapter();
const pages = await loadStoredAdapterPages("sincopa", adapter);
const bySection = new Map<string, Record<string, number>>();
const genres = new Map<string, number>();
const noParse: string[] = [];
for (const page of pages) {
  const section = new URL(page.url).pathname.split("/")[1] ?? "";
  const records = adapter.extractSnapshot(page);
  const counts = bySection.get(section) ?? {};
  counts["pages"] = (counts["pages"] ?? 0) + 1;
  if (records.length === 0) { counts["empty"] = (counts["empty"] ?? 0) + 1; noParse.push(page.url); }
  for (const record of records) {
    counts[record.entityKind] = (counts[record.entityKind] ?? 0) + 1;
    for (const field of record.fields) {
      if (field.field === "genre") genres.set(`${section}|${field.value}`, (genres.get(`${section}|${field.value}`) ?? 0) + 1);
      if (field.field === "cover_url") counts["cover"] = (counts["cover"] ?? 0) + 1;
      if (field.field === "picture_url") counts["photo"] = (counts["photo"] ?? 0) + 1;
    }
  }
  bySection.set(section, counts);
}
console.log(JSON.stringify(Object.fromEntries(bySection), null, 1));
console.log("sin registros:", noParse.filter((u) => !/index|menu|instruments|vertical|musicians\//i.test(u)).length);
console.log(noParse.filter((u) => !/index|menu|instruments|vertical|musicians\//i.test(u)).slice(0, 15).join("\n"));
console.log([...genres.entries()].filter(([k]) => !k.startsWith("rock_pop")).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, v]) => `${v}\t${k}`).join("\n"));
await closeDb();
