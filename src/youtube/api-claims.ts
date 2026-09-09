// A2 · El canal como fuente de claims, no como espejo.
//
// Los pasos 1-3 dejaron 646 videos hidratados, 6.792 pistas y 2.396 secciones
// en `media.*`. Nada de eso tocaba el core: `persistVideoPayload` escribe el
// espejo y no emite un solo claim, así que el catálogo seguía sin enterarse.
//
// Este módulo mete lo derivado por la puerta normal —adapter → normalización
// → claims → ER → merge— igual que `seed-claims.ts` hace con la hoja. No abre
// ninguna vía nueva al core.
//
// Tres decisiones que conviene ver explicadas:
//
//  * QUÉ ES PUBLICACIÓN. Solo los videos con el marcador `|| Full Album ||`
//    del título producen álbum. La regla no es una conjetura: de los 596 que
//    lo llevan, la hoja clasifica 425 como `release` y 56 como `review`, y
//    NINGUNO como `media`; de los 50 que no lo llevan, 32 son `media` para la
//    hoja. Las dos clasificaciones nunca se contradicen. Un videoclip, un
//    concierto o un documental siguen sin crear disco (SOURCES.md §2).
//  * SALE COMO CANDIDATO, igual que el seed. El canal es del propio proyecto
//    y su trust_level es 'api', pero quien lo está leyendo aquí es un
//    programa. La decisión humana se expresa después, aprobando el lote
//    (`review approve-batch --source=youtube-data-api`).
//  * UN NOMBRE DUDOSO NO SE EMITE. Los créditos con cifras, punto y coma o
//    salvedades ("Produced by X, except; Track 12 by Y") se descartan en el
//    parser: convertirlos en persona inventaría a alguien que no existe.
import { getPool } from "../db/client.js";
import { ingestRecords, type IngestionResult } from "../ingest/runner.js";
import { moduleLogger } from "../logger/index.js";
import type { Evidence, RawRecord } from "../adapters/contracts.js";
import { canonicalVideoUrl } from "./normalization.js";
import { parseCreditSections, parseYouTubeDescription, parseYouTubeTitle, type DescriptionSection } from "./parsers.js";

const log = moduleLogger("youtube:api-claims");

export const YT_API_SOURCE_SLUG = "youtube-data-api";
const EXTRACTOR = "youtube-data-api";
const EXTRACTOR_VERSION = "1";

/** `[EP]`/`[Single]` del título contra el enum album_type del core. */
const FORMAT_TO_ALBUM_TYPE: Readonly<Record<string, string>> = { ep: "ep", single: "single" };

export interface ApiClaimsResult {
  videos: number; releases: number; mediaOnly: number; skipped: number;
  artists: number; albums: number; tracks: number; persons: number; organizations: number;
  albumCredits: number; trackCredits: number;
  claimsInserted: number; claimsReused: number; runId?: number;
}

interface VideoRow {
  video_id: string; title: string | null; description: string | null;
  duration_seconds: number | null; publication_status: string | null;
}
interface TrackRow { video_id: string; position: number; title: string; start_seconds: number; }

export async function readHydratedVideos(): Promise<{ videos: VideoRow[]; tracks: Map<string, TrackRow[]> }> {
  const pool = getPool();
  const videos = await pool.query<VideoRow>(`
    SELECT video_id, title, coalesce(metadata->'snippet'->>'description', description) AS description,
           duration_seconds, publication_status::text AS publication_status
      FROM media.youtube_videos
     WHERE last_fetched_at IS NOT NULL
     ORDER BY video_id`);
  const tracks = await pool.query<TrackRow>(`
    SELECT v.video_id, t.position, t.title, t.start_seconds
      FROM media.youtube_tracklist_entries t
      JOIN media.youtube_videos v ON v.id = t.video_id
     ORDER BY v.video_id, t.position`);
  const byVideo = new Map<string, TrackRow[]>();
  for (const row of tracks.rows) {
    const list = byVideo.get(row.video_id) ?? [];
    list.push(row);
    byVideo.set(row.video_id, list);
  }
  return { videos: videos.rows, tracks: byVideo };
}

function evidenceFor(videoId: string, selector: string, excerpt: string): Evidence {
  return { url: canonicalVideoUrl(videoId), selector, excerpt: excerpt.slice(0, 500) };
}

/**
 * La duración de una pista es la distancia hasta la siguiente marca; la
 * última llega hasta el final del video. Es aritmética sobre lo que el canal
 * afirma, no una estimación: si el video no declara duración, la última pista
 * simplemente no lleva el campo.
 */
function trackDuration(tracks: TrackRow[], index: number, videoSeconds: number | null): number | null {
  const start = tracks[index]!.start_seconds;
  const next = tracks[index + 1]?.start_seconds ?? videoSeconds;
  if (next === null || next === undefined) return null;
  const seconds = next - start;
  return seconds > 0 ? seconds : null;
}

export function recordsForVideo(
  video: VideoRow,
  tracks: TrackRow[],
  sections: DescriptionSection[],
  verbCredits: ReturnType<typeof parseYouTubeDescription>["credits"],
  artistsSeen: Set<string>,
  personsSeen: Set<string>,
  organizationsSeen: Set<string>,
): { records: RawRecord[]; isRelease: boolean; skipped: boolean } {
  const parsed = parseYouTubeTitle(video.title ?? "");
  const artist = parsed.artist;
  const album = parsed.title;
  if (!artist || !album) return { records: [], isRelease: false, skipped: true };

  const records: RawRecord[] = [];
  const head = evidenceFor(video.video_id, "snippet.title", video.title ?? "");

  if (!artistsSeen.has(artist.toLowerCase())) {
    artistsSeen.add(artist.toLowerCase());
    records.push({
      entityKind: "artist", identity: artist, extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION,
      fields: [{ field: "name", value: artist, evidence: head }],
    });
  }

  // Sin marcador de disco no hay publicación: es videoclip, concierto,
  // documental o pieza editorial. El artista sí queda afirmado.
  if (!parsed.isFullAlbum) return { records, isRelease: false, skipped: false };

  const albumIdentity = `${artist}::${album}`.slice(0, 250);
  const albumFields: RawRecord["fields"] = [
    { field: "title", value: album, evidence: head },
    { field: "artist_name", value: artist, evidence: head },
    { field: "youtube_url", value: canonicalVideoUrl(video.video_id), evidence: head },
  ];
  if (parsed.year !== null) albumFields.push({ field: "release_year", value: String(parsed.year), evidence: head });
  const albumType = parsed.format ? FORMAT_TO_ALBUM_TYPE[parsed.format.toLowerCase()] : undefined;
  if (albumType) albumFields.push({ field: "album_type", value: albumType, evidence: head });
  if (video.publication_status) albumFields.push({ field: "youtube_status", value: video.publication_status, evidence: head });
  records.push({ entityKind: "album", identity: albumIdentity, extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION, fields: albumFields });

  for (const [index, track] of tracks.entries()) {
    const where = evidenceFor(video.video_id, `tracklist:${track.position}`, track.title);
    const fields: RawRecord["fields"] = [
      { field: "title", value: track.title, evidence: where },
      { field: "track_number", value: String(index + 1), evidence: where },
      { field: "album_title", value: album, evidence: where },
      { field: "artist_name", value: artist, evidence: where },
      { field: "youtube_start_seconds", value: String(track.start_seconds), evidence: where },
    ];
    const seconds = trackDuration(tracks, index, video.duration_seconds);
    if (seconds !== null) fields.push({ field: "duration_seconds", value: String(seconds), evidence: where });
    records.push({
      entityKind: "track", identity: `${artist}::${album}::${track.title}`.slice(0, 250),
      extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION, fields,
    });
  }

  const emitCredit = (name: string, role: string, trackNumbers: number[], selector: string, excerpt: string, kind: "person" | "organization" = "person", location?: string | null): void => {
    const where = evidenceFor(video.video_id, selector, excerpt);
    // Cuando el acreditado es la propia banda del disco, se declara: probar
    // `person` primero engancharía el nombre del grupo a un homónimo.
    const isSelf = kind === "person" && name.toLowerCase() === artist.toLowerCase();
    const seen = kind === "person" ? personsSeen : organizationsSeen;
    if (!isSelf && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      const entityFields: RawRecord["fields"] = [{ field: "name", value: name, evidence: where }];
      if (kind === "organization") {
        entityFields.push({ field: "organization_type", value: "recording_studio", evidence: where });
        if (location) entityFields.push({ field: "country", value: location, evidence: where });
      }
      records.push({ entityKind: kind, identity: name, extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION, fields: entityFields });
    }
    const scoped = trackNumbers.length > 0;
    const fields: RawRecord["fields"] = [
      { field: "credited_name", value: name, evidence: where },
      { field: "credit_role", value: role, evidence: where },
      { field: "album_title", value: album, evidence: where },
      { field: "artist_name", value: artist, evidence: where },
      { field: "credited_kind", value: isSelf ? "artist" : kind, evidence: where },
    ];
    if (scoped) fields.push({ field: "track_numbers", value: trackNumbers.join(","), evidence: where });
    records.push({
      entityKind: scoped ? "track_credit" : "album_credit",
      identity: `${artist}::${album}::${name}::${role}${scoped ? `::${trackNumbers.join(",")}` : ""}`.slice(0, 250),
      extractor: EXTRACTOR, extractorVersion: EXTRACTOR_VERSION, fields,
    });
  };

  for (const credit of parseCreditSections(sections)) {
    emitCredit(credit.name, credit.role, credit.trackNumbers, `section:${credit.sectionKind}`, `${credit.role}: ${credit.name}`);
  }
  // "Recorded & Mixed by Jesús Jiménez at Optilaser (Caracas, Venezuela)" son
  // varios hechos en una línea: dos verbos, una persona y un estudio. Se
  // emite un crédito por verbo —para que `credit_type` no pierda la mitad al
  // clasificar— y el estudio va aparte, como organización acreditada.
  for (const credit of verbCredits) {
    for (const verb of credit.verbs) {
      for (const name of credit.names) {
        emitCredit(name, verb, [], `section:${credit.sectionKind}`, `${verb} by ${name}`);
      }
      if (credit.venue) {
        emitCredit(credit.venue, `${verb} at`, [], `section:${credit.sectionKind}`, `${verb} at ${credit.venue}`, "organization", credit.location);
      }
    }
  }

  return { records, isRelease: true, skipped: false };
}

/** Emite los claims del canal ya hidratado. Idempotente: el hash los reusa. */
export async function ingestYouTubeApiClaims(options: { dryRun?: boolean } = {}): Promise<ApiClaimsResult> {
  const { videos, tracks } = await readHydratedVideos();
  if (videos.length === 0) throw new Error("no hay videos hidratados: ejecuta `crv youtube sync` primero");

  const artistsSeen = new Set<string>(); const personsSeen = new Set<string>(); const organizationsSeen = new Set<string>();
  const records: RawRecord[] = [];
  let releases = 0, mediaOnly = 0, skipped = 0;

  for (const video of videos) {
    const parsedDescription = parseYouTubeDescription(video.description);
    const result = recordsForVideo(video, tracks.get(video.video_id) ?? [], parsedDescription.sections, parsedDescription.credits, artistsSeen, personsSeen, organizationsSeen);
    if (result.skipped) { skipped += 1; continue; }
    if (result.isRelease) releases += 1; else mediaOnly += 1;
    records.push(...result.records);
  }

  const count = (kind: string): number => records.filter((record) => record.entityKind === kind).length;
  const ingestion: IngestionResult = await ingestRecords(YT_API_SOURCE_SLUG, records, {
    confidence: "low",
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });

  const result: ApiClaimsResult = {
    videos: videos.length, releases, mediaOnly, skipped,
    artists: count("artist"), albums: count("album"), tracks: count("track"), persons: count("person"), organizations: count("organization"),
    albumCredits: count("album_credit"), trackCredits: count("track_credit"),
    claimsInserted: ingestion.claimsInserted, claimsReused: ingestion.claimsReused,
    ...(ingestion.runId === undefined ? {} : { runId: ingestion.runId }),
  };
  log.info({ ...result, dryRun: options.dryRun === true }, "claims del canal emitidos");
  return result;
}
