// CRV · Mide la inferencia de Essentia contra discos con género ya confirmado.
// Traduce cada estilo de Discogs («Rock---Punk») a la taxonomía de CRV: primero
// el estilo, y si no resuelve, el género ancho. Nunca escribe en la base.
//
//   npx tsx scripts/score-essentia-album-genres.ts salida-essentia.jsonl
import { readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { resolveGenreValue, type Taxonomy } from "../src/genres/taxonomy.js";

interface Row { id: string; artist: string; title: string; primary_slug: string; secondaries: string | null; styles: Array<{ label: string; p: number }> }

function slugOf(taxonomy: Taxonomy, label: string): string | null {
  const [broad, style] = label.split("---");
  for (const value of [style, broad]) {
    if (!value || /^latin$/iu.test(value)) continue;
    const item = resolveGenreValue(taxonomy, value).items.find((entry) => entry.kind === "genre");
    if (item && item.kind === "genre") return taxonomy.genres.get(item.genreId)?.slug ?? null;
  }
  return null;
}

async function main(): Promise<void> {
  const rows = readFileSync(process.argv[2]!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
  const client = await getPool().connect();
  const taxonomy = await loadTaxonomy(client);
  client.release();
  await closeDb();
  const family = (slug: string): string => {
    const node = taxonomy.bySlug.get(slug);
    return node?.parentId ? taxonomy.genres.get(node.parentId)!.slug : slug;
  };
  const tally = { exacto: 0, familia: 0, secundario: 0, falla: 0, top3: 0 };
  for (const row of rows) {
    const predicted = row.styles.map((style) => slugOf(taxonomy, style.label)).filter((slug): slug is string => !!slug);
    const reference = [row.primary_slug, ...(row.secondaries?.split(",") ?? [])];
    const top = predicted[0] ?? "?";
    const verdict = top === row.primary_slug ? "exacto"
      : reference.includes(top) ? "secundario"
        : reference.some((slug) => family(slug) === family(top)) ? "familia" : "falla";
    tally[verdict] += 1;
    if (predicted.slice(0, 3).some((slug) => reference.some((ref) => family(ref) === family(slug)))) tally.top3 += 1;
    console.log(`${verdict.padEnd(10)} ${row.primary_slug.padEnd(18)} ← ${row.styles.slice(0, 3).map((s) => `${s.label.split("---")[1]} ${s.p.toFixed(2)}`).join(", ").padEnd(60)} ${row.artist} — ${row.title}`);
  }
  const n = rows.length;
  console.log(`\n${n} discos · exacto ${tally.exacto} · secundario ${tally.secundario} · misma familia ${tally.familia} · falla ${tally.falla}`);
  console.log(`acierto de familia o mejor (top-1): ${((n - tally.falla) / n * 100).toFixed(0)} % · alguna de las 3 primeras compatible: ${(tally.top3 / n * 100).toFixed(0)} %`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
