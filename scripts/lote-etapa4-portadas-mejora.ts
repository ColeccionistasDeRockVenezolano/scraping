// CRV · Etapa 4 del nuevo lote: las 16 portadas en conflicto del run 11619.
// Todas eran miniaturas de Sincopa de 160 px. Brian (2026-10-03) aprobó
// cambiarlas por la versión grande con prioridad Spotify > Deezer >
// MusicBrainz > Discogs, solo si es la MISMA portada (revisadas a ojo, hoja de
// contacto en el informe). Las que no lo son o no mejoran se quedan.
//
// Un run de operador; después `npm run media:localize` descarga las nuevas.
// Sin --confirm corre entero y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-portadas-mejora.ts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Etapa 4 del nuevo lote: portada de Sincopa (160 px) cambiada por la misma portada en grande; prioridad Spotify > Deezer > MusicBrainz > Discogs (Brian, 2026-10-03)";

const CHANGE: Array<{ albumId: number; source: string; url: string; page: string }> = [
  { albumId: 9042, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b273e7f6b92d459b08e166d8ea90", page: "https://open.spotify.com/album/7ccPIVVGLeJHEnQ6KwlKlS" },
  { albumId: 6959, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b2734e1973a246812fd2648a8e16", page: "https://open.spotify.com/album/3UUQe7RST4oMlGq2ZgW5An" },
  { albumId: 14813, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b2732360ae38dcd43976558c3d14", page: "https://open.spotify.com/album/4YJc4US1v2HJbnYcVEk5MV" },
  { albumId: 8439, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b273950bd0502260942a2c912ac6", page: "https://open.spotify.com/album/2A8IXHurDspwc1k1dpV0Qm" },
  { albumId: 8822, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b273366a7c4dd269be5ff1df3144", page: "https://open.spotify.com/album/2ft8MHb24K6KzbkX3jL3JT" },
  { albumId: 9062, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b273b3fade95e85599443e5f0bf2", page: "https://open.spotify.com/album/55epExJb0p95ZWiRypP1QE" },
  { albumId: 14610, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b2738c4d4db2345e8b47d029e684", page: "https://open.spotify.com/album/1IjxRo8rfMHfJbvuFEqAWo" },
  { albumId: 14611, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b2730cdc2f9bfa808eada4baa982", page: "https://open.spotify.com/album/2xF8gzkr3VqPccFVjmTnwC" },
  { albumId: 14613, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b273aaedad21cb4ab8b35f5621ac", page: "https://open.spotify.com/album/4fXILOMBr57rYVoZ22Z1C4" },
  { albumId: 14623, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b273d155dbae0e326d72f1ad7841", page: "https://open.spotify.com/album/3k15NitUXNO0K5GlTF5zEu" },
  // Pablo Gil no está en Spotify ni en Deezer ni en MusicBrainz.
  { albumId: 14603, source: "discogs", url: "https://i.discogs.com/u8ssltKsQEVWmJHEk3R5axNZblCxFVR7sGFpiWvu43Y/rs:fit/g:sm/q:90/h:600/w:594/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9SLTE4MTU0/OTQ4LTE2MTc1Njgw/MjMtMTkzOC5qcGVn.jpeg", page: "https://www.discogs.com/release/18154948" },
  { albumId: 14606, source: "discogs", url: "https://i.discogs.com/j030mKSphiLpZ_sDF_Sy1kYxA9QKp_zv5CULifBpupY/rs:fit/g:sm/q:90/h:539/w:600/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9SLTE0NjU3/ODczLTE1NzkwNTc4/NzQtMzEwMi5qcGVn.jpeg", page: "https://www.discogs.com/release/14657873" },
];
const KEEP = [
  "14604 Pablo Gil — Símbolos: Discogs solo tiene una foto del CD en su envoltorio (320 px)",
  "14605 Pablo Gil — Baladas: Discogs tiene la misma miniatura (175 × 160)",
  "14628 Simón Díaz — De Parranda Con Simón: Spotify y Deezer traen otra edición (otra foto)",
  "9664 Ensamble Gurrufío — Sesiones con Moisés Torrealba: misma foto, otro diseño del texto (sin «Invitado especial»)",
];

class DryRun extends Error {}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const lines: string[] = [];
  let runId: number | null = null;
  try {
    const done = await withOperatorRun({ name: "cover_upgrade", operator: "brian", note: NOTE, params: { lote: "nuevo-lote-2026-10-02", etapa: 4, conflictRun: 11619 } },
      async (context) => {
        for (const item of CHANGE) {
          const before = await context.client.query<{ cover_url: string | null; title: string }>("SELECT cover_url, title FROM public.albums WHERE id=$1", [item.albumId]);
          const result = await updateEntity(context, "album", item.albumId, { cover_url: item.url });
          lines.push(`| ${item.albumId} | ${before.rows[0]?.title} | ${item.source} | ${result.fields[0]?.action} | ${item.page} |`);
        }
        if (!confirm) throw new DryRun();
      });
    runId = done.runId;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  const mode = confirm ? "confirm" : "dry-run";
  const file = `reports/nuevo-lote-2026-10-02/etapa4-portadas-mejora-${mode}${runId ? `-run${runId}` : ""}.md`;
  writeFileSync(file, [
    `# Etapa 4 — portadas en conflicto cambiadas por la versión grande (${mode}${runId ? `, run ${runId}` : ""})`, "",
    NOTE, "", "| Disco | Título | Fuente | Resultado | Página |", "|---|---|---|---|---|", ...lines, "",
    "## Se quedan con la portada actual", "", ...KEEP.map((line) => `- ${line}`), "",
  ].join("\n"));
  console.log(`${lines.length} portadas → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
