// CRV · Qué géneros de Sincopa (fuera de rock/pop) la taxonomía aún no resuelve.
// Solo lectura: extrae del crudo local, resuelve con los alias vigentes y lista
// los tramos sin resolver con su frecuencia y los ejemplos que los afirman.
//   tsx scripts/sincopa-genre-gaps.ts [--out=reports/sincopa-genre-gaps.json]
import { writeFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getPool } from "../src/db/client.js";
import { loadStoredAdapterPages } from "../src/ingest/runner.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { resolveGenreValue } from "../src/genres/taxonomy.js";

const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);

async function main(): Promise<void> {
  const adapter = new SincopaAdapter();
  const pages = await loadStoredAdapterPages("sincopa", adapter);
  const client = await getPool().connect();
  try {
    const taxonomy = await loadTaxonomy(client);
    const names = new Map([...taxonomy.genres.values()].map((genre) => [genre.id, genre.name]));
    const resolved = new Map<string, { count: number; to: Set<string> }>();
    const gaps = new Map<string, { count: number; examples: string[]; raws: Set<string> }>();
    const totals = { values: 0, fullyResolved: 0, partlyResolved: 0, unresolved: 0 };
    for (const page of pages) {
      const section = new URL(page.url).pathname.split("/")[1] ?? "";
      if (section === "rock_pop") continue;
      for (const record of adapter.extractSnapshot(page)) {
        if (record.entityKind !== "artist" && record.entityKind !== "album") continue;
        for (const field of record.fields) {
          if (field.field !== "genre") continue;
          totals.values += 1;
          const resolution = resolveGenreValue(taxonomy, String(field.value));
          const unresolved = resolution.items.filter((item) => item.kind === "unresolved");
          if (unresolved.length === 0) totals.fullyResolved += 1;
          else if (unresolved.length < resolution.items.length) totals.partlyResolved += 1;
          else totals.unresolved += 1;
          for (const item of resolution.items) {
            if (item.kind === "genre") {
              const entry = resolved.get(item.fragment.toLowerCase()) ?? { count: 0, to: new Set<string>() };
              entry.count += 1; entry.to.add(names.get(item.genreId) ?? String(item.genreId));
              resolved.set(item.fragment.toLowerCase(), entry);
            } else {
              const key = item.fragment.toLowerCase();
              const entry = gaps.get(key) ?? { count: 0, examples: [], raws: new Set<string>() };
              entry.count += 1; entry.raws.add(String(field.value));
              if (entry.examples.length < 3) entry.examples.push(`${section}:${record.identity}`);
              gaps.set(key, entry);
            }
          }
        }
      }
    }
    const report = {
      generatedAt: new Date().toISOString(), totals,
      resolved: [...resolved.entries()].sort((a, b) => b[1].count - a[1].count).map(([fragment, v]) => ({ fragment, count: v.count, to: [...v.to] })),
      gaps: [...gaps.entries()].sort((a, b) => b[1].count - a[1].count).map(([fragment, v]) => ({ fragment, count: v.count, examples: v.examples, raws: [...v.raws].slice(0, 4) })),
    };
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
    console.log(JSON.stringify({ totals, gaps: report.gaps.length, resolved: report.resolved.length }));
    console.log("SIN RESOLVER:\n" + report.gaps.map((gap) => `${gap.count}\t${gap.fragment}\t${gap.raws.join(" | ")}`).join("\n"));
    console.log("RESUELTOS:\n" + report.resolved.map((row) => `${row.count}\t${row.fragment} -> ${row.to.join(", ")}`).join("\n"));
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
