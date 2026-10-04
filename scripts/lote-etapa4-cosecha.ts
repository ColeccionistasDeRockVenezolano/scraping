// CRV · Etapa 4 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3):
// cosecha para completar fichas. NO escribe en la base.
//
// Universo: los discos de las fichas de los lotes 1 y 2 (las de la cosecha de
// la etapa 3 más los compositores, que solo buscan foto). Por disco:
//
//   · Identidad en las plataformas. Los discos creados en la etapa 3 traen sus
//     ids en los claims (`etapa3:<plataforma>:<id>`). Los que ya existían se
//     buscan por título normalizado en la discografía de la ficha que la
//     etapa 3 ya verificó (release groups de MusicBrainz y discos de Deezer
//     firmados como artista principal); un empate entre homónimos del mismo
//     título se resuelve por año (±1) o queda sin identidad.
//   · Pistas y duraciones (discos sin pistas o con pistas sin duración):
//     MusicBrainz primero (la edición oficial más antigua con pistas), luego
//     Deezer, iTunes y Discogs. Como último recurso, iTunes por búsqueda con
//     artista y título idénticos.
//   · Portadas: Deezer (cover_xl), Cover Art Archive (frente aprobado del
//     release group), iTunes (artwork a 1000 px) y Discogs.
//   · Sellos: solo MusicBrainz y Discogs (plan §3, etapa 4), de la misma
//     edición que da las pistas o de la oficial más antigua con sello.
//   · Fotos de artista: Wikidata (P18, enlazada desde MusicBrainz), Discogs
//     (enlazado desde MusicBrainz) y Deezer (la página verificada en la etapa 3).
//
// Respuestas HTTP en data/raw/etapa4-completar/ (fuera de git); se reanuda sola.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-cosecha.ts [--artists=id,…] [--no-itunes-search]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { closeDb, getPool } from "../src/db/client.js";
import { compareKey } from "../src/ingest/lote-investigacion.js";
import { titleKey, type DeezerAlbum, type ReleaseGroup } from "./lote-etapa3-comun.js";

loadDotenv();
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const OUT_FILE = `${OUT_DIR}/etapa4-cosecha.json`;
const HARVEST3 = `${OUT_DIR}/etapa3-cosecha.json`;
const CACHE_DIR = "data/raw/etapa4-completar";
const CACHE3_DIR = "data/raw/etapa3-discografias";
const USER_AGENT = "CRV-completar/1.0 (+coleccionistasderockvenezolano.com)";
const ONLY_ARTISTS = process.argv.find((arg) => arg.startsWith("--artists="))?.slice("--artists=".length).split(",").map(Number);
const ITUNES_SEARCH = !process.argv.includes("--no-itunes-search");
const DISCOGS_TOKEN = process.env["DISCOGS_TOKEN"]?.trim();
/** MusicBrainz marca así las ediciones sin sello. */
const NO_LABEL = new Set(["157afde4-4bf5-4039-8ad2-5a15acc85176"]);

// --- HTTP con caché ------------------------------------------------------------

type Service = "musicbrainz" | "deezer" | "itunes" | "discogs" | "caa" | "wikidata";
const GAP_MS: Record<Service, number> = { musicbrainz: 1100, deezer: 120, itunes: 3100, discogs: 1100, caa: 300, wikidata: 300 };
const lastCall: Partial<Record<Service, number>> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheFile = (dir: string, service: string, url: string) => path.join(dir, `${service}-${createHash("sha1").update(url).digest("hex")}.json`);

/** null = la plataforma dice que no existe (404). */
async function getJson<T>(service: Service, url: string): Promise<T | null> {
  mkdirSync(CACHE_DIR, { recursive: true });
  // La etapa 3 ya guardó las fichas de disco de Deezer y las búsquedas.
  for (const dir of [CACHE_DIR, CACHE3_DIR]) {
    const file = cacheFile(dir, service, url);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T | null;
  }
  const file = cacheFile(CACHE_DIR, service, url);
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
  if (service === "discogs" && DISCOGS_TOKEN) headers["authorization"] = `Discogs token=${DISCOGS_TOKEN}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = (lastCall[service] ?? 0) + GAP_MS[service] - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[service] = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt < 4) { await sleep(3_000 * (attempt + 1)); continue; }
      throw error;
    }
    if (response.status === 404) { writeFileSync(file, "null"); return null; }
    if ([403, 429, 500, 502, 503, 504].includes(response.status) && attempt < 4) { await sleep(5_000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`${service} HTTP ${response.status} ${url}`);
    const body = (await response.json()) as T & { error?: { code?: number } };
    if (service === "deezer" && body.error) {
      if (body.error.code === 4 && attempt < 4) { await sleep(5_000 * (attempt + 1)); continue; }
      if (body.error.code === 800) { writeFileSync(file, "null"); return null; }
      throw new Error(`deezer ${JSON.stringify(body.error)} ${url}`);
    }
    writeFileSync(file, JSON.stringify(body));
    return body;
  }
  throw new Error(`${service}: sin respuesta ${url}`);
}

// --- Tipos de salida --------------------------------------------------------------

export interface HarvestTrack { disc: number; position: number; title: string; seconds: number | null }
export interface Tracklist { source: Platform; url: string; externalTitle: string; via: string; tracks: HarvestTrack[] }
export interface Cover { source: Platform; url: string; page: string; via: string }
export interface Label { source: "musicbrainz" | "discogs"; name: string; url: string; externalId: string; via: string; catalogNumber: string | null }
export interface AlbumHarvest {
  albumId: number; artistId: number; artist: string; title: string; year: number | null;
  current: { tracks: number; missingDurations: number; cover: boolean; label: boolean };
  refs: Array<{ platform: Platform; id: string; via: string }>;
  tracklists: Tracklist[]; covers: Cover[]; labels: Label[]; notes: string[];
}
export interface PhotoHarvest { source: "wikidata" | "discogs" | "deezer"; url: string; page: string; via: string }
export interface ArtistHarvest { artistId: number; artist: string; loteId: string; hasPicture: boolean; photos: PhotoHarvest[]; notes: string[] }
type Platform = "musicbrainz" | "deezer" | "itunes" | "discogs" | "itunes-busqueda";

// --- Plataformas -------------------------------------------------------------------

interface MbRelease {
  id: string; title: string; status?: string; date?: string; country?: string;
  "label-info"?: Array<{ "catalog-number"?: string | null; label?: { id: string; name: string } | null }>;
  media?: Array<{ position?: number; format?: string | null; tracks?: Array<{ position: number; number?: string; title: string; length?: number | null }> }>;
}

/** Ediciones oficiales primero, la más antigua antes; las sin fecha al final. */
function releaseOrder(a: MbRelease, b: MbRelease): number {
  const official = (release: MbRelease) => (release.status === "Official" ? 0 : 1);
  const date = (release: MbRelease) => release.date || "9999";
  return official(a) - official(b) || date(a).localeCompare(date(b));
}

async function mbReleases(groupId: string): Promise<MbRelease[]> {
  const out: MbRelease[] = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const page = await getJson<{ releases: MbRelease[]; "release-count": number }>("musicbrainz",
      `https://musicbrainz.org/ws/2/release?release-group=${groupId}&inc=labels+recordings+media&fmt=json&limit=100&offset=${offset}`);
    if (!page) break;
    out.push(...page.releases);
    if (offset + 100 >= page["release-count"]) break;
  }
  return out.sort(releaseOrder);
}

async function fromMusicBrainz(album: AlbumHarvest, groupId: string, via: string, wantTracks: boolean, wantLabel: boolean, wantCover: boolean): Promise<void> {
  if (wantTracks || wantLabel) {
    const releases = await mbReleases(groupId);
    // Medios de vídeo: no son pistas del disco.
    const audio = (release: MbRelease) => (release.media ?? []).filter((medium) => !/dvd|blu-ray|vhs|video/i.test(medium.format ?? ""));
    const withTracks = releases.find((release) => audio(release).some((medium) => (medium.tracks ?? []).length > 0));
    if (wantTracks && withTracks) {
      const tracks: HarvestTrack[] = [];
      audio(withTracks).forEach((medium, index) => {
        for (const track of medium.tracks ?? []) {
          tracks.push({ disc: index + 1, position: track.position, title: track.title, seconds: track.length ? Math.round(track.length / 1000) : null });
        }
      });
      album.tracklists.push({ source: "musicbrainz", url: `https://musicbrainz.org/release/${withTracks.id}`, externalTitle: withTracks.title, via, tracks });
    }
    if (wantLabel) {
      // El sello de la edición que da las pistas; si no lo tiene, el de la oficial más antigua con sello.
      const pick = [withTracks, ...releases].filter((release): release is MbRelease => !!release)
        .flatMap((release) => (release["label-info"] ?? []).map((info) => ({ release, info })))
        .find(({ info }) => info.label && !NO_LABEL.has(info.label.id));
      if (pick) {
        album.labels.push({
          source: "musicbrainz", name: pick.info.label!.name, url: `https://musicbrainz.org/release/${pick.release.id}`,
          externalId: pick.info.label!.id, via, catalogNumber: pick.info["catalog-number"] ?? null,
        });
      }
    }
  }
  if (wantCover) {
    const art = await getJson<{ images?: Array<{ front?: boolean; approved?: boolean; image?: string; thumbnails?: Record<string, string> }> }>(
      "caa", `https://coverartarchive.org/release-group/${groupId}`);
    const front = art?.images?.find((image) => image.front && image.approved !== false);
    const url = front?.thumbnails?.["1200"] ?? front?.thumbnails?.["large"] ?? front?.image;
    if (url) album.covers.push({ source: "musicbrainz", url: url.replace(/^http:/, "https:"), page: `https://musicbrainz.org/release-group/${groupId}`, via });
  }
}

interface DzFull { id: number; title?: string; link?: string; label?: string; cover_xl?: string; md5_image?: string }
interface DzTracks { data?: Array<{ title: string; duration?: number; track_position?: number; disk_number?: number }>; total?: number }

async function fromDeezer(album: AlbumHarvest, deezerId: string, via: string, wantTracks: boolean, wantCover: boolean): Promise<void> {
  const full = await getJson<DzFull>("deezer", `https://api.deezer.com/album/${deezerId}`);
  if (!full) { album.notes.push(`deezer ${deezerId}: ya no existe`); return; }
  const page = full.link ?? `https://www.deezer.com/album/${deezerId}`;
  // Deezer devuelve una imagen genérica cuando el disco no tiene portada (md5 vacío).
  if (wantCover && full.cover_xl && full.md5_image && !/\/cover\/\//.test(full.cover_xl)) {
    album.covers.push({ source: "deezer", url: full.cover_xl, page, via });
  }
  if (wantTracks) {
    const tracks = await getJson<DzTracks>("deezer", `https://api.deezer.com/album/${deezerId}/tracks?limit=500`);
    const rows = tracks?.data ?? [];
    if (rows.length) {
      album.tracklists.push({
        source: "deezer", url: page, externalTitle: full.title ?? "", via,
        tracks: rows.map((row, index) => ({ disc: row.disk_number ?? 1, position: row.track_position ?? index + 1, title: row.title, seconds: row.duration || null })),
      });
    }
  }
}

interface ItunesRow {
  wrapperType?: string; kind?: string; artistName?: string; collectionName?: string; collectionId?: number; collectionViewUrl?: string;
  artworkUrl100?: string; trackName?: string; trackNumber?: number; discNumber?: number; trackTimeMillis?: number; releaseDate?: string;
}

async function fromItunes(album: AlbumHarvest, collectionId: string, via: string, wantTracks: boolean, wantCover: boolean, platform: Platform = "itunes"): Promise<void> {
  let rows: ItunesRow[] = [];
  for (const country of ["VE", "US"]) {
    rows = (await getJson<{ results?: ItunesRow[] }>("itunes", `https://itunes.apple.com/lookup?id=${collectionId}&entity=song&country=${country}`))?.results ?? [];
    if (rows.length) break;
  }
  const collection = rows.find((row) => row.wrapperType === "collection");
  if (!collection) { album.notes.push(`itunes ${collectionId}: sin ficha`); return; }
  const page = collection.collectionViewUrl ?? `https://music.apple.com/album/${collectionId}`;
  if (wantCover && collection.artworkUrl100) {
    album.covers.push({ source: platform, url: collection.artworkUrl100.replace(/\/\d+x\d+bb\./, "/1000x1000bb."), page, via });
  }
  const songs = rows.filter((row) => row.wrapperType === "track" && row.kind === "song");
  if (wantTracks && songs.length) {
    album.tracklists.push({
      source: platform, url: page, externalTitle: collection.collectionName ?? "", via,
      tracks: songs.map((row, index) => ({ disc: row.discNumber ?? 1, position: row.trackNumber ?? index + 1, title: row.trackName ?? "", seconds: row.trackTimeMillis ? Math.round(row.trackTimeMillis / 1000) : null })),
    });
  }
}

interface DiscogsRelease {
  id: number; title: string; uri?: string; main_release?: number;
  labels?: Array<{ id: number; name: string; catno?: string }>;
  images?: Array<{ type?: string; uri?: string }>;
  tracklist?: Array<{ position?: string; type_?: string; title: string; duration?: string }>;
}

const discogsSeconds = (value: string | undefined) => {
  const match = /^(\d{1,3}):(\d{2})$/.exec(value?.trim() ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

async function fromDiscogs(album: AlbumHarvest, ref: string, via: string, wantTracks: boolean, wantLabel: boolean, wantCover: boolean): Promise<void> {
  if (!DISCOGS_TOKEN) return;
  // La referencia de la etapa 3 es «master/123» o «release/123» (de la URL de evidencia).
  const [kind, id] = ref.split("/");
  const found = await getJson<DiscogsRelease>("discogs", `https://api.discogs.com/${kind === "master" ? "masters" : "releases"}/${id}`);
  if (!found) return;
  let release: DiscogsRelease = found;
  const page = `https://www.discogs.com/${kind}/${id}`;
  if (kind === "master" && found.main_release && (wantLabel || !found.tracklist?.length)) {
    const main = await getJson<DiscogsRelease>("discogs", `https://api.discogs.com/releases/${found.main_release}`);
    // Del master: imagen y lista si las tiene; de la edición principal: el sello.
    if (main) release = { ...main, ...(found.images?.length ? { images: found.images } : {}), ...(found.tracklist?.length ? { tracklist: found.tracklist } : {}) };
  }
  const image = release.images?.find((row) => row.type === "primary") ?? release.images?.[0];
  if (wantCover && image?.uri) album.covers.push({ source: "discogs", url: image.uri, page, via });
  const label = release.labels?.find((row) => !/^not on label/i.test(row.name));
  if (wantLabel && label) {
    album.labels.push({ source: "discogs", name: label.name.replace(/\s*\(\d+\)$/, ""), url: page, externalId: String(label.id), via, catalogNumber: label.catno && label.catno !== "none" ? label.catno : null });
  }
  const tracks = (release.tracklist ?? []).filter((row) => (row.type_ ?? "track") === "track");
  if (wantTracks && tracks.length) {
    // Posiciones de vinilo (A1, B2) o de CD (1-3): el disco sale del prefijo numérico; el orden, de la lista.
    let disc = 1;
    let position = 0;
    const out: HarvestTrack[] = [];
    for (const row of tracks) {
      const cd = /^(\d+)[-.](\d+)$/.exec(row.position ?? "");
      if (cd && Number(cd[1]) !== disc) { disc = Number(cd[1]); position = 0; }
      position += 1;
      out.push({ disc, position, title: row.title, seconds: discogsSeconds(row.duration) });
    }
    album.tracklists.push({ source: "discogs", url: page, externalTitle: release.title, via, tracks: out });
  }
}

async function itunesSearch(album: AlbumHarvest, names: string[]): Promise<string | null> {
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: `${names[0]} ${album.title}`, media: "music", entity: "album", limit: "25", country: "VE" })}`;
  const rows = (await getJson<{ results?: ItunesRow[] }>("itunes", url))?.results ?? [];
  const keys = names.map(compareKey);
  const hits = rows.filter((row) => keys.includes(compareKey(row.artistName ?? "")) && titleKey((row.collectionName ?? "").replace(/\s+-\s+(Single|EP)$/, "")) === titleKey(album.title));
  // Si el disco tiene año, la búsqueda solo vale con el año ±1; dos fichas distintas que encajan = ambiguo.
  const dated = album.year === null ? hits : hits.filter((row) => {
    const year = Number(String(row.releaseDate ?? "").slice(0, 4));
    return !year || Math.abs(year - album.year!) <= 1;
  });
  if (dated.length !== 1) {
    if (dated.length > 1) album.notes.push(`itunes búsqueda: ${dated.length} candidatos, ambiguo`);
    return null;
  }
  return String(dated[0]!.collectionId);
}

// --- Fotos de artista ---------------------------------------------------------------

async function artistPhotos(artist: ArtistHarvest, mbid: string | undefined, deezerId: number | undefined): Promise<void> {
  if (mbid) {
    const mb = await getJson<{ relations?: Array<{ type: string; url?: { resource: string } }> }>("musicbrainz",
      `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`);
    const relations = mb?.relations ?? [];
    const wikidata = relations.find((row) => row.type === "wikidata")?.url?.resource;
    const qid = wikidata ? /(Q\d+)$/.exec(wikidata)?.[1] : undefined;
    if (qid) {
      const entity = await getJson<{ entities?: Record<string, { claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> } }> }>(
        "wikidata", `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
      const file = entity?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (file) {
        artist.photos.push({
          source: "wikidata", url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=1200`,
          page: `https://www.wikidata.org/wiki/${qid}`, via: `MusicBrainz ${mbid} → ${qid}`,
        });
      }
    }
    const discogs = relations.find((row) => row.type === "discogs")?.url?.resource;
    const discogsId = discogs ? /artist\/(\d+)/.exec(discogs)?.[1] : undefined;
    if (discogsId && DISCOGS_TOKEN) {
      const body = await getJson<{ images?: Array<{ type?: string; uri?: string }> }>("discogs", `https://api.discogs.com/artists/${discogsId}`);
      const image = body?.images?.find((row) => row.type === "primary") ?? body?.images?.[0];
      if (image?.uri) artist.photos.push({ source: "discogs", url: image.uri, page: `https://www.discogs.com/artist/${discogsId}`, via: `MusicBrainz ${mbid} → Discogs ${discogsId}` });
    }
  }
  if (deezerId) {
    const body = await getJson<{ picture_xl?: string; link?: string; nb_album?: number }>("deezer", `https://api.deezer.com/artist/${deezerId}`);
    // Sin foto, Deezer devuelve la silueta genérica: su ruta no lleva hash («/artist//»).
    if (body?.picture_xl && !/\/artist\/\//.test(body.picture_xl)) {
      artist.photos.push({ source: "deezer", url: body.picture_xl, page: body.link ?? `https://www.deezer.com/artist/${deezerId}`, via: `Deezer ${deezerId} (identidad de la etapa 3)` });
    }
  }
}

// --- Principal -------------------------------------------------------------------------

interface Harvest3Artist {
  loteId: string; artistId: number; artistName: string; aliases: string[];
  musicbrainz: { status: string; mbid?: string; releaseGroups?: ReleaseGroup[] };
  deezer: { status: string; deezerId?: number; albums?: DeezerAlbum[] };
}

async function liveArtist(id: number): Promise<number | null> {
  let current = id;
  for (let hop = 0; hop < 10; hop += 1) {
    const next = await getPool().query<{ to_id: string }>(
      "SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind='artist' AND from_id=$1 ORDER BY created_at DESC LIMIT 1", [current]);
    if (!next.rowCount) break;
    current = Number(next.rows[0]!.to_id);
  }
  return (await getPool().query("SELECT 1 FROM public.artists WHERE id=$1", [current])).rowCount ? current : null;
}

const yearOf = (date: string | null | undefined) => {
  const year = Number(String(date ?? "").slice(0, 4));
  return Number.isInteger(year) && year >= 1900 ? year : null;
};

/** El único candidato del mismo título, o el que cae en el año del disco (±1). */
function pickByTitle<T>(album: { title: string; year: number | null }, rows: T[], title: (row: T) => string, year: (row: T) => number | null): { row: T | null; why: string } {
  const key = titleKey(album.title);
  const same = rows.filter((row) => key && titleKey(title(row)) === key);
  if (same.length === 0) return { row: null, why: "sin título igual" };
  if (same.length === 1) return { row: same[0]!, why: "título igual" };
  if (album.year !== null) {
    const dated = same.filter((row) => year(row) !== null && Math.abs(year(row)! - album.year!) <= 1);
    if (dated.length === 1) return { row: dated[0]!, why: "título igual y año ±1" };
  }
  return { row: null, why: `${same.length} candidatos con el mismo título` };
}

async function main(): Promise<void> {
  const harvest3 = JSON.parse(readFileSync(HARVEST3, "utf8")) as { artists: Harvest3Artist[] };
  const stage2 = (JSON.parse(readFileSync(`${OUT_DIR}/etapa2-identidades.json`, "utf8")) as { identities: Record<string, { artistId: number | null }> }).identities;
  const byArtist = new Map<number, Harvest3Artist & { loteIds: string[] }>();
  for (const row of harvest3.artists) {
    const live = await liveArtist(row.artistId);
    if (live === null) continue;
    const previous = byArtist.get(live);
    byArtist.set(live, previous ? { ...previous, loteIds: [...previous.loteIds, row.loteId] } : { ...row, artistId: live, loteIds: [row.loteId] });
  }
  // Compositores y demás fichas de la etapa 2 que la etapa 3 no cosechó: solo foto.
  const extra = new Map<number, string>();
  for (const [loteId, identity] of Object.entries(stage2)) {
    if (!identity.artistId) continue;
    const live = await liveArtist(identity.artistId);
    if (live !== null && !byArtist.has(live)) extra.set(live, loteId);
  }
  const artistIds = [...byArtist.keys(), ...extra.keys()].filter((id) => !ONLY_ARTISTS || ONLY_ARTISTS.includes(id)).sort((a, b) => a - b);
  console.log(`${artistIds.length} fichas (${extra.size} sin cosecha de la etapa 3)`);

  const pool = getPool();
  const albumRows = (await pool.query<{ id: string; artist_id: string; artist: string; title: string; year: number | null; tracks: string; missing: string; cover: boolean; label: boolean }>(`
    SELECT al.id::text, al.artist_id::text, ar.name AS artist, al.title, al.release_year AS year,
           (SELECT count(*) FROM public.tracks t WHERE t.album_id=al.id)::text AS tracks,
           (SELECT count(*) FROM public.tracks t WHERE t.album_id=al.id AND t.duration_seconds IS NULL)::text AS missing,
           al.cover_url IS NOT NULL AS cover, al.label_id IS NOT NULL AS label
      FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
     WHERE al.artist_id = ANY($1::bigint[]) ORDER BY al.artist_id, al.id`, [artistIds])).rows;
  const refs = (await pool.query<{ album_id: string; identity_key: string; url: string | null }>(`
    SELECT DISTINCT c.album_id::text, c.identity_key, e.url
      FROM ingest.claims c LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id
     WHERE c.album_id = ANY($1::bigint[]) AND c.identity_key LIKE 'etapa3:%'`, [albumRows.map((row) => Number(row.id))])).rows;
  const refsByAlbum = new Map<number, Array<{ platform: Platform; id: string; via: string }>>();
  for (const row of refs) {
    const [, platform, id] = row.identity_key.split(":") as [string, Platform, string];
    // Discogs: la evidencia dice si el id es de un master o de una edición.
    const ref = platform === "discogs" ? (/\/(master|release)\/(\d+)/.exec(row.url ?? "")?.slice(1, 3).join("/") ?? `master/${id}`) : id;
    const list = refsByAlbum.get(Number(row.album_id)) ?? [];
    if (!list.some((item) => item.platform === platform && item.id === ref)) list.push({ platform, id: ref, via: "creado en la etapa 3" });
    refsByAlbum.set(Number(row.album_id), list);
  }

  const albums: AlbumHarvest[] = [];
  const totals: Record<string, number> = {};
  const bump = (key: string) => { totals[key] = (totals[key] ?? 0) + 1; };
  for (const [index, row] of albumRows.entries()) {
    const album: AlbumHarvest = {
      albumId: Number(row.id), artistId: Number(row.artist_id), artist: row.artist, title: row.title, year: row.year,
      current: { tracks: Number(row.tracks), missingDurations: Number(row.missing), cover: row.cover, label: row.label },
      refs: [...(refsByAlbum.get(Number(row.id)) ?? [])], tracklists: [], covers: [], labels: [], notes: [],
    };
    const wantTracks = album.current.tracks === 0 || album.current.missingDurations > 0;
    const wantCover = !album.current.cover;
    const wantLabel = !album.current.label;
    if (!wantTracks && !wantCover && !wantLabel) continue;
    const source = byArtist.get(album.artistId);
    // Discos que ya existían: identidad por título en la discografía verificada
    // de la ficha. Los creados en la etapa 3 solo usan sus ids exactos (un
    // sencillo «… (Versión 25 años)» no es el álbum del mismo nombre).
    const stage3 = album.refs.length > 0;
    if (source && !stage3) {
      const pick = pickByTitle(album, source.musicbrainz.releaseGroups ?? [], (group) => group.title, (group) => yearOf(group.date));
      if (pick.row) album.refs.push({ platform: "musicbrainz", id: pick.row.id, via: `discografía MB de la ficha: ${pick.why}` });
      else if (pick.why !== "sin título igual") album.notes.push(`MB: ${pick.why}`);
    }
    if (source && !stage3) {
      const own = (source.deezer.albums ?? []).filter((item) => item.mainArtist);
      const pick = pickByTitle(album, own, (item) => item.title, (item) => yearOf(item.date));
      if (pick.row) album.refs.push({ platform: "deezer", id: String(pick.row.id), via: `discografía Deezer de la ficha: ${pick.why}` });
      else if (pick.why !== "sin título igual") album.notes.push(`Deezer: ${pick.why}`);
    }
    const order: Platform[] = ["musicbrainz", "deezer", "itunes", "discogs"];
    album.refs.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
    try {
      for (const ref of album.refs) {
        const needTracks = wantTracks && album.tracklists.length === 0;
        if (ref.platform === "musicbrainz") await fromMusicBrainz(album, ref.id, ref.via, wantTracks, wantLabel, wantCover);
        else if (ref.platform === "deezer") await fromDeezer(album, ref.id, ref.via, wantTracks, wantCover && album.covers.length === 0);
        else if (ref.platform === "itunes") await fromItunes(album, ref.id, ref.via, needTracks, wantCover && album.covers.length === 0);
        else if (ref.platform === "discogs") await fromDiscogs(album, ref.id, ref.via, needTracks, wantLabel && album.labels.length === 0, wantCover && album.covers.length === 0);
      }
      if (ITUNES_SEARCH && album.current.tracks === 0 && album.tracklists.length === 0) {
        const names = [...new Set([album.artist, ...(source?.aliases ?? [])])];
        const found = await itunesSearch(album, names);
        if (found) await fromItunes(album, found, `búsqueda iTunes: artista y título idénticos${album.year ? ", año ±1" : ""}`, true, wantCover && album.covers.length === 0, "itunes-busqueda");
      }
    } catch (error) {
      album.notes.push(`error: ${(error as Error).message}`);
      bump("errores");
    }
    if (album.refs.length === 0) bump("sin identidad");
    if (wantTracks && album.current.tracks === 0) bump(album.tracklists.length ? "pistas: con lista" : "pistas: sin lista");
    if (wantTracks && album.current.tracks > 0) bump(album.tracklists.length ? "duraciones: con lista" : "duraciones: sin lista");
    if (wantCover) bump(album.covers.length ? "portada: hallada" : "portada: sin hallar");
    if (wantLabel) bump(album.labels.length ? "sello: hallado" : "sello: sin hallar");
    albums.push(album);
    if ((index + 1) % 100 === 0) {
      console.log(`${index + 1}/${albumRows.length} ${JSON.stringify(totals)}`);
      writeOut(albums, [], totals, false);
    }
  }

  const artists: ArtistHarvest[] = [];
  const pictures = (await pool.query<{ id: string; name: string; has: boolean }>(
    "SELECT id::text, name, picture_url IS NOT NULL AS has FROM public.artists WHERE id = ANY($1::bigint[]) ORDER BY id", [artistIds])).rows;
  for (const row of pictures) {
    if (row.has) continue;
    const source = byArtist.get(Number(row.id));
    const artist: ArtistHarvest = { artistId: Number(row.id), artist: row.name, loteId: source?.loteIds.join(",") ?? extra.get(Number(row.id)) ?? "", hasPicture: row.has, photos: [], notes: [] };
    try {
      await artistPhotos(artist,
        source?.musicbrainz.status === "ok" ? source.musicbrainz.mbid : undefined,
        source?.deezer.status === "ok" ? source.deezer.deezerId : undefined);
    } catch (error) {
      artist.notes.push(`error: ${(error as Error).message}`);
    }
    if (!source) artist.notes.push("sin identidad en plataformas (no cosechada en la etapa 3)");
    bump(artist.photos.length ? "foto: hallada" : "foto: sin hallar");
    artists.push(artist);
  }
  writeOut(albums, artists, totals, true);
}

function writeOut(albums: AlbumHarvest[], artists: ArtistHarvest[], totals: Record<string, number>, done: boolean): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify({ harvestedAt: new Date().toISOString(), complete: done, totals, albums, artists }, null, 1)}\n`);
  if (done) console.log(`→ ${OUT_FILE}\n${JSON.stringify(totals)}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
