// CRV · Etapa 5 del nuevo lote: fotos para las fichas del lote que siguen sin
// foto tras la etapa 4 (Brian, 2026-10-04: «van a Curaduría · Imágenes para
// elegir a ojo»). NO toca las fichas: solo ingest.image_candidates.
//
// Entrada (cosecha hecha aparte, JSON con { artistId, image, page }):
//   · Wikipedia (es, luego en) por título exacto o redirección, sin
//     desambiguaciones: imagen principal de la página (pageimages).
//   · Deezer: artistas con el nombre exacto (normalizado) y foto propia; puede
//     ser un homónimo, por eso solo se proponen.
//
// UN run de operador; sin --confirm corre y se deshace. Repetirlo no duplica.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa5-fotos-candidatas.ts --wiki=<json> --deezer=<json> [--confirm]
import { readFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { proposeImageCandidate } from "../src/merge/image-candidates.js";
import { withOperatorRun } from "../src/merge/operator.js";

const CONFIRM = process.argv.includes("--confirm");
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const OPERATOR = "claude-code (delegado por Brian)";
const NOTE = "Nuevo lote 2026-10-02, etapa 5: fotos candidatas (Wikipedia, Deezer) para las fichas del lote sin foto; se eligen a ojo en Curaduría";

interface Found { artistId: number; image: string; page: string }
const load = (file: string | undefined): Found[] => (file ? JSON.parse(readFileSync(file, "utf8")) as Found[] : []);
/** Sin parámetros de seguimiento (`?utm_source=…`) que Wikipedia añade a la URL. */
const clean = (url: string) => url.replace(/\?utm_[^#]*$/u, "");
const SOURCES: Array<{ source: string; origin: string; rows: Found[] }> = [
  { source: "Wikipedia", origin: "lote-2026-10-02:etapa5:wikipedia", rows: load(arg("wiki")) },
  { source: "Deezer (API)", origin: "lote-2026-10-02:etapa5:deezer", rows: load(arg("deezer")) },
];

class DryRun extends Error {}

async function main(): Promise<void> {
  const counts: Record<string, number> = {};
  let runId = 0;
  try {
    await withOperatorRun({ name: "lote-2026-10-02:etapa5:fotos-candidatas", operator: OPERATOR, note: NOTE, params: { confirm: CONFIRM } }, async (context) => {
      runId = context.runId;
      for (const { source, origin, rows } of SOURCES) {
        for (const row of rows) {
          const current = await context.client.query<{ picture_url: string | null }>("SELECT picture_url FROM public.artists WHERE id=$1", [row.artistId]);
          if (!current.rowCount) { counts["sin ficha"] = (counts["sin ficha"] ?? 0) + 1; continue; }
          if (current.rows[0]!.picture_url) { counts["ya tiene foto"] = (counts["ya tiene foto"] ?? 0) + 1; continue; }
          const result = await proposeImageCandidate(context.client, {
            kind: "artist", targetId: row.artistId, currentUrl: "", candidateUrl: clean(row.image),
            source, pageUrl: row.page, origin, runId: context.runId,
          });
          counts[`${source}: ${result}`] = (counts[`${source}: ${result}`] ?? 0) + 1;
        }
      }
      // La ficha no tiene foto: la candidata se guarda sin «actual».
      await context.client.query("UPDATE ingest.image_candidates SET current_url=NULL WHERE run_id=$1 AND current_url=''", [context.runId]);
      if (!CONFIRM) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  console.log(`${CONFIRM ? "confirm" : "dry-run (todo se deshizo)"} · run ${runId} · ${JSON.stringify(counts)}`);
}

main().finally(() => closeDb());
