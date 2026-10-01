// CRV · Expedientes para que Laya elija el tipo de los discos que siguen en
// `other` (Brian, 2026-09-28: «tipo de disco con Laya»; muestra de 40 y luego
// directo). La cosecha por reglas (scripts/apply-album-types.ts, run 10435) ya
// tomó lo que la hoja, el formato y las tiendas decían; aquí va el resto.
//
// Cada expediente reúne lo que el catálogo sabe del disco: título, artista,
// año, sello, número de pistas y duración total, los títulos de las pistas,
// los formatos, la reseña, el post de origen y las señales de las cosechas.
// Se saltan los splits (no hay tipo para eso) y los discos cuya clasificación
// de la hoja no lleva tipo (Music Video, Live Concert, Documentary, B-Sides).
// Solo lectura: escribe reports/album-type-laya-dossiers-2026-09-28.jsonl.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";
import { canonical, indexPosts, prose } from "./lib/laya-texts.js";

const DATE = "2026-09-28";
const OUT = `reports/album-type-laya-dossiers-${DATE}.jsonl`;
const LEDGERS = [`reports/album-type-evidence-${DATE}.jsonl`, `reports/album-type-evidence-online-${DATE}.jsonl`];
const NO_TYPE = ["Music Video", "Live Concert", "Documentary", "B-Sides"];
const MAX_TEXT = 1500;

async function main(): Promise<void> {
  const pool = getPool();
  const posts = indexPosts(getEnv().DATA_DIR);
  const albums = (await pool.query<{
    id: string; title: string; artist: string; year: number | null; label: string | null; description: string | null;
    tracks: string[] | null; n: number; seconds: number | null; known: number; formats: string[] | null; classes: string[] | null;
  }>(`
    SELECT a.id::text, a.title, ar.name AS artist, a.release_year AS year, o.name AS label, a.description,
           (SELECT array_agg(t.title ORDER BY t.disc_number, t.track_number) FROM public.tracks t WHERE t.album_id=a.id) AS tracks,
           (SELECT count(*)::int FROM public.tracks t WHERE t.album_id=a.id) AS n,
           (SELECT sum(t.duration_seconds)::int FROM public.tracks t WHERE t.album_id=a.id) AS seconds,
           (SELECT count(t.duration_seconds)::int FROM public.tracks t WHERE t.album_id=a.id) AS known,
           (SELECT array_agg(DISTINCT f.format) FROM public.album_formats f WHERE f.album_id=a.id) AS formats,
           (SELECT array_agg(x.classification) FROM ingest.album_classifications x WHERE x.album_id=a.id) AS classes
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id LEFT JOIN public.organizations o ON o.id=a.label_id
     WHERE a.album_type='other' ORDER BY a.id`)).rows;
  const urls = new Map<number, string[]>();
  for (const row of (await pool.query<{ album_id: string; url: string }>(`
    SELECT c.album_id::text, c.raw_value #>> '{}' AS url FROM ingest.claims c
     WHERE c.field='source_url' AND c.entity_kind='album' AND c.status='accepted' AND c.album_id IS NOT NULL`)).rows) {
    urls.set(Number(row.album_id), [...(urls.get(Number(row.album_id)) ?? []), row.url]);
  }
  const signals = new Map<number, string[]>();
  for (const file of LEDGERS) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const s = JSON.parse(line) as { albumId: number; via: string; type: string; raw: string };
      signals.set(s.albumId, [...(signals.get(s.albumId) ?? []), `${s.via}: ${s.type} (${s.raw})`]);
    }
  }
  const stats = { other: albums.length, noType: 0, split: 0, cases: 0, withPost: 0, withTracks: 0 };
  const cases: unknown[] = [];
  for (const album of albums) {
    const id = Number(album.id);
    if ((album.classes ?? []).some((c) => NO_TYPE.includes(c))) { stats.noType += 1; continue; }
    const postTexts = (urls.get(id) ?? []).map((url) => posts.get(canonical(url))).filter((raw): raw is string => Boolean(raw))
      .map((raw) => prose(raw).slice(0, MAX_TEXT)).filter((text) => text.length > 40);
    const blob = [album.title, album.description ?? "", ...postTexts, ...(signals.get(id) ?? [])].join(" ");
    if (/\bsplit\b/iu.test(blob)) { stats.split += 1; continue; }
    if (postTexts.length) stats.withPost += 1;
    if (album.n) stats.withTracks += 1;
    cases.push({
      caseId: `album:${id}`, albumId: id, title: album.title, artist: album.artist, year: album.year, label: album.label,
      trackCount: album.n, totalMinutes: album.known === album.n && album.n ? Math.round((album.seconds ?? 0) / 60) : null,
      tracks: (album.tracks ?? []).slice(0, 25), formats: album.formats ?? [], classifications: album.classes ?? [],
      review: album.description?.slice(0, MAX_TEXT) ?? null, posts: postTexts.slice(0, 2), signals: signals.get(id) ?? [],
    });
    stats.cases += 1;
  }
  writeFileSync(OUT, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(JSON.stringify({ ...stats, out: OUT }, null, 2));
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
