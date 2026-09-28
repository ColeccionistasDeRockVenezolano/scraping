// Anota el catálogo de la Radio CRV que mantiene herra con los géneros
// confirmados del álbum de cada canción (PLAN_GENEROS §6, catálogo v3).
//
// No decide qué suena: no agrega, quita ni reordena piezas. El cron de herra
// lo corre después de su exportación diaria, así que las canciones nuevas y
// las decisiones de la Mesa entran en la siguiente pasada.
//
//   npm run radio:genres -- /home/brian/apps/herra/data/crv-radio-catalog.json [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { albumsForVideos, annotateRadioCatalog, loadRadioAlbumGenres } from "../src/radio/genres.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const requested = args.find((arg) => !arg.startsWith("--")) ?? process.env["CRV_RADIO_CATALOG_PATH"];
  if (!requested) throw new Error("uso: npm run radio:genres -- /ruta/crv-radio-catalog.json [--dry-run]");
  const filePath = path.resolve(requested);
  const original = fs.readFileSync(filePath, "utf8");
  const catalog = JSON.parse(original) as Record<string, unknown>;
  const items = Array.isArray(catalog["items"]) ? catalog["items"] as Array<Record<string, unknown>> : [];
  const videoIds = items.flatMap((item) => (typeof item?.["videoId"] === "string" ? [item["videoId"] as string] : []));

  const albumByVideo = await albumsForVideos(getPool(), videoIds);
  const genresByAlbum = await loadRadioAlbumGenres(getPool(), [...albumByVideo.values()]);
  const previousStamp = typeof catalog["genresAnnotatedAt"] === "string" ? catalog["genresAnnotatedAt"] : "";
  const { catalog: annotated, stats } = annotateRadioCatalog(catalog, albumByVideo, genresByAlbum, previousStamp);
  const summary = `Radio CRV · géneros: ${stats.items} piezas · ${stats.linked} con álbum (${stats.confirmed} confirmadas, `
    + `${stats.pending} pendientes, ${stats.unclassified} sin clasificar) · ${stats.unlinked} sin álbum enlazado`;

  // Solo se reescribe si cambió algo más que la fecha de anotación.
  if (JSON.stringify(annotated, null, 2) + "\n" === original) {
    process.stdout.write(`${summary}; sin cambios, el archivo no se modifica\n`);
    return;
  }
  if (dryRun) {
    process.stdout.write(`${summary}; dry-run, no se escribió\n`);
    return;
  }
  annotated["genresAnnotatedAt"] = new Date().toISOString();
  const mode = fs.statSync(filePath).mode & 0o777;
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(annotated, null, 2) + "\n", { encoding: "utf8", mode });
  fs.renameSync(temporary, filePath);
  process.stdout.write(`${summary} -> ${filePath}\n`);
}

main()
  .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; })
  .finally(closeDb);
