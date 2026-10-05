// CRV · Curaduría 2026-10-05: discos sin pistas que son el gemelo de discografía de un disco con pistas.
//
// Las páginas «Bio & Discography» de Sincopa listan cada disco (título, año, sello) y enlazan su
// página cdinfo, que trae las pistas. La promoción creó un disco por cada lugar: uno vacío (desde la
// discografía) y otro con pistas (desde cdinfo). El enlace de la discografía dice cuál es cuál: si
// apunta a la página de un disco del mismo artista, el vacío se funde en él (se conserva el disco con
// pistas; el vacío solo rellena campos vacíos y deja su título como alias si difiere).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-merge-discography-twins.ts --pairs=<tsv e\tpágina\tdestino> [--trust] [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: disco creado desde la discografía de Sincopa sin pistas; su enlace lleva a la página del disco que ya está en el catálogo con pistas";
const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const STOP = new Set(["vol", "volumen", "volume", "de", "del", "la", "el", "los", "las", "y", "con", "en", "the", "a", "no", "n", "numero", "num"]);
const tokens = (title: string, artist: string): string[] => {
  const drop = new Set(fold(artist).split(" "));
  return fold(title).split(" ").map((t) => ROMAN[t] ?? t.replace(/^0+(\d)/u, "$1")).filter((t) => t && !STOP.has(t) && !drop.has(t));
};
/** Mismo disco: mismos números y casi las mismas palabras (sin artista ni palabras vacías). */
function similar(a: string, artistA: string, b: string, artistB: string): boolean {
  if (fold(a) === fold(b)) return true;
  const x = tokens(a, artistA + " " + artistB); const y = tokens(b, artistA + " " + artistB);
  const nx = x.filter((t) => /\d/u.test(t)).sort().join(","); const ny = y.filter((t) => /\d/u.test(t)).sort().join(",");
  if (nx !== ny) return false;
  const wx = new Set(x.filter((t) => !/\d/u.test(t))); const wy = new Set(y.filter((t) => !/\d/u.test(t)));
  if (!wx.size || !wy.size) return wx.size === wy.size;
  const inter = [...wx].filter((t) => wy.has(t) || [...wy].some((u) => u.length > 3 && t.length > 3 && (u.startsWith(t) || t.startsWith(u)))).length;
  return inter / Math.min(wx.size, wy.size) >= 0.75 && inter / Math.max(wx.size, wy.size) >= 0.5;
}

interface Pair { drop: number; keep: number }
const rows = readFileSync(arg("pairs")!, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));
const byDrop = new Map<number, Set<number>>();
const byKeep = new Map<number, Set<number>>();
for (const [e, , t] of rows) {
  if (!t || t === e) continue;
  byDrop.set(Number(e), (byDrop.get(Number(e)) ?? new Set()).add(Number(t)));
  byKeep.set(Number(t), (byKeep.get(Number(t)) ?? new Set()).add(Number(e)));
}

const pool = getPool();
const plans: Array<Pair & { status: string; detail: string }> = [];
for (const [drop, targets] of byDrop) {
  const { rows: info } = await pool.query<{ id: string; title: string; artist: string; release_year: number | null; tracks: string }>(`
    SELECT a.id::text, a.title, ar.name AS artist, a.release_year, (SELECT count(*) FROM public.tracks t WHERE t.album_id=a.id)::text AS tracks
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id WHERE a.id = ANY($1::bigint[])`, [[drop, ...targets]]);
  const d = info.find((r) => Number(r.id) === drop);
  if (!d || Number(d.tracks) > 0) { plans.push({ drop, keep: 0, status: "omitido", detail: "el disco ya tiene pistas o no existe" }); continue; }
  // El enlace lleva a la página; la página puede traer varios discos: vale el del mismo título (sin el
  // nombre del artista, mismos números) y año compatible, con pistas. El artista puede ser otro: la
  // discografía de un músico enlaza los discos de las bandas donde tocó (disco de participación).
  const candidates = info.filter((r) => Number(r.id) !== drop && Number(r.tracks) > 0
    && similar(d.title, d.artist, r.title, r.artist) && (d.release_year === null || r.release_year === null || Math.abs(d.release_year - r.release_year) <= 1));
  // --trust: casos revisados a mano; vale el único destino del enlace aunque el título difiera.
  const linked = info.filter((r) => Number(r.id) !== drop);
  const pick = candidates.length === 1 ? candidates[0] : process.argv.includes("--trust") && linked.length === 1 ? linked[0] : undefined;
  if (!pick) {
    const all = info.filter((r) => Number(r.id) !== drop).map((c) => `${c.id} «${c.title}» ${c.release_year ?? ""} [${c.artist}] ${c.tracks}p`);
    plans.push({ drop, keep: 0, status: "manual", detail: `«${d.title}» ${d.release_year ?? ""} [${d.artist}] → ${all.join(" | ")}` }); continue;
  }
  const sharedDrops = [...(byKeep.get(Number(pick.id)) ?? [])].filter((x) => x !== drop);
  const titled = fold(pick.title) === fold(d.title);
  plans.push({ drop, keep: Number(pick.id), status: titled ? "fusionar" : "fusionar_alias",
    detail: `«${d.title}» ${d.release_year ?? ""} → «${pick.title}» ${pick.release_year ?? ""}${sharedDrops.length ? ` (otros vacíos al mismo: ${sharedDrops.join(",")})` : ""}` });
}
const counts: Record<string, number> = {};
for (const plan of plans) counts[plan.status] = (counts[plan.status] ?? 0) + 1;
console.log(counts);
if (process.argv.includes("--confirm")) {
  const { runId, result } = await withOperatorRun({ name: "curation:merge-discography-twins", operator: "claude-code", note: NOTE }, async (context) => {
    let merged = 0;
    for (const plan of plans) {
      if (!plan.status.startsWith("fusionar")) continue;
      await context.client.query("SAVEPOINT m");
      try {
        const preview = await previewAlbumMerge(context.client, plan.keep, plan.drop);
        await mergeAlbums(context, { keepId: plan.keep, dropId: plan.drop, previewHash: preview.previewHash, keepDropNameAsAlias: plan.status === "fusionar_alias" });
        await context.client.query("RELEASE SAVEPOINT m");
        merged += 1;
      } catch (error) {
        await context.client.query("ROLLBACK TO SAVEPOINT m");
        plan.status = "error"; plan.detail += ` · ${String(error)}`;
      }
    }
    return merged;
  });
  console.log(`run ${runId}: ${result} fusiones`);
}
writeFileSync(`reports/curaduria-2026-10-05/merge-discography-twins-${process.argv.includes("--confirm") ? "confirm" : "dry-run"}.json`, JSON.stringify(plans, null, 1));
await closeDb();
