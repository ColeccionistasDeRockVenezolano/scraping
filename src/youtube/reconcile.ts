// Etapa 6 · Reconciliación del canal con el catálogo (PHASES.md E6; plan de
// implementación, FASE 10A).
//
// `yt:link` dejó cada disco del canal con su video principal, pero lo demás
// que el canal afirma no había llegado a las tablas puente:
// `media.video_artists` y `media.video_tracks` seguían vacías, así que ni un
// videoclip sabía de qué canción es ni una pista en qué segundo empieza dentro
// de su video. Este módulo las llena con tres reglas:
//
//  * NADA SE ADIVINA. Solo se escribe lo que sale de una identidad exacta
//    (clave sin tildes ni signos, la de `youtubeLinkKey`) o de una relación ya
//    confirmada (el enlace video→disco). Lo que necesita un criterio más
//    blando queda como propuesta en `youtube_match` y lo decide una persona.
//  * NADA TOCA EL CORE. Escribe únicamente en `media.*` y en la cola: no crea
//    discos ni pistas, ni corrige un inicio de pista que discrepa del video;
//    lo reporta como conflicto.
//  * NADA SE ESCONDE. Cada video sale con su categoría y sus razones en
//    reports/youtube-reconciliation.{json,md}, incluidos los que no casan, y
//    cada disco sin video aparece en la lista.
//
// El orden de las evidencias es el del plan: ID canónico del video, relación
// de la hoja, nombre exacto (con alias), tipo de publicación, coincidencia de
// pistas y contexto. La IA no participa: aquí no hay nada semántico.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { youtubeLinkKey } from "./linker.js";
import { canonicalVideoUrl } from "./normalization.js";
import { parseYouTubeTitle } from "./parsers.js";

const log = moduleLogger("youtube:reconcile");

export type ReconcileCategory = "MATCHED_HIGH" | "MATCHED_MEDIUM" | "AMBIGUOUS" | "UNMATCHED_VIDEO" | "CONFLICT";
export type VideoKind = "full_album" | "music_video" | "live_concert" | "documentary" | "editorial";
type Via = "album_link" | "sheet" | "title";

export interface SnapshotVideo {
  dbId: number; videoId: string; title: string | null; durationSeconds: number | null;
  seed: { uploadOrder: number; artist: string | null; album: string | null; normalizedType: string | null } | null;
  tracklist: Array<{ position: number; title: string; startSeconds: number }>;
}
export interface SnapshotAlbumLink { videoDbId: number; albumId: number; albumKind: string; isPrimary: boolean; sourceId: number | null; }
export interface SnapshotAlbum { id: number; artistId: number; title: string; year: number | null; type: string; }
export interface SnapshotTrack { id: number; albumId: number; discNumber: number; trackNumber: number; title: string; youtubeStartSeconds: number | null; }
export interface ReconcileSnapshot {
  videos: SnapshotVideo[]; links: SnapshotAlbumLink[]; albums: SnapshotAlbum[];
  artists: Array<{ id: number; name: string }>; aliases: Array<{ artistId: number; alias: string }>;
  tracks: SnapshotTrack[];
}

export interface PlannedVideoArtist { videoDbId: number; artistId: number; relationKind: "performer" | "subject"; via: Via; linkSourceId: number | null; }
export interface PlannedVideoTrack { videoDbId: number; videoId: string; trackId: number; startSeconds: number; endSeconds: number | null; via: Via; }
export interface Proposal { kind: "track" | "album"; id: number; label: string; rule: string; }
export interface StartMismatch { trackId: number; title: string; core: number; video: number; }
export interface VideoVerdict {
  videoId: string; videoDbId: number; title: string | null; kind: VideoKind; category: ReconcileCategory;
  artists: string[]; albums: string[]; reasons: string[]; proposals: Proposal[];
  tracklist: { entries: number; matched: number; unmatched: string[]; startMismatches: StartMismatch[] } | null;
}
export interface UnmatchedAlbum { albumId: number; artist: string; title: string; year: number | null; type: string; artistOnChannel: boolean; }
export interface ReconcilePlan {
  verdicts: VideoVerdict[]; videoArtists: PlannedVideoArtist[]; videoTracks: PlannedVideoTrack[]; unmatchedAlbums: UnmatchedAlbum[];
}

/** Categorías que requieren una decisión humana y por eso abren `youtube_match`. */
export const QUEUED_CATEGORIES: ReadonlySet<ReconcileCategory> = new Set(["MATCHED_MEDIUM", "AMBIGUOUS", "CONFLICT"]);
// Un videoclip se graba para la versión de estudio: si la canción aparece en
// varios discos y solo uno es de estudio, sencillo o EP, ese es el candidato.
// Es un criterio de contexto, no una identidad; por eso queda como propuesta.
const STUDIO_RELEASE_TYPES = new Set(["studio_album", "single", "ep"]);
const OFFICIAL_VIDEO_TAG = /\s*\((?:official|oficial)[^)]*\)\s*/giu;

export function classifyVideoKind(video: SnapshotVideo, links: SnapshotAlbumLink[]): VideoKind {
  if (links.some((link) => link.albumKind === "full_album")) return "full_album";
  // La hoja es la fuente de los tipos (identidades confirmadas, 2026-09-13).
  const sheetType = video.seed?.normalizedType;
  if (sheetType === "music_video" || sheetType === "live_concert" || sheetType === "documentary") return sheetType;
  const title = video.title ?? "";
  if (parseYouTubeTitle(title).isFullAlbum) return "full_album";
  if (/\|\|\s*full\s+concert\s*\|\|/iu.test(title) || links.some((link) => link.albumKind === "live_concert")) return "live_concert";
  if (/\|\|\s*full\s+documentary\s*\|\|/iu.test(title)) return "documentary";
  if (/\((?:official|oficial)[^)]*video\)/iu.test(title)) return "music_video";
  return "editorial";
}

type ArtistIndex = Map<string, Set<number>>;

function buildArtistIndex(snapshot: ReconcileSnapshot): ArtistIndex {
  const index: ArtistIndex = new Map();
  const add = (name: string, id: number): void => {
    const key = youtubeLinkKey(name);
    if (!key) return;
    const ids = index.get(key) ?? new Set<number>();
    ids.add(id); index.set(key, ids);
  };
  for (const artist of snapshot.artists) add(artist.name, artist.id);
  for (const alias of snapshot.aliases) add(alias.alias, alias.artistId);
  return index;
}

function lookupArtist(index: ArtistIndex, name: string | null | undefined): number[] {
  return name ? [...(index.get(youtubeLinkKey(name)) ?? [])] : [];
}

interface ArtistResolution { ids: number[]; via: Via | null; outcome: "resolved" | "ambiguous" | "conflict" | "none"; reasons: string[]; }

/**
 * El artista de un video sin disco. Primero la fila de la hoja (relación
 * escrita a mano para ese ID), después el título del canal. Si los dos
 * nombran artistas distintos del catálogo es un conflicto, no una elección.
 */
function resolveMediaArtist(video: SnapshotVideo, index: ArtistIndex): ArtistResolution {
  const sheetName = video.seed?.artist ?? null;
  const titleName = parseYouTubeTitle(video.title ?? "").artist;
  const sheet = lookupArtist(index, sheetName);
  const title = lookupArtist(index, titleName);
  if (sheet.length === 1 && title.length === 1 && sheet[0] !== title[0]) {
    return { ids: [sheet[0]!, title[0]!], via: null, outcome: "conflict", reasons: [`la hoja dice «${sheetName}» y el título «${titleName}»: son artistas distintos del catálogo`] };
  }
  if (sheet.length === 1) return { ids: sheet, via: "sheet", outcome: "resolved", reasons: [] };
  if (sheet.length > 1 || title.length > 1) {
    return { ids: [...new Set([...sheet, ...title])], via: null, outcome: "ambiguous", reasons: [`«${sheetName ?? titleName}» corresponde a varios artistas del catálogo`] };
  }
  if (title.length === 1) {
    return { ids: title, via: "title", outcome: "resolved", reasons: sheetName ? [`la hoja nombra «${sheetName}», que no está en el catálogo; se usa el título del canal`] : [] };
  }
  const named = sheetName ?? titleName;
  return { ids: [], via: null, outcome: "none", reasons: [named ? `«${named}» no está en el catálogo` : "el título no nombra un artista con la forma «Artista - Título»"] };
}

/** Nombres con que la hoja y el título llaman a la canción o al concierto. */
function workNames(video: SnapshotVideo): string[] {
  const names = new Set<string>();
  if (video.seed?.album) names.add(video.seed.album);
  const parsed = parseYouTubeTitle(video.title ?? "");
  if (parsed.artist && parsed.title) names.add(parsed.title.replace(OFFICIAL_VIDEO_TAG, " ").replace(/\s+/gu, " ").trim());
  return [...names].filter((name) => youtubeLinkKey(name));
}

export interface TracklistMatch {
  occurrences: Array<{ trackId: number; startSeconds: number; endSeconds: number | null }>;
  unmatched: string[]; startMismatches: StartMismatch[];
}

/**
 * Casa el tracklist de la descripción con las pistas de su disco. Una entrada
 * casa si su título es idéntico (misma clave) a UNA pista; si hay varias
 * homónimas —*The Collapse of Singularity* repite cuatro títulos— decide la
 * posición. El fin de cada ocurrencia es el inicio de la siguiente marca, y
 * el de la última, el final del video: aritmética sobre lo que el canal
 * afirma, igual que la duración en api-claims.
 */
export function matchTracklist(
  entries: SnapshotVideo["tracklist"], tracks: SnapshotTrack[], durationSeconds: number | null, compareStarts: boolean,
): TracklistMatch {
  const byKey = new Map<string, SnapshotTrack[]>();
  for (const track of tracks) {
    const key = youtubeLinkKey(track.title);
    byKey.set(key, [...(byKey.get(key) ?? []), track]);
  }
  const starts = [...new Set(entries.map((entry) => entry.startSeconds))].sort((a, b) => a - b);
  const result: TracklistMatch = { occurrences: [], unmatched: [], startMismatches: [] };
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidates = byKey.get(youtubeLinkKey(entry.title)) ?? [];
    const track = candidates.length === 1
      ? candidates[0]
      : candidates.find((candidate) => candidate.discNumber === 1 && candidate.trackNumber === entry.position + 1);
    if (!track) {
      result.unmatched.push(candidates.length > 1 ? `${entry.title} (varias pistas homónimas y ninguna en la posición ${entry.position + 1})` : entry.title);
      continue;
    }
    const occurrenceKey = `${track.id}:${entry.startSeconds}`;
    if (seen.has(occurrenceKey)) continue;
    seen.add(occurrenceKey);
    const next = starts.find((start) => start > entry.startSeconds);
    const end = next ?? (durationSeconds !== null && durationSeconds > entry.startSeconds ? durationSeconds : null);
    result.occurrences.push({ trackId: track.id, startSeconds: entry.startSeconds, endSeconds: end });
    if (compareStarts && track.youtubeStartSeconds !== null && track.youtubeStartSeconds !== entry.startSeconds) {
      result.startMismatches.push({ trackId: track.id, title: track.title, core: track.youtubeStartSeconds, video: entry.startSeconds });
    }
  }
  return result;
}

/** Plan puro: no lee ni escribe la base, así que se prueba sin PostgreSQL. */
export function planReconciliation(snapshot: ReconcileSnapshot): ReconcilePlan {
  const index = buildArtistIndex(snapshot);
  const artistName = new Map(snapshot.artists.map((artist) => [artist.id, artist.name]));
  const albumById = new Map(snapshot.albums.map((album) => [album.id, album]));
  const albumsByArtist = new Map<number, SnapshotAlbum[]>();
  for (const album of snapshot.albums) albumsByArtist.set(album.artistId, [...(albumsByArtist.get(album.artistId) ?? []), album]);
  const tracksByAlbum = new Map<number, SnapshotTrack[]>();
  for (const track of snapshot.tracks) tracksByAlbum.set(track.albumId, [...(tracksByAlbum.get(track.albumId) ?? []), track]);
  const linksByVideo = new Map<number, SnapshotAlbumLink[]>();
  for (const link of snapshot.links) linksByVideo.set(link.videoDbId, [...(linksByVideo.get(link.videoDbId) ?? []), link]);
  const albumLabel = (album: SnapshotAlbum): string => `${artistName.get(album.artistId) ?? "?"} — ${album.title}${album.year ? ` (${album.year})` : ""}`;

  const plan: ReconcilePlan = { verdicts: [], videoArtists: [], videoTracks: [], unmatchedAlbums: [] };

  for (const video of snapshot.videos) {
    const links = linksByVideo.get(video.dbId) ?? [];
    const kind = classifyVideoKind(video, links);
    const verdict: VideoVerdict = {
      videoId: video.videoId, videoDbId: video.dbId, title: video.title, kind, category: "MATCHED_HIGH",
      artists: [], albums: [], reasons: [], proposals: [], tracklist: null,
    };
    if (video.title === null) verdict.reasons.push("sin metadatos: la API no devuelve el video (borrado o privado)");
    const addArtist = (artistId: number, relationKind: "performer" | "subject", via: Via, linkSourceId: number | null = null): void => {
      if (plan.videoArtists.some((row) => row.videoDbId === video.dbId && row.artistId === artistId && row.relationKind === relationKind)) return;
      plan.videoArtists.push({ videoDbId: video.dbId, artistId, relationKind, via, linkSourceId });
      verdict.artists.push(artistName.get(artistId) ?? String(artistId));
    };

    if (kind === "full_album" && links.length > 0) {
      const fullLinks = links.filter((link) => link.albumKind === "full_album");
      const unmatched = new Set<string>(); const matchedTitles = new Set<string>(); const mismatches: StartMismatch[] = [];
      for (const link of fullLinks) {
        const album = albumById.get(link.albumId);
        if (!album) continue;
        verdict.albums.push(albumLabel(album));
        addArtist(album.artistId, "performer", "album_link", link.sourceId);
        const tracks = tracksByAlbum.get(album.id) ?? [];
        const match = matchTracklist(video.tracklist, tracks, video.durationSeconds, link.isPrimary);
        for (const occurrence of match.occurrences) {
          plan.videoTracks.push({ videoDbId: video.dbId, videoId: video.videoId, trackId: occurrence.trackId, startSeconds: occurrence.startSeconds, endSeconds: occurrence.endSeconds, via: "album_link" });
        }
        for (const title of match.unmatched) unmatched.add(title);
        for (const entry of video.tracklist) if (!match.unmatched.some((title) => title.startsWith(entry.title))) matchedTitles.add(entry.title);
        mismatches.push(...match.startMismatches);
        if (tracks.length === 0 && video.tracklist.length > 0) verdict.reasons.push(`«${album.title}» no tiene pistas en el catálogo`);
      }
      // Una entrada que casó con algún disco enlazado no cuenta como pendiente.
      const pending = [...unmatched].filter((title) => !matchedTitles.has(title));
      verdict.tracklist = { entries: video.tracklist.length, matched: video.tracklist.length - pending.length, unmatched: pending, startMismatches: mismatches };
      const titleArtist = lookupArtist(index, parseYouTubeTitle(video.title ?? "").artist);
      const linkedArtists = new Set(fullLinks.map((link) => albumById.get(link.albumId)?.artistId));
      if (titleArtist.length === 1 && !linkedArtists.has(titleArtist[0])) {
        verdict.reasons.push(`el título nombra a «${artistName.get(titleArtist[0]!)}», distinto del artista del disco enlazado`);
      }
      if (video.tracklist.length === 0) verdict.reasons.push("la descripción no trae timestamps");
      if (mismatches.length > 0) {
        verdict.category = "CONFLICT";
        verdict.reasons.push(`${mismatches.length} pista(s) con un inicio en el catálogo distinto del que marca el video`);
      } else if (pending.length > 0) {
        verdict.category = "MATCHED_MEDIUM";
        verdict.reasons.push(`${pending.length} de ${video.tracklist.length} entradas del tracklist no casan con una pista del disco`);
      }
      plan.verdicts.push(verdict);
      continue;
    }

    const artist = resolveMediaArtist(video, index);
    verdict.reasons.push(...artist.reasons);
    if (artist.outcome === "conflict" || artist.outcome === "ambiguous") {
      verdict.category = artist.outcome === "conflict" ? "CONFLICT" : "AMBIGUOUS";
      verdict.artists = artist.ids.map((id) => artistName.get(id) ?? String(id));
      plan.verdicts.push(verdict);
      continue;
    }
    if (artist.outcome === "none") {
      verdict.category = "UNMATCHED_VIDEO";
      if (kind === "editorial") verdict.reasons.push("pieza editorial del canal (reseña, entrevista o repost)");
      plan.verdicts.push(verdict);
      continue;
    }
    const artistId = artist.ids[0]!;
    const via = artist.via!;
    const names = workNames(video).map(youtubeLinkKey);
    const artistAlbums = albumsByArtist.get(artistId) ?? [];

    if (kind === "music_video") {
      addArtist(artistId, "performer", via);
      const candidates = new Map<number, { track: SnapshotTrack; album: SnapshotAlbum }>();
      for (const album of artistAlbums) {
        for (const track of tracksByAlbum.get(album.id) ?? []) {
          if (names.includes(youtubeLinkKey(track.title))) candidates.set(track.id, { track, album });
        }
      }
      const proposal = ({ track, album }: { track: SnapshotTrack; album: SnapshotAlbum }, rule: string): Proposal =>
        ({ kind: "track", id: track.id, label: `${track.title} · ${albumLabel(album)} [${album.type}]`, rule });
      const all = [...candidates.values()];
      if (all.length === 1) {
        const only = all[0]!;
        plan.videoTracks.push({ videoDbId: video.dbId, videoId: video.videoId, trackId: only.track.id, startSeconds: 0, endSeconds: video.durationSeconds && video.durationSeconds > 0 ? video.durationSeconds : null, via });
        verdict.albums.push(albumLabel(only.album));
      } else if (all.length > 1) {
        const studio = all.filter((candidate) => STUDIO_RELEASE_TYPES.has(candidate.album.type));
        if (studio.length === 1) {
          verdict.category = "MATCHED_MEDIUM";
          verdict.reasons.push(`la canción está en ${all.length} discos; solo uno es de estudio, sencillo o EP`);
          verdict.proposals.push(proposal(studio[0]!, "única versión de estudio/sencillo/EP"));
        } else {
          verdict.category = "AMBIGUOUS";
          verdict.reasons.push(`la canción está en ${all.length} discos y ninguna regla determinista elige uno`);
          verdict.proposals.push(...all.map((candidate) => proposal(candidate, "mismo título")));
        }
      } else {
        verdict.category = "UNMATCHED_VIDEO";
        verdict.reasons.push("la canción no está en la discografía del artista en el catálogo (la relación con el artista sí se escribe)");
      }
      plan.verdicts.push(verdict);
      continue;
    }

    addArtist(artistId, kind === "documentary" ? "subject" : "performer", via);
    for (const link of links) {
      const album = albumById.get(link.albumId);
      if (album) verdict.albums.push(albumLabel(album));
    }
    const linked = new Set(links.map((link) => link.albumId));
    const sameName = artistAlbums.filter((album) => !linked.has(album.id) && names.includes(youtubeLinkKey(album.title)));
    if (kind === "full_album") {
      // Un Full Album sin enlace: el título casa con un disco del artista, pero
      // el enlace primario lo confirma una persona (yt:link --confirm).
      const year = parseYouTubeTitle(video.title ?? "").year;
      const exact = sameName.filter((album) => album.year === null || year === null || album.year === year);
      if (exact.length === 0) {
        verdict.category = "UNMATCHED_VIDEO";
        verdict.reasons.push("Full Album sin disco con ese título en el catálogo");
      } else {
        verdict.category = exact.length === 1 ? "MATCHED_MEDIUM" : "AMBIGUOUS";
        verdict.proposals.push(...exact.map((album) => ({ kind: "album" as const, id: album.id, label: albumLabel(album), rule: "artista, título y año exactos" })));
      }
    } else if (kind === "live_concert" && sameName.length > 0) {
      // Un concierto nunca crea disco; si ya existe uno con su nombre, se
      // propone el vínculo (album_kind='live_concert'), no se asume.
      verdict.category = "MATCHED_MEDIUM";
      verdict.reasons.push("hay un disco del artista con el mismo nombre que el concierto");
      verdict.proposals.push(...sameName.map((album) => ({ kind: "album" as const, id: album.id, label: albumLabel(album), rule: "concierto con el nombre de un disco del artista" })));
    } else if (kind === "editorial") {
      verdict.reasons.push("pieza editorial que nombra a un artista del catálogo");
    }
    plan.verdicts.push(verdict);
  }

  const linkedAlbums = new Set(snapshot.links.map((link) => link.albumId));
  const artistsOnChannel = new Set(plan.videoArtists.map((row) => row.artistId));
  for (const album of snapshot.albums) {
    if (linkedAlbums.has(album.id)) continue;
    plan.unmatchedAlbums.push({
      albumId: album.id, artist: artistName.get(album.artistId) ?? String(album.artistId), title: album.title,
      year: album.year, type: album.type, artistOnChannel: artistsOnChannel.has(album.artistId),
    });
  }
  return plan;
}

async function loadSnapshot(client: PoolClient): Promise<ReconcileSnapshot> {
  const videos = await client.query<{ id: string; video_id: string; title: string | null; duration_seconds: number | null; upload_order: number | null; artist_name_raw: string | null; album_name_raw: string | null; normalized_type: string | null }>(`
    SELECT v.id::text, v.video_id, v.title, v.duration_seconds,
           s.upload_order, s.artist_name_raw, s.album_name_raw, s.normalized_type
      FROM media.youtube_videos v LEFT JOIN ingest.seed_uploads s ON s.id=v.seed_upload_id
     ORDER BY v.video_id`);
  const entries = await client.query<{ video_id: string; position: number; title: string; start_seconds: number }>(
    "SELECT video_id::text, position, title, start_seconds FROM media.youtube_tracklist_entries ORDER BY video_id, position");
  const tracklists = new Map<number, SnapshotVideo["tracklist"]>();
  for (const row of entries.rows) {
    const id = Number(row.video_id);
    tracklists.set(id, [...(tracklists.get(id) ?? []), { position: row.position, title: row.title, startSeconds: row.start_seconds }]);
  }
  const links = await client.query<{ video_id: string; album_id: string; album_kind: string; is_primary_link: boolean; source_id: string | null }>(
    "SELECT video_id::text, album_id::text, album_kind::text, is_primary_link, source_id::text FROM media.video_albums ORDER BY video_id, album_id");
  const albums = await client.query<{ id: string; artist_id: string; title: string; release_year: number | null; album_type: string }>(
    "SELECT id::text, artist_id::text, title, release_year, album_type::text FROM public.albums ORDER BY id");
  const artists = await client.query<{ id: string; name: string }>("SELECT id::text, name FROM public.artists ORDER BY id");
  const aliases = await client.query<{ artist_id: string; alias: string }>("SELECT artist_id::text, alias FROM ingest.artist_aliases ORDER BY id");
  const tracks = await client.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string; youtube_start_seconds: number | null }>(
    "SELECT id::text, album_id::text, disc_number, track_number, title, youtube_start_seconds FROM public.tracks ORDER BY album_id, disc_number, track_number");
  return {
    videos: videos.rows.map((row) => ({
      dbId: Number(row.id), videoId: row.video_id, title: row.title, durationSeconds: row.duration_seconds,
      seed: row.upload_order === null ? null : { uploadOrder: row.upload_order, artist: row.artist_name_raw, album: row.album_name_raw, normalizedType: row.normalized_type },
      tracklist: tracklists.get(Number(row.id)) ?? [],
    })),
    links: links.rows.map((row) => ({ videoDbId: Number(row.video_id), albumId: Number(row.album_id), albumKind: row.album_kind, isPrimary: row.is_primary_link, sourceId: row.source_id === null ? null : Number(row.source_id) })),
    albums: albums.rows.map((row) => ({ id: Number(row.id), artistId: Number(row.artist_id), title: row.title, year: row.release_year, type: row.album_type })),
    artists: artists.rows.map((row) => ({ id: Number(row.id), name: row.name })),
    aliases: aliases.rows.map((row) => ({ artistId: Number(row.artist_id), alias: row.alias })),
    tracks: tracks.rows.map((row) => ({ id: Number(row.id), albumId: Number(row.album_id), discNumber: row.disc_number, trackNumber: row.track_number, title: row.title, youtubeStartSeconds: row.youtube_start_seconds })),
  };
}

export interface ReconcileSummary {
  videos: number; albums: number; byCategory: Record<ReconcileCategory, number>; byKind: Record<VideoKind, number>;
  unmatchedAlbums: number; unmatchedAlbumsOfChannelArtists: number;
  videoArtists: { planned: number; inserted: number; total: number; notReDerived: number };
  videoTracks: { planned: number; inserted: number; total: number; notReDerived: number; withClaim: number };
  tracklistEntries: { total: number; matched: number; unmatched: number };
  reviewsCreated: number;
}
export interface ReconcileResult { dryRun: boolean; runId?: number; summary: ReconcileSummary; plan: ReconcilePlan; reportFiles: string[]; }

export function summarize(plan: ReconcilePlan, albums: number): Omit<ReconcileSummary, "videoArtists" | "videoTracks" | "reviewsCreated"> {
  const byCategory: Record<ReconcileCategory, number> = { MATCHED_HIGH: 0, MATCHED_MEDIUM: 0, AMBIGUOUS: 0, UNMATCHED_VIDEO: 0, CONFLICT: 0 };
  const byKind: Record<VideoKind, number> = { full_album: 0, music_video: 0, live_concert: 0, documentary: 0, editorial: 0 };
  let entries = 0, matched = 0;
  for (const verdict of plan.verdicts) {
    byCategory[verdict.category] += 1; byKind[verdict.kind] += 1;
    if (verdict.tracklist) { entries += verdict.tracklist.entries; matched += verdict.tracklist.matched; }
  }
  return {
    videos: plan.verdicts.length, albums, byCategory, byKind,
    unmatchedAlbums: plan.unmatchedAlbums.length,
    unmatchedAlbumsOfChannelArtists: plan.unmatchedAlbums.filter((album) => album.artistOnChannel).length,
    tracklistEntries: { total: entries, matched, unmatched: entries - matched },
  };
}

/**
 * Ejecuta el plan. Idempotente por construcción: las dos tablas puente tienen
 * clave única sobre la relación y se insertan con ON CONFLICT DO NOTHING, y
 * una revisión ya abierta o descartada para el mismo video no se reabre. Una
 * relación existente que el plan ya no deriva no se borra: se cuenta
 * (`notReDerived`), porque pudo escribirla una persona.
 */
export async function reconcileYouTubeChannel(options: { dryRun?: boolean; reportDir?: string } = {}): Promise<ReconcileResult> {
  const dryRun = options.dryRun ?? false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const sources = await client.query<{ id: string; slug: string }>("SELECT id::text, slug FROM ingest.sources WHERE slug IN ('yt-master-seed','youtube-data-api')");
    const sourceId = new Map(sources.rows.map((row) => [row.slug, Number(row.id)]));
    const apiSource = sourceId.get("youtube-data-api"); const seedSource = sourceId.get("yt-master-seed");
    if (!apiSource || !seedSource) throw new Error("faltan las fuentes yt-master-seed / youtube-data-api: ejecute youtube import-sheet");

    const snapshot = await loadSnapshot(client);
    const plan = planReconciliation(snapshot);
    // kind yt_api_sync con su propia `action`: no gasta cuota y sus contadores
    // no llevan `batches` ni `pages`, así que youtubeQuotaUsedToday suma 0.
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, source_id, status, params)
      VALUES ('yt_api_sync', $1, 'running', $2::jsonb) RETURNING id::text`,
    [apiSource, JSON.stringify({ action: "reconcile_channel", dryRun })]);
    const runId = Number(run.rows[0]!.id);
    const sourceFor = (via: Via, linkSourceId: number | null): number => via === "album_link" ? (linkSourceId ?? seedSource) : via === "sheet" ? seedSource : apiSource;

    const artistsInserted = await client.query(`
      INSERT INTO media.video_artists(video_id, artist_id, relation_kind, confidence, source_id)
      SELECT x.video_id, x.artist_id, x.relation_kind::media.video_relation_kind, 'high', x.source_id
        FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::bigint[]) AS x(video_id, artist_id, relation_kind, source_id)
      ON CONFLICT DO NOTHING`,
    [plan.videoArtists.map((row) => row.videoDbId), plan.videoArtists.map((row) => row.artistId),
      plan.videoArtists.map((row) => row.relationKind), plan.videoArtists.map((row) => sourceFor(row.via, row.linkSourceId))]);

    // El claim que respalda cada ocurrencia es el `youtube_start_seconds` que
    // el canal emitió para esa pista con la URL de ese mismo video.
    const claims = await client.query<{ track_id: string; url: string; claim_id: string }>(`
      SELECT c.track_id::text, e.url, min(c.id)::text AS claim_id
        FROM ingest.claims c JOIN ingest.claim_evidence e ON e.claim_id=c.id
       WHERE c.entity_kind='track' AND c.field='youtube_start_seconds' AND c.track_id IS NOT NULL AND c.source_id=$1
       GROUP BY c.track_id, e.url`, [apiSource]);
    const claimFor = new Map(claims.rows.map((row) => [`${row.track_id}|${row.url}`, Number(row.claim_id)]));
    const trackClaims = plan.videoTracks.map((row) => row.via === "album_link" ? claimFor.get(`${row.trackId}|${canonicalVideoUrl(row.videoId)}`) ?? null : null);
    const tracksInserted = await client.query(`
      INSERT INTO media.video_tracks(video_id, track_id, start_seconds, end_seconds, confidence, source_id, claim_id, notes)
      SELECT x.video_id, x.track_id, x.start_seconds, x.end_seconds, 'high', x.source_id, x.claim_id, 'yt:reconcile'
        FROM unnest($1::bigint[], $2::bigint[], $3::int[], $4::int[], $5::bigint[], $6::bigint[])
             AS x(video_id, track_id, start_seconds, end_seconds, source_id, claim_id)
      ON CONFLICT (video_id, track_id, start_seconds) DO NOTHING`,
    [plan.videoTracks.map((row) => row.videoDbId), plan.videoTracks.map((row) => row.trackId), plan.videoTracks.map((row) => row.startSeconds),
      plan.videoTracks.map((row) => row.endSeconds), plan.videoTracks.map((row) => row.via === "album_link" ? apiSource : sourceFor(row.via, null)), trackClaims]);

    let reviewsCreated = 0;
    for (const verdict of plan.verdicts.filter((item) => QUEUED_CATEGORIES.has(item.category))) {
      // Una revisión descartada es una decisión del propietario: no se reabre.
      const inserted = await client.query(`
        INSERT INTO ingest.review_queue(kind, video_id, priority, payload, notes)
        SELECT 'youtube_match', $1, 4, $2::jsonb, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM ingest.review_queue
            WHERE kind='youtube_match' AND video_id=$1 AND payload->>'via'='yt:reconcile'
              AND status IN ('open','in_progress','dismissed'))`,
      [verdict.videoDbId,
        JSON.stringify({ via: "yt:reconcile", videoId: verdict.videoId, title: verdict.title, kind: verdict.kind, category: verdict.category, reasons: verdict.reasons, proposals: verdict.proposals, tracklist: verdict.tracklist }),
        `${verdict.category}: ${verdict.reasons.join("; ")}`.slice(0, 2000)]);
      reviewsCreated += inserted.rowCount ?? 0;
    }

    const totals = await client.query<{ artists: string; tracks: string; with_claim: string }>(`
      SELECT (SELECT count(*) FROM media.video_artists)::text AS artists,
             (SELECT count(*) FROM media.video_tracks)::text AS tracks,
             (SELECT count(*) FROM media.video_tracks WHERE claim_id IS NOT NULL)::text AS with_claim`);
    const planned = { artists: new Set(plan.videoArtists.map((row) => `${row.videoDbId}|${row.artistId}|${row.relationKind}`)), tracks: new Set(plan.videoTracks.map((row) => `${row.videoDbId}|${row.trackId}|${row.startSeconds}`)) };
    const existing = await client.query<{ key: string; kind: string }>(`
      SELECT video_id || '|' || artist_id || '|' || relation_kind AS key, 'artist' AS kind FROM media.video_artists
      UNION ALL SELECT video_id || '|' || track_id || '|' || start_seconds, 'track' FROM media.video_tracks`);
    const notReDerived = { artists: 0, tracks: 0 };
    for (const row of existing.rows) {
      if (row.kind === "artist" && !planned.artists.has(row.key)) notReDerived.artists += 1;
      if (row.kind === "track" && !planned.tracks.has(row.key)) notReDerived.tracks += 1;
    }

    const summary: ReconcileSummary = {
      ...summarize(plan, snapshot.albums.length),
      videoArtists: { planned: planned.artists.size, inserted: artistsInserted.rowCount ?? 0, total: Number(totals.rows[0]!.artists), notReDerived: notReDerived.artists },
      videoTracks: { planned: planned.tracks.size, inserted: tracksInserted.rowCount ?? 0, total: Number(totals.rows[0]!.tracks), notReDerived: notReDerived.tracks, withClaim: Number(totals.rows[0]!.with_claim) },
      reviewsCreated,
    };
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ ...summary.byCategory, videos: summary.videos, videoArtistsInserted: summary.videoArtists.inserted, videoTracksInserted: summary.videoTracks.inserted, reviewsCreated })]);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");

    const reportFiles = dryRun ? [] : await writeReconciliationReports(summary, plan, options.reportDir ?? "reports");
    log.info({ ...summary.byCategory, dryRun, runId }, "reconciliación del canal");
    return { dryRun, ...(dryRun ? {} : { runId }), summary, plan, reportFiles };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

const CATEGORY_NOTES: Record<ReconcileCategory, string> = {
  MATCHED_HIGH: "todas sus relaciones salen de identidades exactas o de un enlace confirmado; escritas",
  MATCHED_MEDIUM: "relación probable que necesita confirmación humana; en revisión",
  AMBIGUOUS: "varios candidatos igual de plausibles; en revisión",
  UNMATCHED_VIDEO: "no casa con el catálogo (o su relación principal no existe en él)",
  CONFLICT: "las fuentes se contradicen; en revisión, sin tocar el catálogo",
};

export function renderReconciliationMarkdown(summary: ReconcileSummary, plan: ReconcilePlan): string {
  const lines: string[] = [
    "# Reconciliación del canal de YouTube",
    "",
    "> Generado por `crv yt:reconcile` (PHASES.md E6). Determinista: sin IA y sin",
    "> tocar el core. Solo se escriben relaciones de identidad exacta en",
    "> `media.video_artists` y `media.video_tracks`; lo demás va a `youtube_match`.",
    "> La lista completa, incluidos todos los discos sin video, está en",
    "> `youtube-reconciliation.json`.",
    "",
    "## Resumen",
    "",
    "| Medida | Valor |",
    "|---|---|",
    `| Videos | ${summary.videos} |`,
    `| Discos en el catálogo | ${summary.albums} |`,
    ...(Object.keys(summary.byCategory) as ReconcileCategory[]).map((category) => `| ${category} | ${summary.byCategory[category]} — ${CATEGORY_NOTES[category]} |`),
    `| UNMATCHED_ALBUM | ${summary.unmatchedAlbums} discos sin ningún video (${summary.unmatchedAlbumsOfChannelArtists} de artistas presentes en el canal) |`,
    `| Entradas de tracklist | ${summary.tracklistEntries.total} (${summary.tracklistEntries.matched} casadas, ${summary.tracklistEntries.unmatched} sin pista) |`,
    `| media.video_artists | ${summary.videoArtists.total} (${summary.videoArtists.inserted} nuevas en esta corrida; ${summary.videoArtists.notReDerived} existentes que el plan no deriva) |`,
    `| media.video_tracks | ${summary.videoTracks.total} (${summary.videoTracks.inserted} nuevas; ${summary.videoTracks.withClaim} con claim; ${summary.videoTracks.notReDerived} no derivadas) |`,
    `| Revisiones youtube_match nuevas | ${summary.reviewsCreated} |`,
    "",
    "Por tipo de video: " + (Object.entries(summary.byKind) as Array<[VideoKind, number]>).map(([kind, count]) => `${kind} ${count}`).join(" · "),
    "",
  ];
  for (const category of ["CONFLICT", "AMBIGUOUS", "MATCHED_MEDIUM", "UNMATCHED_VIDEO"] as ReconcileCategory[]) {
    const verdicts = plan.verdicts.filter((verdict) => verdict.category === category);
    lines.push(`## ${category} (${verdicts.length})`, "");
    if (verdicts.length === 0) { lines.push("Ninguno.", ""); continue; }
    for (const verdict of verdicts) {
      lines.push(`- **${verdict.title ?? "(sin título)"}** · \`${verdict.videoId}\` · ${verdict.kind}`);
      if (verdict.artists.length) lines.push(`  - artista: ${verdict.artists.join(", ")}`);
      if (verdict.albums.length) lines.push(`  - disco: ${verdict.albums.join(", ")}`);
      for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
      for (const proposal of verdict.proposals) lines.push(`  - propuesta (${proposal.rule}): ${proposal.kind} ${proposal.id} · ${proposal.label}`);
      for (const title of verdict.tracklist?.unmatched ?? []) lines.push(`  - sin pista: «${title}»`);
      for (const mismatch of verdict.tracklist?.startMismatches ?? []) lines.push(`  - «${mismatch.title}» (pista ${mismatch.trackId}): catálogo ${mismatch.core}s, video ${mismatch.video}s`);
    }
    lines.push("");
  }
  const byArtist = new Map<string, UnmatchedAlbum[]>();
  for (const album of plan.unmatchedAlbums.filter((item) => item.artistOnChannel)) byArtist.set(album.artist, [...(byArtist.get(album.artist) ?? []), album]);
  lines.push(`## UNMATCHED_ALBUM de artistas presentes en el canal (${summary.unmatchedAlbumsOfChannelArtists})`, "",
    "Discos sin video cuyo artista sí tiene videos en el canal. No es un error: la",
    "hoja es una discografía curada y el canal no publica todo. Los",
    `${summary.unmatchedAlbums - summary.unmatchedAlbumsOfChannelArtists} discos restantes son de artistas sin ningún video (lista en el JSON).`, "");
  for (const [artist, albums] of [...byArtist].sort((a, b) => a[0].localeCompare(b[0], "es"))) {
    lines.push(`- **${artist}** (${albums.length}): ${albums.map((album) => `${album.title}${album.year ? ` (${album.year})` : ""}`).join(" · ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function writeReconciliationReports(summary: ReconcileSummary, plan: ReconcilePlan, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, "youtube-reconciliation.json");
  const mdPath = path.join(dir, "youtube-reconciliation.md");
  await writeFile(jsonPath, `${JSON.stringify({ summary, verdicts: plan.verdicts, unmatchedAlbums: plan.unmatchedAlbums }, null, 2)}\n`);
  await writeFile(mdPath, renderReconciliationMarkdown(summary, plan));
  return [jsonPath, mdPath];
}
