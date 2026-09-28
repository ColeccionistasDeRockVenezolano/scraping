// CRV · Mide los libros de evidencia de las fuentes nuevas contra la taxonomía
// (solo lectura). Por libro: filas, filas con al menos un género reconocido
// (el primero reconocido sería el principal), y términos crudos que la
// taxonomía no reconoce, por frecuencia. Replica la lectura del aplicador:
// «pop/rock» = pop rock; si el valor entero no resuelve y trae - o :, se parte.
// Uso: npx tsx scripts/harvest-check-ledgers.ts <fuente> [<fuente>…]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { resolveGenreValue } from "../src/genres/taxonomy.js";

interface Row { caseId: string; kind: string; rawGenres?: string[] }

async function main(): Promise<void> {
  const client = await getPool().connect();
  const taxonomy = await loadTaxonomy(client);
  client.release();
  const report: Record<string, unknown> = {};
  const union = new Set<string>();
  for (const source of process.argv.slice(2)) {
    const path = `reports/genre-laya-evidence-${source}-2026-09-26.jsonl`;
    if (!existsSync(path)) continue;
    const rows = readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Row);
    const unresolved = new Map<string, number>();
    const primaries = new Map<string, number>();
    const resolved = { album: 0, artist: 0 } as Record<string, number>;
    for (const row of rows) {
      const slugs: string[] = [];
      for (const original of row.rawGenres ?? []) {
        const value = original.replace(/\bpop\s*\/\s*rock\b/giu, "pop rock");
        const take = (text: string): boolean => {
          let hit = false;
          for (const item of resolveGenreValue(taxonomy, text).items) {
            if (item.kind !== "genre") continue;
            const slug = taxonomy.genres.get(item.genreId)?.slug;
            if (slug) { hit = true; if (!slugs.includes(slug)) slugs.push(slug); }
          }
          return hit;
        };
        if (!take(value) && !(/[-:]/u.test(value) && value.split(/\s*[-:]\s*/u).filter(Boolean).map(take).some(Boolean))) {
          const key = value.toLowerCase().trim();
          unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
        }
      }
      if (slugs.length) {
        union.add(row.caseId);
        resolved[row.kind] = (resolved[row.kind] ?? 0) + 1;
        primaries.set(slugs[0]!, (primaries.get(slugs[0]!) ?? 0) + 1);
      }
    }
    report[source] = {
      rows: rows.length, withGenre: resolved,
      topPrimaries: [...primaries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      unresolved: [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
    };
  }
  report["_union"] = { album: [...union].filter((id) => id.startsWith("album:")).length, artist: [...union].filter((id) => id.startsWith("artist:")).length };
  writeFileSync("reports/harvest-check-ledgers-2026-09-27.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
