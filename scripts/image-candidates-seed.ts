// CRV · Candidatas de imagen para elegir a ojo en Curaduría (Brian, 2026-10-04:
// «crea un espacio así en la curaduría… y si hay varias imágenes de perfil de
// un mismo artista, también una opción para seleccionar la foto adecuada»).
//
//   · Portadas: las «revisar» de la mejora de portadas pequeñas
//     (data/raw/portadas-mejora-2026-10-03/candidatos.jsonl), con TODAS las
//     candidatas de cualquier fuente que se parezcan (≥ 0,50) y midan ≥ 500 px.
//     Las ya aplicadas (aplicados-run*.json) no entran.
//   · Fotos de artista: las fotos que las fuentes afirman (claims picture_url)
//     distintas de la que la ficha muestra hoy (su origen sale del manifiesto
//     de medios, porque la ficha apunta a la copia local).
//
// Solo escribe en ingest.image_candidates; las fichas no se tocan. UN run de
// operador; sin --confirm corre y se deshace. Repetirlo no duplica (índices únicos).
//
//   ./scripts/with-node22.sh npx tsx scripts/image-candidates-seed.ts [--confirm]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { withOperatorRun, type OperatorContext } from "../src/merge/operator.js";

const COVERS_DIR = "data/raw/portadas-mejora-2026-10-03";
const MANIFEST = "web/public/media/manifest.json";
const NOTE = "Candidatas de portada y foto de artista para elegir a ojo en Curaduría (Brian, 2026-10-04)";
const MIN_SCORE = 0.5;
const MIN_SIDE = 500;

interface Tried { source: string; url: string; page: string; size?: [number, number]; score?: number; error?: string }
interface HarvestRow { albumId: number; decision: string; tried?: Tried[] }
class DryRun extends Error {
  constructor(readonly counts: Record<string, number>) { super("dry-run"); }
}

function appliedAlbums(): Set<number> {
  const ids = new Set<number>();
  for (const file of readdirSync(COVERS_DIR).filter((name) => /^aplicados-run\d+\.json$/u.test(name))) {
    for (const id of JSON.parse(readFileSync(`${COVERS_DIR}/${file}`, "utf8")) as number[]) ids.add(id);
  }
  return ids;
}

/** Disco → candidatas útiles (mejor parecido primero), solo de los discos con alguna «revisar». */
function coverCandidates(): Map<number, Tried[]> {
  const skip = appliedAlbums();
  const rows = readFileSync(`${COVERS_DIR}/candidatos.jsonl`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as HarvestRow);
  const review = new Set(rows.filter((row) => row.decision === "revisar").map((row) => row.albumId));
  const byAlbum = new Map<number, Map<string, Tried>>();
  for (const row of rows) {
    if (!review.has(row.albumId) || skip.has(row.albumId)) continue;
    for (const tried of row.tried ?? []) {
      if (tried.error || !tried.size || (tried.score ?? 0) < MIN_SCORE || Math.max(...tried.size) < MIN_SIDE) continue;
      const list = byAlbum.get(row.albumId) ?? new Map<string, Tried>();
      list.set(tried.url, tried);
      byAlbum.set(row.albumId, list);
    }
  }
  return new Map([...byAlbum].map(([id, list]) => [id, [...list.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))]));
}

async function seedCovers(context: OperatorContext, counts: Record<string, number>): Promise<void> {
  for (const [albumId, candidates] of coverCandidates()) {
    const album = await context.client.query<{ cover_url: string | null }>("SELECT cover_url FROM public.albums WHERE id=$1", [albumId]);
    const current = album.rows[0];
    if (!current) { counts["portadas: disco ya no existe"]! += 1; continue; }
    if (!current.cover_url?.startsWith("/crv/media/album/")) { counts["portadas: la portada cambió"]! += 1; continue; }
    let added = 0;
    for (const candidate of candidates) {
      const inserted = await context.client.query(`
        INSERT INTO ingest.image_candidates(entity_kind, album_id, current_url, candidate_url, source, page_url, width, height, score, origin, run_id)
        VALUES ('album', $1, $2, $3, $4, $5, $6, $7, $8, 'portadas-mejora-2026-10-03', $9)
        ON CONFLICT DO NOTHING`,
      [albumId, current.cover_url, candidate.url, candidate.source, candidate.page, candidate.size![0], candidate.size![1], candidate.score, context.runId]);
      added += inserted.rowCount ?? 0;
    }
    counts["portadas: candidatas"]! += added;
    if (added) counts["portadas: discos"]! += 1;
  }
}

async function seedArtistPhotos(context: OperatorContext, counts: Record<string, number>): Promise<void> {
  const manifest = existsSync(MANIFEST)
    ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as { entries: Record<string, { sourceUrl: string }> }).entries
    : {};
  const { rows } = await context.client.query<{ artist_id: string; url: string; source: string; picture_url: string | null }>(`
    SELECT DISTINCT c.artist_id::text, c.raw_value #>> '{}' AS url, s.name AS source, a.picture_url
      FROM ingest.claims c
      JOIN ingest.sources s ON s.id = c.source_id
      JOIN public.artists a ON a.id = c.artist_id
     WHERE c.field = 'picture_url' AND c.status <> 'rejected' AND c.raw_value #>> '{}' ~ '^https?://'`);
  const artists = new Set<string>();
  for (const row of rows) {
    const shown = row.picture_url?.startsWith("/crv/media/") ? manifest[`artist:${row.artist_id}`]?.sourceUrl : row.picture_url;
    if (!row.picture_url || row.url === shown) continue;
    const inserted = await context.client.query(`
      INSERT INTO ingest.image_candidates(entity_kind, artist_id, current_url, candidate_url, source, origin, run_id)
      VALUES ('artist', $1, $2, $3, $4, 'fotos-artista-2026-10-04', $5)
      ON CONFLICT DO NOTHING`, [Number(row.artist_id), row.picture_url, row.url, row.source, context.runId]);
    if (inserted.rowCount) { counts["fotos: candidatas"]! += 1; artists.add(row.artist_id); }
  }
  counts["fotos: artistas"] = artists.size;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  let counts: Record<string, number>;
  let runId: number | null = null;
  try {
    const done = await withOperatorRun({ name: "image_candidates_seed", operator: "brian", note: NOTE, params: { covers: COVERS_DIR } }, async (context) => {
      const count: Record<string, number> = {
        "portadas: discos": 0, "portadas: candidatas": 0, "portadas: disco ya no existe": 0, "portadas: la portada cambió": 0,
        "fotos: artistas": 0, "fotos: candidatas": 0,
      };
      await seedCovers(context, count);
      await seedArtistPhotos(context, count);
      if (!confirm) throw new DryRun(count);
      return count;
    });
    runId = done.runId;
    counts = done.result;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    counts = error.counts;
  }
  console.log(`${confirm ? `run ${runId}` : "ensayo"} · ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" · ")}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
