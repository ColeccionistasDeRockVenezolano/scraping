// CRV · Curaduría 2026-10-05: listas de pistas de Deezer/MusicBrainz para discos sin pistas.
//
// Entrada: reports/curaduria-2026-10-05/tracklists-externas.jsonl (búsqueda por enlace guardado del disco o
// por artista exacto + título exacto + año ±1). Se excluyen los «sencillos» que casan con un álbum largo.
// Solo toca discos que siguen sin pistas; cada pista nace por el operador en un run reversible.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-apply-external-tracklists.ts [--exclude=1,2] [--confirm]
import { readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { createEntity, withOperatorRun } from "../src/merge/operator.js";

interface Row { albumId: number; title: string; type: string; status: string; source: string; url: string; tracks: Array<{ disc: number; title: string; duration: number | null }> }
const exclude = new Set((process.argv.find((a) => a.startsWith("--exclude="))?.slice(10) ?? "").split(",").filter(Boolean).map(Number));
const rows = readFileSync("reports/curaduria-2026-10-05/tracklists-externas.jsonl", "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as Row).filter((r) => r.status === "ok" && !exclude.has(r.albumId) && !(r.type === "single" && r.tracks.length > 3));
const empty = new Set((await getPool().query<{ id: string }>(
  "SELECT a.id::text FROM public.albums a WHERE NOT EXISTS (SELECT 1 FROM public.tracks t WHERE t.album_id=a.id)")).rows.map((r) => Number(r.id)));
const plan = rows.filter((r) => empty.has(r.albumId));
console.log(`${plan.length} discos, ${plan.reduce((s, r) => s + r.tracks.length, 0)} pistas`);
if (process.argv.includes("--confirm")) {
  const { runId } = await withOperatorRun({
    name: "curation:external-tracklists", operator: "claude-code",
    note: "Curaduría 2026-10-05: lista de pistas de Deezer/MusicBrainz para discos sin pistas (enlace del disco o artista+título exactos y año ±1)",
    params: { albums: plan.map((r) => ({ albumId: r.albumId, url: r.url })) },
  }, async (context) => {
    for (const row of plan) {
      const perDisc = new Map<number, number>();
      for (const t of row.tracks) {
        const n = (perDisc.get(t.disc) ?? 0) + 1; perDisc.set(t.disc, n);
        // Un popurrí con la lista de sus partes en el título (>250): queda el nombre del popurrí.
        const clean = t.title.replace(/\s+/gu, " ").trim();
        await createEntity(context, "track", { title: clean.length > 250 ? clean.split(":")[0]!.trim() : clean, disc_number: t.disc, track_number: n,
          ...(t.duration ? { duration_seconds: t.duration } : {}) }, { albumId: row.albumId, allowSimilar: true });
      }
    }
  });
  console.log(`run ${runId}`);
}
await closeDb();
