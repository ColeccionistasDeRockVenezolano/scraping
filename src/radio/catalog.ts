import { excludedFromRadio } from "../youtube/normalization.js";
import { parseYouTubeTitle } from "../youtube/parsers.js";
import { YouTubeDataApi, youtubePublicationStatus, type YouTubeVideoPayload } from "../youtube/api.js";

export const RADIO_CATALOG_VERSION = 2;
export const MIN_TRACK_SECONDS = 30;
export const MAX_TRACK_SECONDS = 30 * 60;

export interface RadioTrackRow {
  video_id: string;
  video_title: string;
  video_duration_seconds: number;
  position: number;
  track_title: string;
  start_seconds: number;
  /** Tipos de la hoja maestra para este video (todas sus filas, separados por coma). */
  sheet_types?: string | null;
}

export interface RadioTrackItem {
  videoId: string;
  title: string;
  artist: string | null;
  album: string;
  year: number | null;
  trackNumber: number;
  startSeconds: number;
  durationSeconds: number;
  available: true;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// La audiencia de la radio es venezolana ante todo.
export const RADIO_HOME_REGION = "VE";
// Un bloqueo que alcanza a cien regiones o más es, en la práctica, mundial.
const WORLDWIDE_REGIONS = 100;

function regions(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === "string") : null;
}

// Un bloqueo regional excluye el video si deja sin sonido a Venezuela o a la
// mayor parte del mundo. Un veto puntual en otros países no lo saca del aire:
// allí el navegador lo salta sin reproducirlo.
function regionPlayable(restriction: Record<string, unknown> | undefined): boolean {
  const allowed = regions(restriction?.["allowed"]);
  if (allowed && (!allowed.includes(RADIO_HOME_REGION) || allowed.length < WORLDWIDE_REGIONS)) return false;
  const blocked = regions(restriction?.["blocked"]) ?? [];
  return !blocked.includes(RADIO_HOME_REGION) && blocked.length < WORLDWIDE_REGIONS;
}

export function livePlayable(payload: YouTubeVideoPayload): boolean {
  const status = payload.status;
  const details = payload.contentDetails;
  return youtubePublicationStatus(status) === "published"
    && status?.["embeddable"] === true
    && (status?.["uploadStatus"] === undefined || status["uploadStatus"] === "processed")
    // Con restricción de edad el reproductor embebido exige iniciar sesión:
    // para quien escucha la radio es un video que no suena.
    && record(details?.["contentRating"])?.["ytRating"] !== "ytAgeRestricted"
    && regionPlayable(record(details?.["regionRestriction"]));
}

/**
 * Revalida contra YouTube en lotes de 50. Un ID ausente de la respuesta se
 * considera eliminado/privado y jamás llega al snapshot público.
 */
export async function livePlayableVideoIds(
  videoIds: string[], api = new YouTubeDataApi(),
): Promise<Set<string>> {
  const playable = new Set<string>();
  const unique = [...new Set(videoIds)];
  for (let offset = 0; offset < unique.length; offset += 50) {
    const response = await api.listVideos(unique.slice(offset, offset + 50));
    for (const payload of response.items ?? []) {
      if (livePlayable(payload)) playable.add(payload.id);
    }
  }
  return playable;
}

/** Convierte capítulos válidos en piezas independientes de la radio. */
export function buildRadioTracks(rows: RadioTrackRow[], playable: ReadonlySet<string>): RadioTrackItem[] {
  const groups = new Map<string, RadioTrackRow[]>();
  for (const row of rows) {
    if (!playable.has(row.video_id)) continue;
    const group = groups.get(row.video_id) ?? [];
    group.push(row);
    groups.set(row.video_id, group);
  }

  const items: RadioTrackItem[] = [];
  for (const group of groups.values()) {
    const head = group[0]!;
    // La hoja manda sobre el título: un concierto subido como "Full Album"
    // sigue siendo un concierto.
    if (excludedFromRadio(head.sheet_types)) continue;
    const parsed = parseYouTubeTitle(head.video_title);
    if (!parsed.isFullAlbum || head.video_duration_seconds < MIN_TRACK_SECONDS) continue;

    // Las descripciones reales contienen unos pocos relojes duplicados o fuera
    // de duración. Ordenar por tiempo y deduplicar evita tramos negativos.
    const byStart = new Map<number, RadioTrackRow>();
    for (const row of group.sort((a, b) => a.position - b.position)) {
      if (Number.isInteger(row.start_seconds)
        && row.start_seconds >= 0
        && row.start_seconds < head.video_duration_seconds
        && !byStart.has(row.start_seconds)) byStart.set(row.start_seconds, row);
    }
    const tracks = [...byStart.values()].sort((a, b) => a.start_seconds - b.start_seconds);
    // Un único timestamp no demuestra dónde termina la canción: podría ser el
    // álbum entero. La radio solo acepta videos realmente capitulados.
    if (tracks.length < 2) continue;

    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index]!;
      const endSeconds = tracks[index + 1]?.start_seconds ?? head.video_duration_seconds;
      const durationSeconds = endSeconds - track.start_seconds;
      if (durationSeconds < MIN_TRACK_SECONDS || durationSeconds > MAX_TRACK_SECONDS) continue;
      items.push({
        videoId: head.video_id,
        title: track.track_title.trim(),
        artist: parsed.artist,
        album: parsed.title,
        year: parsed.year,
        trackNumber: track.position + 1,
        startSeconds: track.start_seconds,
        durationSeconds,
        available: true,
      });
    }
  }
  return items;
}
