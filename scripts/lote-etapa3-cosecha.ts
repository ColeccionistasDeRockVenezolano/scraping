// CRV · Etapa 3 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3):
// cosecha de discografías en MusicBrainz y Deezer. NO escribe en la base.
//
// Para cada ficha de los lotes 1 y 2 (ya enlazada al catálogo por la etapa 0 o
// creada por la etapa 2) busca su artista en MusicBrainz y en Deezer. La
// identidad se da por buena solo con señal propia:
//   · al menos un título en común con lo que ya sabemos de la ficha (discos
//     del catálogo, discos del lote o, para Deezer, la discografía de
//     MusicBrainz ya aceptada), o
//   · en MusicBrainz, un único homónimo exacto con país o área Venezuela.
// Un empate entre homónimos queda como ambiguo y no se cosecha.
//
// Las fichas de compositores académicos no se cosechan: sus obras van a las
// notas, no a discos (decisión de Brian, plan §2.2).
//
// Las respuestas HTTP se guardan en data/raw/etapa3-discografias/ (fuera de
// git) para que repetir la cosecha no vuelva a la red.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa3-cosecha.ts [--only=lote_id,…] [--refresh]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { compareKey, loteFileSchema, type LoteArtist } from "../src/ingest/lote-investigacion.js";
import { COMPOSERS_ONLY, titleKey, type DeezerAlbum, type ReleaseGroup } from "./lote-etapa3-comun.js";

const DESKTOP = path.join(os.homedir(), "Desktop");
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const OUT_FILE = `${OUT_DIR}/etapa3-cosecha.json`;
const CACHE_DIR = "data/raw/etapa3-discografias";
const USER_AGENT = "CRV-discografias/1.0 (+coleccionistasderockvenezolano.com)";
const LOTES = [
  { key: "lote1", file: path.join(DESKTOP, "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json"), cross: OUT_DIR },
  { key: "lote2", file: path.join(DESKTOP, "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json"), cross: `${OUT_DIR}/lote2` },
] as const;

/** Fichas que la etapa 0 cruzó mal (ver lote-investigacion-2026-10-02.ts). */
const IDENTITY_OVERRIDES: Record<string, "nuevo"> = { "simon-diaz": "nuevo", arca: "nuevo" };

const ONLY = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");
const REFRESH = process.argv.includes("--refresh");

// --- HTTP con caché ------------------------------------------------------------

const lastCall: Record<string, number> = {};
const GAP_MS: Record<string, number> = { musicbrainz: 1100, deezer: 120 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson<T>(service: "musicbrainz" | "deezer", url: string): Promise<T> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${service}-${createHash("sha1").update(url).digest("hex")}.json`);
  if (!REFRESH && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = (lastCall[service] ?? 0) + GAP_MS[service]! - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[service] = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt < 4) { await sleep(3_000 * (attempt + 1)); continue; }
      throw error;
    }
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 4) { await sleep(5_000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`${service} HTTP ${response.status} ${url}`);
    const body = (await response.json()) as T & { error?: { code?: number; message?: string } };
    // Deezer responde 200 con {error:{code:4}} cuando corta por cuota.
    if (service === "deezer" && body.error) {
      if (body.error.code === 4 && attempt < 4) { await sleep(5_000 * (attempt + 1)); continue; }
      if (body.error.code === 800) { writeFileSync(file, JSON.stringify(body)); return body; } // no existe
      throw new Error(`deezer ${JSON.stringify(body.error)} ${url}`);
    }
    writeFileSync(file, JSON.stringify(body));
    return body;
  }
  throw new Error(`${service}: sin respuesta ${url}`);
}

// --- Fichas del lote ---------------------------------------------------------

interface Target {
  lote: string; loteId: string; name: string; artistId: number; artistName: string; aliases: string[];
  knownTitles: string[]; loteTitles: string[];
}

interface CrossIdentity { lote_id: string; estado: "existe" | "nuevo"; artistas: Array<{ id: number }> }

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

async function targets(): Promise<{ rows: Target[]; skipped: Array<{ loteId: string; why: string }> }> {
  const stage2 = (JSON.parse(readFileSync(`${OUT_DIR}/etapa2-identidades.json`, "utf8")) as { identities: Record<string, { artistId: number }> }).identities;
  const rows: Target[] = [];
  const skipped: Array<{ loteId: string; why: string }> = [];
  for (const lote of LOTES) {
    const parsed = loteFileSchema.parse(JSON.parse(readFileSync(lote.file, "utf8")));
    const identities = new Map((JSON.parse(readFileSync(path.join(lote.cross, "identidades.json"), "utf8")) as CrossIdentity[]).map((row) => [row.lote_id, row]));
    for (const artist of parsed.artists as LoteArtist[]) {
      if (ONLY && !ONLY.includes(artist.id)) continue;
      if (COMPOSERS_ONLY.has(artist.id)) { skipped.push({ loteId: artist.id, why: "compositor: obras a notas (plan §2.2)" }); continue; }
      let artistId: number | null = null;
      if (stage2[artist.id]) artistId = await liveArtist(stage2[artist.id]!.artistId);
      else if (IDENTITY_OVERRIDES[artist.id] !== "nuevo" && identities.get(artist.id)?.estado === "existe") {
        artistId = await liveArtist(identities.get(artist.id)!.artistas[0]!.id);
      }
      if (artistId === null) { skipped.push({ loteId: artist.id, why: "sin ficha en el catálogo" }); continue; }
      const core = await getPool().query<{ name: string }>("SELECT name FROM public.artists WHERE id=$1", [artistId]);
      const aliases = await getPool().query<{ alias: string }>("SELECT alias FROM ingest.artist_aliases WHERE artist_id=$1", [artistId]);
      const albums = await getPool().query<{ title: string }>("SELECT title FROM public.albums WHERE artist_id=$1", [artistId]);
      const loteTitles = (artist.discography ?? []).map((release) => release.title);
      rows.push({
        lote: lote.key, loteId: artist.id, name: artist.artist_name, artistId, artistName: core.rows[0]!.name,
        aliases: [...new Set([artist.artist_name, core.rows[0]!.name, ...aliases.rows.map((row) => row.alias), ...(artist.aliases ?? [])])],
        knownTitles: [...new Set([...albums.rows.map((row) => row.title), ...loteTitles])], loteTitles,
      });
    }
  }
  return { rows, skipped };
}

// --- MusicBrainz -------------------------------------------------------------

interface MbArtist { id: string; name: string; score?: number; country?: string; area?: { name?: string }; "begin-area"?: { name?: string }; aliases?: Array<{ name: string }>; disambiguation?: string; type?: string }
interface MbReleaseGroup { id: string; title: string; "primary-type"?: string | null; "secondary-types"?: string[]; "first-release-date"?: string; "artist-credit"?: Array<{ name: string; artist: { id: string; name: string } }> }

const venezuelan = (artist: MbArtist) => artist.country === "VE"
  || /venezuela/i.test(`${artist.area?.name ?? ""} ${artist["begin-area"]?.name ?? ""} ${artist.disambiguation ?? ""}`);

async function mbReleaseGroups(mbid: string): Promise<ReleaseGroup[]> {
  const out: ReleaseGroup[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await getJson<{ "release-groups": MbReleaseGroup[]; "release-group-count": number }>("musicbrainz",
      `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&inc=artist-credits&fmt=json&limit=100&offset=${offset}`);
    for (const group of page["release-groups"]) {
      const credit = group["artist-credit"] ?? [];
      // Solo lo que la ficha firma como artista principal: una colaboración en
      // la que va segunda es disco de otro.
      if (credit[0]?.artist.id !== mbid) continue;
      out.push({
        id: group.id, title: group.title, primaryType: group["primary-type"] ?? null, secondaryTypes: group["secondary-types"] ?? [],
        date: group["first-release-date"] || null, credit: credit.map((part) => part.name).join(" / "), soleArtist: credit.length === 1,
      });
    }
    if (offset + 100 >= page["release-group-count"]) break;
  }
  return out;
}

function overlap(titles: string[], known: string[]): string[] {
  const keys = new Set(known.map(titleKey).filter(Boolean));
  return [...new Set(titles.filter((title) => keys.has(titleKey(title))))];
}

async function musicbrainz(target: Target) {
  const names = target.aliases.map(compareKey);
  const seen = new Map<string, MbArtist>();
  for (const name of [...new Set([target.name, target.artistName])]) {
    const query = `artist:"${name.replace(/"/g, "")}" OR alias:"${name.replace(/"/g, "")}"`;
    const found = await getJson<{ artists: MbArtist[] }>("musicbrainz",
      `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}&fmt=json&limit=15`);
    for (const artist of found.artists ?? []) {
      const own = [artist.name, ...(artist.aliases ?? []).map((alias) => alias.name)].map(compareKey);
      if (own.some((key) => names.includes(key))) seen.set(artist.id, artist);
    }
  }
  const candidates = [];
  for (const artist of [...seen.values()].slice(0, 6)) {
    const groups = await mbReleaseGroups(artist.id);
    candidates.push({ artist, groups, shared: overlap(groups.map((group) => group.title), target.knownTitles) });
  }
  const best = Math.max(0, ...candidates.map((row) => row.shared.length));
  const summary = candidates.map((row) => ({ mbid: row.artist.id, name: row.artist.name, country: row.artist.country ?? null, disambiguation: row.artist.disambiguation ?? null, releaseGroups: row.groups.length, shared: row.shared }));
  if (best > 0) {
    const top = candidates.filter((row) => row.shared.length === best);
    if (top.length > 1) return { status: "ambiguo" as const, why: `${top.length} homónimos con ${best} títulos en común`, candidates: summary };
    return { status: "ok" as const, why: `${best} título(s) en común`, mbid: top[0]!.artist.id, name: top[0]!.artist.name, releaseGroups: top[0]!.groups, candidates: summary };
  }
  const local = candidates.filter((row) => venezuelan(row.artist));
  if (local.length === 1) return { status: "ok" as const, why: "único homónimo venezolano", mbid: local[0]!.artist.id, name: local[0]!.artist.name, releaseGroups: local[0]!.groups, candidates: summary };
  if (local.length > 1) return { status: "ambiguo" as const, why: `${local.length} homónimos venezolanos sin títulos en común`, candidates: summary };
  return { status: candidates.length ? "sin_verificar" as const : "no_encontrado" as const, why: candidates.length ? "homónimos sin título en común ni país" : "sin homónimo exacto", candidates: summary };
}

// --- Deezer --------------------------------------------------------------------

interface DzArtist { id: number; name: string; nb_album?: number; nb_fan?: number; link?: string }
interface DzAlbumLite { id: number; title: string; record_type?: string; release_date?: string; link?: string }
interface DzAlbumFull extends DzAlbumLite {
  artist?: { id: number; name: string }; contributors?: Array<{ id: number; name: string; role?: string }>;
  label?: string; nb_tracks?: number; upc?: string; cover_xl?: string; genres?: { data?: Array<{ name: string }> };
  tracks?: { data?: Array<{ title: string; duration?: number; track_position?: number; disk_number?: number }> };
}

async function deezerAlbums(artistId: number): Promise<DzAlbumLite[]> {
  const out: DzAlbumLite[] = [];
  let url: string | undefined = `https://api.deezer.com/artist/${artistId}/albums?limit=100`;
  for (let page = 0; url && page < 30; page += 1) {
    const body: { data?: DzAlbumLite[]; next?: string } = await getJson("deezer", url);
    out.push(...(body.data ?? []));
    url = body.next;
  }
  return out;
}

async function deezer(target: Target, mbTitles: string[]) {
  const names = target.aliases.map(compareKey);
  const seen = new Map<number, DzArtist>();
  for (const name of [...new Set([target.name, target.artistName])]) {
    const found = await getJson<{ data?: DzArtist[] }>("deezer", `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=25`);
    for (const artist of found.data ?? []) if (names.includes(compareKey(artist.name))) seen.set(artist.id, artist);
  }
  const known = [...target.knownTitles, ...mbTitles];
  const candidates = [];
  for (const artist of [...seen.values()].slice(0, 6)) {
    const albums = await deezerAlbums(artist.id);
    candidates.push({ artist, albums, shared: overlap(albums.map((album) => album.title), known) });
  }
  const summary = candidates.map((row) => ({ deezerId: row.artist.id, name: row.artist.name, fans: row.artist.nb_fan ?? null, albums: row.albums.length, shared: row.shared }));
  const best = Math.max(0, ...candidates.map((row) => row.shared.length));
  if (best === 0) return { status: candidates.length ? "sin_verificar" as const : "no_encontrado" as const, why: candidates.length ? "homónimos sin título en común" : "sin homónimo exacto", candidates: summary };
  const top = candidates.filter((row) => row.shared.length === best);
  if (top.length > 1) return { status: "ambiguo" as const, why: `${top.length} homónimos con ${best} títulos en común`, candidates: summary };
  const chosen = top[0]!;
  // Deezer junta a veces homónimos en una página: cada disco se comprueba
  // con su propia ficha (artista principal y colaboradores).
  const albums: DeezerAlbum[] = [];
  for (const lite of chosen.albums) {
    const full = await getJson<DzAlbumFull>("deezer", `https://api.deezer.com/album/${lite.id}`);
    if ((full as { error?: unknown }).error) continue;
    albums.push({
      id: lite.id, title: full.title ?? lite.title, recordType: full.record_type ?? lite.record_type ?? null,
      date: full.release_date ?? lite.release_date ?? null, label: full.label?.trim() || null, nbTracks: full.nb_tracks ?? null,
      upc: full.upc ?? null, link: full.link ?? `https://www.deezer.com/album/${lite.id}`,
      mainArtist: full.artist?.id === chosen.artist.id, contributors: (full.contributors ?? []).map((row) => row.name),
    });
  }
  return { status: "ok" as const, why: `${best} título(s) en común`, deezerId: chosen.artist.id, name: chosen.artist.name, albums, candidates: summary };
}

// --- Principal ---------------------------------------------------------------

async function main(): Promise<void> {
  const { rows, skipped } = await targets();
  const previous = existsSync(OUT_FILE) && ONLY ? (JSON.parse(readFileSync(OUT_FILE, "utf8")) as { artists: Array<{ loteId: string }> }).artists : [];
  const artists: unknown[] = previous.filter((row) => !ONLY?.includes(row.loteId));
  for (const [index, target] of rows.entries()) {
    const mb = await musicbrainz(target);
    const dz = await deezer(target, mb.status === "ok" ? mb.releaseGroups.map((group) => group.title) : []);
    console.log(`[${index + 1}/${rows.length}] ${target.loteId} → ${target.artistId} «${target.artistName}» · MB ${mb.status}${mb.status === "ok" ? ` (${mb.releaseGroups.length})` : ""} · Deezer ${dz.status}${dz.status === "ok" ? ` (${dz.albums.length})` : ""}`);
    artists.push({ ...target, musicbrainz: mb, deezer: dz });
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify({ harvestedAt: new Date().toISOString(), skipped, artists }, null, 1)}\n`);
  console.log(`→ ${OUT_FILE}: ${artists.length} fichas, ${skipped.length} omitidas`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
