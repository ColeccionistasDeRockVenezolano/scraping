// Aplica los links de plataformas de streaming (perfil de artista y discos)
// cosechados por scripts/streaming-colector.py a `public.streaming_links`
// (migración 0039), en un run reversible (el diario 0028 la registra `soft`).
//
// Uso: ./scripts/with-node22.sh npx tsx scripts/apply-streaming-links.ts \
//        reports/streaming-links-2026-10-04/piloto-100 [--confirm]
//
// Lee los `links-<artistId>.json` (perfil + discos anidados), valida contra la
// BD viva (el artista existe y el disco sigue siendo suyo — las fusiones
// mueven ids) y hace upsert por (entidad, plataforma). Sin `--confirm` solo
// previsualiza. Los links entran `verified=false` (candidatos): la revisión
// humana/campaña los promueve después.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

interface Link { platform: string; url: string; id?: string | number | null; method: string; source: string; score?: number; name_plat?: string | null; title_plat?: string | null; year_plat?: number | null; }
interface AlbumLink extends Link { albumId: number; }
interface ArtistFile { artistId: number; name: string; artist_links: Link[]; album_links: AlbumLink[]; }

const dirArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const DIR = dirArg ?? "reports/streaming-links-2026-10-04/piloto-100";
const confirm = process.argv.includes("--confirm");

type Fila = { artistId?: number; albumId?: number; l: Link; quien: string };

async function main(): Promise<void> {
  const files = readdirSync(DIR).filter((f) => f.startsWith("links-") && f.endsWith(".json")).sort();
  const pool = getPool();

  const vivos = new Set<number>();
  for (const r of (await pool.query<{ id: string }>("SELECT id::text AS id FROM public.artists")).rows) vivos.add(Number(r.id));
  const albumDe = new Map<number, number>();
  for (const r of (await pool.query<{ id: string; artist_id: string }>("SELECT id::text AS id, artist_id::text AS artist_id FROM public.albums")).rows) {
    albumDe.set(Number(r.id), Number(r.artist_id));
  }

  const filas: Fila[] = [];
  let artistasSinFicha = 0;
  let albumesMovidos = 0;
  let duplicadosInternos = 0;
  const vistos = new Set<string>();
  for (const f of files) {
    const d = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as ArtistFile;
    if (!vivos.has(d.artistId)) { artistasSinFicha++; continue; }
    for (const l of d.artist_links) {
      const key = `a:${d.artistId}:${l.platform}`;
      if (vistos.has(key)) { duplicadosInternos++; continue; }
      vistos.add(key);
      filas.push({ artistId: d.artistId, l, quien: d.name });
    }
    for (const l of d.album_links) {
      const dueno = albumDe.get(l.albumId);
      if (dueno === undefined || dueno !== d.artistId) { albumesMovidos++; continue; }
      const key = `d:${l.albumId}:${l.platform}`;
      if (vistos.has(key)) { duplicadosInternos++; continue; }
      vistos.add(key);
      filas.push({ albumId: l.albumId, l, quien: d.name });
    }
  }

  const porPlataforma = new Map<string, number>();
  for (const fila of filas) porPlataforma.set(fila.l.platform, (porPlataforma.get(fila.l.platform) ?? 0) + 1);
  const resumenPrev = [...porPlataforma.entries()].map(([p, n]) => `${p}:${n}`).join(" ");
  const fuzzy = filas.filter((f) => f.l.method !== "exact").length;
  console.log(`archivos ${files.length} · filas ${filas.length} (fuzzy ${fuzzy}) · ${resumenPrev}`);
  console.log(`saltados: sin ficha ${artistasSinFicha} · disco movido de artista ${albumesMovidos} · duplicados internos ${duplicadosInternos}`);

  if (!confirm) {
    for (const fila of filas.slice(0, 12)) {
      console.log(`  ${fila.artistId ? `artista ${fila.artistId}` : `album ${fila.albumId}`} · ${fila.l.platform} · ${fila.l.method} · ${fila.l.url}`);
    }
    console.log(`dry-run: ${filas.length} links listos; ejecuta con --confirm`);
    await closeDb();
    return;
  }

  const { runId, result } = await withOperatorRun({
    name: "hermes:streaming-links",
    operator: "hermes (delegado por Brian)",
    note: "Links a plataformas de streaming por artista/álbum (campaña de enlaces; APIs oficiales Spotify/iTunes/Deezer/MusicBrainz/Wikidata; candidatos con método exact/fuzzy).",
  }, async (context) => {
    const log: string[] = [];
    for (const fila of filas) {
      const nota = [
        fila.l.score != null ? `score ${fila.l.score}` : null,
        fila.l.name_plat ? `perfil: «${fila.l.name_plat}»` : null,
        fila.l.title_plat ? `disco: «${fila.l.title_plat}»${fila.l.year_plat ? ` (${fila.l.year_plat})` : ""}` : null,
      ].filter(Boolean).join(" · ");
      const valores = [
        fila.artistId ?? null, fila.albumId ?? null, fila.l.platform, fila.l.url,
        fila.l.id != null ? String(fila.l.id) : null, fila.l.method, fila.l.source,
        nota || null,
      ];
      const sql = fila.artistId
        ? `INSERT INTO public.streaming_links(artist_id, album_id, platform, url, external_id, method, source, verified, notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,false,$8)
           ON CONFLICT (artist_id, platform) WHERE artist_id IS NOT NULL DO NOTHING RETURNING id::text`
        : `INSERT INTO public.streaming_links(artist_id, album_id, platform, url, external_id, method, source, verified, notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,false,$8)
           ON CONFLICT (album_id, platform) WHERE album_id IS NOT NULL DO NOTHING RETURNING id::text`;
      const { rows } = await context.client.query<{ id: string }>(sql, valores);
      if (rows[0]) log.push(`${fila.artistId ? `artista ${fila.artistId}` : `album ${fila.albumId}`} · ${fila.l.platform} · ${fila.l.method}`);
    }
    return log;
  });

  writeFileSync(`reports/apply-streaming-links-run${runId}.json`, JSON.stringify({
    runId, dir: DIR, filas: filas.length, aplicados: result.length,
    porPlataforma: Object.fromEntries(porPlataforma), fuzzy,
  }, null, 2));
  console.log(`run ${runId}: ${result.length} links aplicados (de ${filas.length})`);
  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
