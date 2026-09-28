// CRV · Evidencia de género de disco en Bandcamp, Deezer e iTunes.
//
// Para los discos sin principal confirmado o cuyo principal lo predijo Laya
// (una fuente la reemplaza: regla de Brian del 2026-09-27; por defecto, los
// que tienen video en el canal: la radio depende de ellos) busca la ficha del mismo disco en las
// tres tiendas y escribe libros de evidencia que `apply-source-genres.ts`
// confirma (regla de Brian del 2026-09-26: una fuente basta).
//
// Lo único que se exige es la identidad: artista y título iguales tras
// normalizar, y además una prueba independiente —año a ±1 o dos pistas en
// común (una, si el disco tiene una sola)—. Sin prueba, el disco va al libro de
// rechazos con el motivo. Nunca escribe en la base.
//
//   npx tsx scripts/harvest-streaming-album-genres.ts [--scope=channel|all] [--only=bandcamp,deezer,itunes] [--ids=1,2]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { bareTitle, contact, getJson, norm, sleep, STORE_NOT_GENRE, yearOf } from "./lib/store-api.js";

const DATE = "2026-09-27";

interface Album { id: number; artist: string; title: string; year: number | null; tracks: string[] }
interface Found { source: string; url: string; externalTitle: string; year: number | null; tracks: string[]; genres: string[] }
interface Verdict { ok: boolean; proof: string }

const argOf = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Lo que se lee de cada API; todo opcional porque las respuestas no traen esquema. */
interface BandcampSearch { auto?: { results?: Array<{ band_name?: string; name?: string; item_url_path?: string }> } }
interface BandcampLd { datePublished?: string; track?: { itemListElement?: Array<{ item?: { name?: string } }> } }
interface DeezerSearch { data?: Array<{ id: number; title?: string; artist?: { name?: string } }> }
interface DeezerAlbum { link?: string; title?: string; release_date?: string; tracks?: { data?: Array<{ title?: string }> }; genres?: { data?: Array<{ name?: string }> } }
interface ItunesRow {
  wrapperType?: string; artistName?: string; collectionName?: string; collectionViewUrl?: string; releaseDate?: string;
  primaryGenreName?: string; collectionId?: number; trackName?: string;
}
interface ItunesResults { results?: ItunesRow[] }

function sameRecord(album: Album, artistName: string, title: string): boolean {
  return norm(artistName) === norm(album.artist) && bareTitle(title) === bareTitle(album.title) && bareTitle(title) !== "";
}

/** La prueba independiente del nombre: año cercano o pistas en común. */
function verdict(album: Album, found: Found): Verdict {
  const ours = new Set(album.tracks.map(bareTitle).filter(Boolean));
  const shared = found.tracks.map(bareTitle).filter((title) => ours.has(title));
  const needed = Math.min(2, ours.size || 2);
  const detail = `año ${found.year ?? "?"} vs ${album.year ?? "?"}, ${shared.length} pistas en común`;
  // Dos listas de pistas conocidas que no comparten ninguna son dos discos distintos,
  // aunque el año cuadre (el «Numb» canadiense de 1997 frente al venezolano).
  if (ours.size >= 3 && found.tracks.length >= 3 && shared.length === 0) return { ok: false, proof: `pistas distintas; ${detail}` };
  if (shared.length >= needed) return { ok: true, proof: `${shared.length} pistas en común` };
  // En un disco homónimo el título no añade nada al nombre: el año solo no basta.
  if (bareTitle(album.title) === norm(album.artist)) return { ok: false, proof: `homónimo sin pistas en común; ${detail}` };
  if (album.year && found.year && Math.abs(album.year - found.year) <= 1) return { ok: true, proof: `año ${found.year}` };
  return { ok: false, proof: detail };
}

// --- Fuentes ---------------------------------------------------------------

async function bandcamp(album: Album): Promise<Found[]> {
  const search = await getJson<BandcampSearch>("https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ search_text: `${album.artist} ${album.title}`, search_filter: "a", full_page: false, fan_id: null }) });
  const hits = (search.auto?.results ?? [])
    .filter((hit) => sameRecord(album, String(hit.band_name ?? ""), String(hit.name ?? "")));
  const out: Found[] = [];
  for (const hit of hits.slice(0, 2)) {
    const url = String(hit.item_url_path);
    const html = await (await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": `CRV-generos/1.0 (${contact()})` } })).text();
    const ld = /<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/u.exec(html);
    let year: number | null = null;
    let tracks: string[] = [];
    if (ld) {
      try {
        const data = JSON.parse(ld[1]!) as BandcampLd;
        year = yearOf(data.datePublished);
        tracks = (data.track?.itemListElement ?? []).map((entry) => String(entry?.item?.name ?? "")).filter(Boolean);
      } catch { /* ficha sin JSON-LD legible: queda sin prueba */ }
    }
    // La última etiqueta de Bandcamp es el lugar; las que repiten banda o disco no son género.
    const tags = [...html.matchAll(/<a class="tag"[^>]*>([^<]+)<\/a>/gu)].map((match) => match[1]!.trim())
      .filter((tag) => ![norm(album.artist), norm(album.title)].includes(norm(tag)));
    out.push({ source: "bandcamp", url, externalTitle: String(hit.name), year, tracks, genres: tags });
    await sleep(800);
  }
  // La búsqueda también cuenta para su límite (429 a ~1 petición/s sostenida).
  await sleep(2000);
  return out;
}

async function deezer(album: Album): Promise<Found[]> {
  const queries = [`artist:"${album.artist}" album:"${album.title}"`, `${album.artist} ${album.title}`];
  const seen = new Set<number>();
  const out: Found[] = [];
  for (const query of queries) {
    const search = await getJson<DeezerSearch>(`https://api.deezer.com/search/album?q=${encodeURIComponent(query)}`, { headers: { "Accept-Language": "en" } });
    for (const hit of search.data ?? []) {
      if (seen.has(hit.id) || !sameRecord(album, String(hit.artist?.name ?? ""), String(hit.title ?? ""))) continue;
      seen.add(hit.id);
      const full = await getJson<DeezerAlbum>(`https://api.deezer.com/album/${hit.id}`, { headers: { "Accept-Language": "en" } });
      out.push({ source: "deezer", url: String(full.link ?? `https://www.deezer.com/album/${hit.id}`), externalTitle: String(full.title),
        year: yearOf(full.release_date), tracks: (full.tracks?.data ?? []).map((track) => String(track.title ?? "")),
        genres: (full.genres?.data ?? []).map((genre) => String(genre.name ?? "")).filter(Boolean) });
      await sleep(250);
    }
    if (out.length) break;
    await sleep(250);
  }
  return out;
}

async function itunes(album: Album): Promise<Found[]> {
  const out: Found[] = [];
  for (const country of ["US", "VE"]) {
    const url = new URL("https://itunes.apple.com/search");
    for (const [key, value] of Object.entries({ term: `${album.artist} ${album.title}`, media: "music", entity: "album", country, limit: "50" }))
      url.searchParams.set(key, value);
    const search = await getJson<ItunesResults>(url.toString());
    for (const hit of search.results ?? []) {
      if (!sameRecord(album, String(hit.artistName ?? ""), String(hit.collectionName ?? ""))) continue;
      const found: Found = { source: "itunes", url: String(hit.collectionViewUrl), externalTitle: String(hit.collectionName),
        year: yearOf(hit.releaseDate), tracks: [], genres: [String(hit.primaryGenreName ?? "")].filter(Boolean) };
      // Las pistas cuestan otra petición, pero son la prueba que desmiente un homónimo.
      await sleep(3500);
      const lookup = await getJson<ItunesResults>(`https://itunes.apple.com/lookup?id=${hit.collectionId}&entity=song&country=${country}`);
      found.tracks = (lookup.results ?? []).filter((row) => row.wrapperType === "track").map((row) => String(row.trackName ?? ""));
      out.push(found);
    }
    await sleep(3500);
    if (out.length) break;
  }
  return out;
}

const SOURCES: Record<string, (album: Album) => Promise<Found[]>> = { bandcamp, deezer, itunes };

// --- Recorrido -------------------------------------------------------------

async function loadAlbums(scope: string, ids: number[]): Promise<Album[]> {
  const client = await getPool().connect();
  try {
    const channelFilter = scope === "all" ? "" : `AND EXISTS (
      SELECT 1 FROM media.video_albums va JOIN media.youtube_videos yv ON yv.id=va.video_id
        JOIN media.youtube_channel_uploads u ON u.video_id=yv.video_id WHERE va.album_id=a.id)`;
    const rows = await client.query<{ id: string; artist: string; title: string; year: number | null; tracks: string[] | null }>(`
      SELECT a.id::text, ar.name AS artist, a.title, a.release_year AS year,
             (SELECT array_agg(t.title ORDER BY t.disc_number, t.track_number) FROM public.tracks t WHERE t.album_id=a.id) AS tracks
        FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
       WHERE (a.id = ANY($1::bigint[]) OR (cardinality($1::bigint[]) = 0
              AND NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=a.id AND g.role='primary' AND g.status='confirmed'
                                AND g.decided_by<>'auto:laya')))
         AND ar.name !~* '^(various artists|varios artistas|v\\.?a\\.?)$'
         ${channelFilter}
       ORDER BY a.id`, [ids]);
    return rows.rows.map((row) => ({ id: Number(row.id), artist: row.artist, title: row.title, year: row.year, tracks: row.tracks ?? [] }));
  } finally {
    client.release();
  }
}

async function harvest(source: string, albums: Album[]): Promise<void> {
  const ledger = `reports/genre-laya-evidence-${source}-albums-${DATE}.jsonl`;
  const rejected = `reports/genre-laya-evidence-${source}-albums-rejected-${DATE}.jsonl`;
  const done = new Set<string>();
  for (const path of [ledger, rejected]) if (existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) done.add((JSON.parse(line) as { caseId: string }).caseId);
  let accepted = 0;
  let refused = 0;
  for (const album of albums) {
    const caseId = `album:${album.id}`;
    if (done.has(caseId)) continue;
    let found: Found[];
    try {
      found = await SOURCES[source]!(album);
    } catch (error) {
      // Un fallo de red no se anota: la próxima pasada lo reintenta.
      console.warn(`${source} ${caseId}: ${(error as Error).message}`);
      await sleep(5000);
      continue;
    }
    const judged = found.map((item) => ({ item, verdict: verdict(album, item),
      genres: item.genres.filter((genre) => !STORE_NOT_GENRE.has(norm(genre))) }));
    const best = judged.find((entry) => entry.verdict.ok && entry.genres.length);
    if (best) {
      appendFileSync(ledger, JSON.stringify({ caseId, kind: "album", entityId: album.id, source, url: best.item.url,
        title: `${album.artist} — ${album.title}`, rawGenres: best.genres,
        evidence: { externalTitle: best.item.externalTitle, year: best.item.year, proof: best.verdict.proof, allTags: best.item.genres } }) + "\n");
      accepted += 1;
    } else {
      const reason = !found.length ? "sin ficha con el mismo artista y título"
        : judged.some((entry) => entry.verdict.ok) ? "identificada pero sin género utilizable"
          : "sin prueba independiente de identidad";
      appendFileSync(rejected, JSON.stringify({ caseId, kind: "album", entityId: album.id, source,
        title: `${album.artist} — ${album.title}`, reason,
        candidates: judged.map((entry) => ({ url: entry.item.url, proof: entry.verdict.proof, genres: entry.item.genres })) }) + "\n");
      refused += 1;
    }
  }
  console.log(`${source}: ${accepted} con género, ${refused} sin él (esta pasada) → ${ledger}`);
}

async function main(): Promise<void> {
  if (!contact()) throw new Error("falta GENRES_EXTERNAL_CONTACT en .env");
  const scope = argOf("scope") ?? "channel";
  const only = (argOf("only") ?? Object.keys(SOURCES).join(",")).split(",");
  // `--ids=1,2` reverifica esos discos aunque ya tengan principal (p. ej. tras endurecer la identidad).
  const ids = (argOf("ids") ?? "").split(",").filter(Boolean).map(Number);
  const albums = await loadAlbums(scope, ids);
  await closeDb();
  console.log(`${albums.length} discos sin principal confirmado o con el de Laya (alcance ${scope})`);
  // Las fuentes son independientes: cada una a su ritmo, en paralelo.
  await Promise.all(only.map((source) => harvest(source, albums)));
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
