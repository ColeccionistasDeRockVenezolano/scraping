// Aplica los enlaces cosechados por scripts/streaming-colector.py: perfiles de escucha y discos a
// `public.streaming_links` (0039) y redes sociales a `public.social_links` (0040), en UN run
// reversible (el diario 0028 registra ambas tablas `soft`).
//
// Uso: ./scripts/with-node22.sh npx tsx scripts/apply-streaming-links.ts \
//        reports/streaming-links-2026-10-04/campana [--confirm]
//
// Identidad (Brian, 2026-10-05: «solo los confirmados» se muestran). El colector casó por NOMBRE
// («Skank» recibió las redes de la banda brasileña), así que cada enlace entra con `verified`:
//   * Deezer — el perfil re-elegido por discos en común (streaming-deezer-reeleccion.py) o el
//     original si casó al menos un disco del catálogo;
//   * Apple Music — si casó al menos un disco del catálogo;
//   * MusicBrainz (redes, Spotify, YouTube, Tidal…) — si la pasada streaming-identidad.py lo
//     confirma por país/área o por disco en común, o si su perfil de Deezer es el confirmado;
//   * Wikidata — solo si repite un enlace ya confirmado por otra vía;
//   * discos — `exact`, o `fuzzy` con título idéntico (score ≥ 0,98: reedición de otro año).
// Lo no confirmado entra igual con verified=false (candidato, oculto en la web).
//
// Valida contra la BD viva (el artista existe y el disco sigue siendo suyo: las fusiones mueven
// ids). Upsert por (entidad, plataforma): una campaña posterior corrige url/verificación.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

interface Link { platform: string; url: string; id?: string | number | null; method: string; source: string; score?: number; name_plat?: string | null; title_plat?: string | null; year_plat?: number | null; }
interface AlbumLink extends Link { albumId: number; }
interface ArtistFile { artistId: number; name: string; artist_links: Link[]; album_links: AlbumLink[]; }
interface Identidad { artistId: number; veredicto: string; mbid?: string; pais?: string | null; discos_comunes?: string[]; rels?: Record<string, string> }
interface Reeleccion { artistId: number; perfil?: { url: string; id: number; name_plat: string; score: number; method: string; nb_album: number; nb_fan: number }; comunes: number; album_links: AlbumLink[] }

const dirArg = process.argv.slice(2).find((value) => !value.startsWith("--"));
const DIR = dirArg ?? "reports/streaming-links-2026-10-04/campana";
const BASE = path.dirname(DIR);
const confirm = process.argv.includes("--confirm");

const SOCIAL: Record<string, string> = { twitter: "x", x: "x", facebook: "facebook", instagram: "instagram", tiktok: "tiktok", threads: "threads", bluesky: "bluesky" };
const MB_OK = new Set(["confirmado_disco", "confirmado_pais"]);

type Fila = { tabla: "streaming" | "social"; artistId?: number; albumId?: number; platform: string; url: string; externalId: string | null; handle: string | null; method: string; source: string; verified: boolean; nota: string; quien: string };

function jsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

const deezerId = (url: string): string | null => /deezer\.com\/(?:\w+\/)?artist\/(\d+)/u.exec(url)?.[1] ?? null;

/** Usuario de la red, sin «@», cuando la URL lo deja leer (no en páginas /pages/ o /profile.php). */
function handleOf(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (!parts[0] || ["pages", "profile.php", "people", "groups", "pg", "channel", "user", "hashtag"].includes(parts[0])) return null;
    const h = parts[0].replace(/^@/u, "");
    return /^[\w.]{1,60}$/u.test(h) ? h : null;
  } catch { return null; }
}

function nota(l: Link, extra: string[] = []): string {
  return [
    ...extra,
    l.score != null ? `score ${l.score}` : null,
    l.name_plat ? `perfil: «${l.name_plat}»` : null,
    l.title_plat ? `disco: «${l.title_plat}»${l.year_plat ? ` (${l.year_plat})` : ""}` : null,
  ].filter(Boolean).join(" · ");
}

async function main(): Promise<void> {
  const files = readdirSync(DIR).filter((f) => f.startsWith("links-") && f.endsWith(".json")).sort();
  const identidad = new Map(jsonl<Identidad>(path.join(BASE, "identidad-mb.jsonl")).map((r) => [r.artistId, r]));
  const reeleccion = new Map(jsonl<Reeleccion>(path.join(BASE, "deezer-reeleccion.jsonl")).map((r) => [r.artistId, r]));
  const pool = getPool();

  const vivos = new Set<number>();
  for (const r of (await pool.query<{ id: string }>("SELECT id::text AS id FROM public.artists")).rows) vivos.add(Number(r.id));
  const albumDe = new Map<number, number>();
  for (const r of (await pool.query<{ id: string; artist_id: string }>("SELECT id::text AS id, artist_id::text AS artist_id FROM public.albums")).rows) {
    albumDe.set(Number(r.id), Number(r.artist_id));
  }

  const filas: Fila[] = [];
  const cuenta: Record<string, number> = {};
  const sumar = (k: string) => { cuenta[k] = (cuenta[k] ?? 0) + 1; };
  const vistos = new Set<string>();
  for (const f of files) {
    const d = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as ArtistFile;
    if (!vivos.has(d.artistId)) { sumar("saltado: artista ya no existe"); continue; }
    const re = reeleccion.get(d.artistId);
    const idn = identidad.get(d.artistId);

    // Discos: los de Deezer del perfil re-elegido sustituyen a los del original.
    let albumLinks = d.album_links;
    let artistLinks = d.artist_links;
    if (re?.perfil && re.comunes > 0) {
      albumLinks = [...d.album_links.filter((l) => l.platform !== "deezer"), ...re.album_links];
      artistLinks = [
        ...d.artist_links.filter((l) => !(l.platform === "deezer" && l.source === "deezer-search")),
        { platform: "deezer", url: re.perfil.url, id: re.perfil.id, method: re.perfil.method, source: "deezer-reeleccion", score: re.perfil.score, name_plat: re.perfil.name_plat },
      ];
      if (re.perfil.url !== d.artist_links.find((l) => l.platform === "deezer")?.url) sumar("deezer: perfil re-elegido");
    }
    const conDisco = (p: string) => albumLinks.some((l) => l.platform === p && albumDe.get(l.albumId) === d.artistId);
    const deezerOk = conDisco("deezer");
    const deezerConfirmado = deezerOk ? deezerId(artistLinks.find((l) => l.platform === "deezer")?.url ?? "") : null;
    const mbOk = (idn && MB_OK.has(idn.veredicto))
      || (deezerConfirmado !== null && deezerId(idn?.rels?.["deezer"] ?? "") === deezerConfirmado);
    const confirmadas = new Set<string>();

    const decidir = (l: Link): { ok: boolean; por: string } => {
      if (l.platform === "deezer" && l.source.startsWith("deezer")) return { ok: deezerOk, por: deezerOk ? "disco en común (Deezer)" : "sin disco en común" };
      if (l.platform === "apple_music" && l.source.startsWith("itunes")) return { ok: conDisco("apple_music"), por: conDisco("apple_music") ? "disco en común (Apple)" : "sin disco en común" };
      if (l.source === "musicbrainz-url-rels") {
        if (!idn) return { ok: false, por: "MB sin verificar" };
        return { ok: Boolean(mbOk), por: mbOk ? `MB ${idn.veredicto}${idn.pais ? ` (${idn.pais})` : ""}` : `MB ${idn.veredicto}${idn.pais ? ` (${idn.pais})` : ""}` };
      }
      if (l.source === "spotify-search") return { ok: l.method === "exact" && (conDisco("spotify") || Boolean(mbOk)), por: "Spotify por nombre" };
      return { ok: false, por: `${l.source}: sin cruce` };
    };
    const pendientesWd: Link[] = [];
    for (const l of artistLinks) {
      if (l.source.startsWith("wikidata")) { pendientesWd.push(l); continue; }
      const { ok, por } = decidir(l);
      if (ok) confirmadas.add(l.url);
      empujar(l, ok, por);
    }
    // Wikidata: solo vale si repite un enlace ya confirmado por otra vía.
    for (const l of pendientesWd) empujar(l, confirmadas.has(l.url), confirmadas.has(l.url) ? "Wikidata coincide con enlace confirmado" : "Wikidata sin cruce");

    for (const l of albumLinks) {
      const dueno = albumDe.get(l.albumId);
      if (dueno === undefined || dueno !== d.artistId) { sumar("saltado: disco movido de artista"); continue; }
      const key = `d:${l.albumId}:${l.platform}`;
      if (vistos.has(key)) { sumar("saltado: duplicado interno"); continue; }
      vistos.add(key);
      const ok = l.method === "exact" || (l.score ?? 0) >= 0.98;
      filas.push({ tabla: "streaming", albumId: l.albumId, platform: l.platform, url: l.url, externalId: l.id != null ? String(l.id) : null,
        handle: null, method: l.method, source: l.source, verified: ok, nota: nota(l, [ok ? "título casado" : "título parecido (revisar)"]), quien: d.name });
    }

    function empujar(l: Link, ok: boolean, por: string): void {
      const social = SOCIAL[l.platform];
      const platform = social ?? l.platform;
      const key = `a:${d.artistId}:${social ? "s" : "p"}:${platform}`;
      if (vistos.has(key)) { sumar("saltado: duplicado interno"); return; }
      vistos.add(key);
      filas.push({ tabla: social ? "social" : "streaming", artistId: d.artistId, platform, url: l.url,
        externalId: l.id != null ? String(l.id) : null, handle: social ? handleOf(l.url) : null,
        method: l.method, source: l.source.slice(0, 40), verified: ok, nota: nota(l, [por]), quien: d.name });
    }
  }

  const resumen: Record<string, { total: number; verificados: number }> = {};
  for (const f of filas) {
    const k = `${f.tabla}:${f.artistId ? "artista" : "disco"}:${f.platform}`;
    resumen[k] ??= { total: 0, verificados: 0 };
    resumen[k].total++;
    if (f.verified) resumen[k].verificados++;
  }
  const artistasConVisibles = new Set(filas.filter((f) => f.verified && f.artistId).map((f) => f.artistId)).size;
  console.log(`archivos ${files.length} · filas ${filas.length} · verificadas ${filas.filter((f) => f.verified).length} · artistas con algo visible ${artistasConVisibles}`);
  console.log(`identidad MB: ${identidad.size} artistas revisados · re-elección Deezer: ${reeleccion.size}`);
  for (const [k, v] of Object.entries(resumen).sort()) console.log(`  ${k.padEnd(34)} ${String(v.total).padStart(5)} · verificados ${v.verificados}`);
  for (const [k, v] of Object.entries(cuenta)) console.log(`  ${k}: ${v}`);

  if (!confirm) {
    writeFileSync(path.join(BASE, "aplicacion-ensayo.json"), JSON.stringify({ filas: filas.length, resumen, cuenta, artistasConVisibles }, null, 2));
    console.log("dry-run: ejecuta con --confirm");
    await closeDb();
    return;
  }

  const { runId, result } = await withOperatorRun({
    name: "claude-code:streaming-social-links",
    operator: "claude-code (delegado por Brian)",
    note: "Enlaces de escucha (streaming_links) y redes sociales (social_links) de la campaña de enlaces; verified solo con identidad confirmada (país/área de MusicBrainz o disco en común). Brian 2026-10-05.",
  }, async (context) => {
    let nuevos = 0, actualizados = 0;
    // Las redes que el piloto dejó en streaming_links pasan a su tabla.
    await context.client.query("DELETE FROM public.streaming_links WHERE platform IN ('twitter','x','facebook','instagram','tiktok','threads','bluesky')");
    for (const f of filas) {
      const sql = f.tabla === "social"
        ? `INSERT INTO public.social_links(artist_id, platform, url, handle, method, source, verified, notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (artist_id, platform) DO UPDATE SET url=EXCLUDED.url, handle=EXCLUDED.handle, method=EXCLUDED.method,
             source=EXCLUDED.source, verified=EXCLUDED.verified, notes=EXCLUDED.notes
           WHERE (social_links.url, social_links.verified) IS DISTINCT FROM (EXCLUDED.url, EXCLUDED.verified)
           RETURNING (xmax = 0) AS nuevo`
        : `INSERT INTO public.streaming_links(artist_id, album_id, platform, url, external_id, method, source, verified, notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (${f.artistId ? "artist_id" : "album_id"}, platform) WHERE ${f.artistId ? "artist_id" : "album_id"} IS NOT NULL
           DO UPDATE SET url=EXCLUDED.url, external_id=EXCLUDED.external_id, method=EXCLUDED.method,
             source=EXCLUDED.source, verified=EXCLUDED.verified, notes=EXCLUDED.notes
           WHERE (streaming_links.url, streaming_links.verified) IS DISTINCT FROM (EXCLUDED.url, EXCLUDED.verified)
           RETURNING (xmax = 0) AS nuevo`;
      const params = f.tabla === "social"
        ? [f.artistId, f.platform, f.url, f.handle, f.method, f.source, f.verified, f.nota || null]
        : [f.artistId ?? null, f.albumId ?? null, f.platform, f.url, f.externalId, f.method, f.source, f.verified, f.nota || null];
      const { rows } = await context.client.query<{ nuevo: boolean }>(sql, params);
      if (rows[0]?.nuevo) nuevos++; else if (rows[0]) actualizados++;
    }
    return { nuevos, actualizados };
  });

  writeFileSync(`reports/apply-streaming-links-run${runId}.json`, JSON.stringify({
    runId, dir: DIR, filas: filas.length, ...result, resumen, cuenta, artistasConVisibles,
  }, null, 2));
  console.log(`run ${runId}: ${result.nuevos} nuevos · ${result.actualizados} actualizados (de ${filas.length})`);
  await closeDb();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
