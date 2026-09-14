// E10 · Carga de los dosieres: todo lo verificable que el resolutor mira de
// cada caso abierto de la cola. Solo lectura; ninguna consulta toca el core.
import type { PoolClient } from "pg";
import { youtubeLinkKey } from "../youtube/linker.js";
import type { AlbumPairInput, AlbumSide } from "./albums.js";
import { buildPersonIndex, findCompetitors, type PersonPairInput, type PersonSide, type PriorDecision } from "./persons.js";
import { NOT_A_BAND_SQL, SCAN_VIA, loadPersonContext } from "./scan.js";
import type { CaseKind } from "./types.js";
import type { CreditRef, YtAlbum, YtReviewInput } from "./youtube.js";

export const RECONCILE_VIA = "yt:reconcile";

export interface StaleCase { reviewId: number; kind: CaseKind; title: string; reason: string; }
export interface LoadedCases {
  albumPairs: AlbumPairInput[];
  personPairs: PersonPairInput[];
  youtube: YtReviewInput[];
  stale: StaleCase[];
  /** Revisiones abiertas que este resolutor no analiza, por tipo. No se esconden: van al reporte. */
  unsupported: Array<{ kind: string; count: number }>;
}

type Queryable = Pick<PoolClient, "query">;
type Payload = Record<string, unknown>;

const HANDLED = `((kind='possible_duplicate' AND payload->>'via'='${SCAN_VIA}') OR (kind='youtube_match' AND payload->>'via'='${RECONCILE_VIA}'))`;

const asIds = (value: unknown): number[] => Array.isArray(value) ? value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [];

async function loadAlbumSides(client: Queryable, ids: number[]): Promise<Map<number, AlbumSide>> {
  if (!ids.length) return new Map();
  const albums = await client.query<{ id: string; artist_id: string; artist: string; title: string; release_year: number | null; album_type: string; primary_video: string | null }>(`
    SELECT a.id::text, a.artist_id::text, ar.name AS artist, a.title, a.release_year, a.album_type::text,
           (SELECT v.video_id FROM media.video_albums va JOIN media.youtube_videos v ON v.id=va.video_id
             WHERE va.album_id=a.id AND va.is_primary_link LIMIT 1) AS primary_video
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id WHERE a.id = ANY($1::bigint[])`, [ids]);
  const tracks = await client.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string }>(
    "SELECT id::text, album_id::text, disc_number, track_number, title FROM public.tracks WHERE album_id = ANY($1::bigint[]) ORDER BY album_id, disc_number, track_number", [ids]);
  const classifications = await client.query<{ album_id: string; classification: string }>(
    "SELECT album_id::text, classification FROM ingest.album_classifications WHERE album_id = ANY($1::bigint[]) ORDER BY album_id, position", [ids]);
  const sources = await client.query<{ album_id: string; slug: string }>(`
    SELECT DISTINCT c.album_id::text, s.slug FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.album_id = ANY($1::bigint[]) AND c.status <> 'rejected' ORDER BY 1, 2`, [ids]);
  const sides = new Map<number, AlbumSide>();
  for (const row of albums.rows) {
    const id = Number(row.id);
    sides.set(id, {
      id, artistId: Number(row.artist_id), artistName: row.artist, title: row.title, year: row.release_year, type: row.album_type,
      classifications: classifications.rows.filter((item) => Number(item.album_id) === id).map((item) => item.classification),
      tracks: tracks.rows.filter((item) => Number(item.album_id) === id).map((item) => ({ id: Number(item.id), disc: item.disc_number, number: item.track_number, title: item.title })),
      primaryVideoId: row.primary_video, sources: sources.rows.filter((item) => Number(item.album_id) === id).map((item) => item.slug),
    });
  }
  return sides;
}

async function loadPersonSides(client: Queryable, ids: number[]): Promise<Map<number, PersonSide>> {
  if (!ids.length) return new Map();
  const persons = await client.query<{ id: string; name: string; nationality: string | null; birth_date: string | null; death_date: string | null }>(
    "SELECT id::text, name, nationality, birth_date, death_date FROM public.persons WHERE id = ANY($1::bigint[])", [ids]);
  // Sin Various Artists: un recopilatorio no es una banda en común (ver NOT_A_BAND_SQL).
  const artists = await client.query<{ person_id: string; artist_id: string; name: string }>(`
    SELECT m.person_id::text, ar.id::text AS artist_id, ar.name FROM public.artist_members m JOIN public.artists ar ON ar.id=m.artist_id WHERE m.person_id = ANY($1::bigint[]) AND ${NOT_A_BAND_SQL}
    UNION SELECT c.person_id::text, ar.id::text, ar.name FROM public.album_credits c JOIN public.albums a ON a.id=c.album_id JOIN public.artists ar ON ar.id=a.artist_id WHERE c.person_id = ANY($1::bigint[]) AND ${NOT_A_BAND_SQL}
    UNION SELECT c.person_id::text, ar.id::text, ar.name FROM public.track_credits c JOIN public.tracks t ON t.id=c.track_id JOIN public.albums a ON a.id=t.album_id JOIN public.artists ar ON ar.id=a.artist_id WHERE c.person_id = ANY($1::bigint[]) AND ${NOT_A_BAND_SQL}
    ORDER BY 1, 3`, [ids]);
  const albums = await client.query<{ person_id: string; album_id: string; title: string; artist: string; credit_type: string }>(`
    SELECT c.person_id::text, a.id::text AS album_id, a.title, ar.name AS artist, c.credit_type::text FROM public.album_credits c JOIN public.albums a ON a.id=c.album_id JOIN public.artists ar ON ar.id=a.artist_id WHERE c.person_id = ANY($1::bigint[]) AND ${NOT_A_BAND_SQL}
    UNION SELECT c.person_id::text, a.id::text, a.title, ar.name, c.credit_type::text FROM public.track_credits c JOIN public.tracks t ON t.id=c.track_id JOIN public.albums a ON a.id=t.album_id JOIN public.artists ar ON ar.id=a.artist_id WHERE c.person_id = ANY($1::bigint[]) AND ${NOT_A_BAND_SQL}
    ORDER BY 1, 2`, [ids]);
  const references = await client.query<{ person_id: string; total: string }>(`
    SELECT person_id::text, count(*)::text AS total FROM (
      SELECT person_id FROM public.artist_members WHERE person_id = ANY($1::bigint[])
      UNION ALL SELECT person_id FROM public.album_credits WHERE person_id = ANY($1::bigint[])
      UNION ALL SELECT person_id FROM public.track_credits WHERE person_id = ANY($1::bigint[])) x GROUP BY 1`, [ids]);
  const channel = await client.query<{ person_id: string }>(`
    SELECT DISTINCT c.person_id::text FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id AND s.slug='youtube-data-api'
     WHERE c.person_id = ANY($1::bigint[]) AND c.status <> 'rejected'`, [ids]);
  const channelIds = new Set(channel.rows.map((row) => Number(row.person_id)));
  const sides = new Map<number, PersonSide>();
  for (const row of persons.rows) {
    const id = Number(row.id);
    const albumMap = new Map<number, { id: number; title: string; artistName: string; creditTypes: string[] }>();
    for (const item of albums.rows.filter((album) => Number(album.person_id) === id)) {
      const entry = albumMap.get(Number(item.album_id)) ?? { id: Number(item.album_id), title: item.title, artistName: item.artist, creditTypes: [] };
      if (!entry.creditTypes.includes(item.credit_type)) entry.creditTypes.push(item.credit_type);
      albumMap.set(entry.id, entry);
    }
    sides.set(id, {
      id, name: row.name, nationality: row.nationality, birthDate: row.birth_date, deathDate: row.death_date,
      artists: artists.rows.filter((item) => Number(item.person_id) === id).map((item) => ({ id: Number(item.artist_id), name: item.name })),
      albums: [...albumMap.values()], channelCredited: channelIds.has(id),
      references: Number(references.rows.find((item) => Number(item.person_id) === id)?.total ?? 0),
    });
  }
  return sides;
}

/** Decisiones de la Mesa de Cotejo (person_match) que ya separaron o unieron a dos fichas. */
async function loadPriorPersonDecisions(client: Queryable): Promise<Map<string, PriorDecision[]>> {
  const { rows } = await client.query<{ review_id: string; verdict: "same" | "different"; decided_by: string; claim_person: string; candidate: string | null }>(`
    SELECT q.id::text AS review_id, d.verdict, d.decided_by, c.person_id::text AS claim_person, er.candidates->0->>'candidateId' AS candidate
      FROM ingest.review_decisions d
      JOIN ingest.review_queue q ON q.id=d.review_id AND q.kind='person_match'
      JOIN ingest.claims c ON c.id=q.claim_a_id AND c.person_id IS NOT NULL
      LEFT JOIN ingest.entity_resolution_decisions er ON er.id = CASE WHEN q.payload->>'resolutionDecisionId' ~ '^[1-9][0-9]*$' THEN (q.payload->>'resolutionDecisionId')::bigint END
     WHERE d.status='active' AND d.verdict IN ('same','different')`);
  const byPair = new Map<string, PriorDecision[]>();
  for (const row of rows) {
    const a = Number(row.claim_person); const b = Number(row.candidate);
    if (!Number.isSafeInteger(b) || b <= 0 || a === b) continue;
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    byPair.set(key, [...(byPair.get(key) ?? []), { reviewId: Number(row.review_id), verdict: row.verdict, decidedBy: row.decided_by }]);
  }
  return byPair;
}

async function loadYtAlbums(client: Queryable, ids: number[]): Promise<Map<number, YtAlbum>> {
  if (!ids.length) return new Map();
  const albums = await client.query<{ id: string; title: string; release_year: number | null; album_type: string }>(
    "SELECT id::text, title, release_year, album_type::text FROM public.albums WHERE id = ANY($1::bigint[])", [ids]);
  const tracks = await client.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string; duration_seconds: number | null }>(
    "SELECT id::text, album_id::text, disc_number, track_number, title, duration_seconds FROM public.tracks WHERE album_id = ANY($1::bigint[]) ORDER BY album_id, disc_number, track_number", [ids]);
  const classifications = await client.query<{ album_id: string; classification: string }>(
    "SELECT album_id::text, classification FROM ingest.album_classifications WHERE album_id = ANY($1::bigint[]) ORDER BY album_id, position", [ids]);
  const credits = await client.query<{ id: string; album_id: string; credit_type: string; role: string; name: string | null }>(`
    SELECT ac.id::text, ac.album_id::text, ac.credit_type::text, ac.role, coalesce(p.name, o.name, ar.name) AS name
      FROM public.album_credits ac LEFT JOIN public.persons p ON p.id=ac.person_id
      LEFT JOIN public.organizations o ON o.id=ac.organization_id LEFT JOIN public.artists ar ON ar.id=ac.artist_id
     WHERE ac.album_id = ANY($1::bigint[]) ORDER BY ac.album_id, ac.id`, [ids]);
  return new Map(albums.rows.map((row) => {
    const id = Number(row.id);
    const album: YtAlbum = {
      id, title: row.title, year: row.release_year, type: row.album_type,
      classifications: classifications.rows.filter((item) => Number(item.album_id) === id).map((item) => item.classification),
      tracks: tracks.rows.filter((item) => Number(item.album_id) === id).map((item) => ({ id: Number(item.id), disc: item.disc_number, number: item.track_number, title: item.title, durationSeconds: item.duration_seconds })),
      credits: credits.rows.filter((item) => Number(item.album_id) === id && item.name)
        .map((item): CreditRef => ({ id: Number(item.id), name: item.name!, creditType: item.credit_type, role: item.role })),
    };
    return [id, album];
  }));
}

async function loadYouTubeInput(client: Queryable, reviewId: number, videoDbId: number, payload: Payload): Promise<YtReviewInput | StaleCase> {
  const video = (await client.query<{ video_id: string; title: string | null; description: string | null; duration_seconds: number | null; artist_name_raw: string | null; album_name_raw: string | null; album_year_raw: number | null; type_raw: string | null; has_seed: boolean }>(`
    SELECT v.video_id, v.title, v.description, v.duration_seconds, s.artist_name_raw, s.album_name_raw, s.album_year_raw, s.type_raw, s.id IS NOT NULL AS has_seed
      FROM media.youtube_videos v LEFT JOIN ingest.seed_uploads s ON s.id=v.seed_upload_id WHERE v.id=$1`, [videoDbId])).rows[0];
  const title = `${String(payload["title"] ?? "(sin título)")} (${String(payload["videoId"] ?? videoDbId)})`;
  if (!video) return { reviewId, kind: "youtube", title, reason: "el video ya no existe en media.youtube_videos" };
  const entries = (await client.query<{ position: number; title: string; start_seconds: number }>(
    "SELECT position, title, start_seconds FROM media.youtube_tracklist_entries WHERE video_id=$1 ORDER BY position", [videoDbId])).rows;
  const links = (await client.query<{ album_id: string; album_kind: string; is_primary_link: boolean }>(
    "SELECT album_id::text, album_kind::text, is_primary_link FROM media.video_albums WHERE video_id=$1 ORDER BY album_id", [videoDbId])).rows;
  let artist = (await client.query<{ id: string; name: string }>(`
    SELECT ar.id::text, ar.name FROM media.video_artists va JOIN public.artists ar ON ar.id=va.artist_id
     WHERE va.video_id=$1 ORDER BY (va.relation_kind='performer') DESC, ar.id LIMIT 1`, [videoDbId])).rows[0];
  const proposals = Array.isArray(payload["proposals"]) ? payload["proposals"] as Array<{ kind?: string; id?: number }> : [];
  const trackProposalIds = proposals.filter((item) => item.kind === "track").map((item) => Number(item.id));
  const albumProposalIds = proposals.filter((item) => item.kind === "album").map((item) => Number(item.id));
  const kind = String(payload["kind"] ?? "");

  const candidateTracks: YtReviewInput["candidateTracks"] = [];
  if (kind === "music_video" && trackProposalIds.length) {
    const proposed = (await client.query<{ title: string; artist_id: string; artist: string }>(`
      SELECT t.title, a.artist_id::text, ar.name AS artist FROM public.tracks t JOIN public.albums a ON a.id=t.album_id JOIN public.artists ar ON ar.id=a.artist_id
       WHERE t.id = ANY($1::bigint[])`, [trackProposalIds])).rows;
    const artistId = artist ? Number(artist.id) : Number(proposed[0]?.artist_id);
    if (!artist && proposed[0]) artist = { id: proposed[0].artist_id, name: proposed[0].artist };
    const keys = new Set(proposed.map((row) => youtubeLinkKey(row.title)));
    const tracks = (await client.query<{ id: string; album_id: string; title: string; duration_seconds: number | null }>(`
      SELECT t.id::text, t.album_id::text, t.title, t.duration_seconds FROM public.tracks t JOIN public.albums a ON a.id=t.album_id
       WHERE a.artist_id=$1 ORDER BY a.release_year NULLS LAST, t.album_id, t.id`, [artistId])).rows.filter((row) => keys.has(youtubeLinkKey(row.title)));
    const albums = await loadYtAlbums(client, [...new Set(tracks.map((row) => Number(row.album_id)))]);
    for (const row of tracks) {
      const album = albums.get(Number(row.album_id));
      if (album) candidateTracks.push({ trackId: Number(row.id), title: row.title, durationSeconds: row.duration_seconds, album });
    }
  }
  const linkedAlbums = await loadYtAlbums(client, [...new Set([...links.map((link) => Number(link.album_id)), ...albumProposalIds])]);
  const tracklist = payload["tracklist"] as { startMismatches?: YtReviewInput["startMismatches"] } | null | undefined;
  return {
    reviewId, videoDbId, videoId: video.video_id, title: video.title, description: video.description, durationSeconds: video.duration_seconds,
    kind, category: String(payload["category"] ?? ""),
    artist: artist ? { id: Number(artist.id), name: artist.name } : null,
    seed: video.has_seed ? { artist: video.artist_name_raw, album: video.album_name_raw, year: video.album_year_raw, type: video.type_raw } : null,
    tracklist: entries.map((entry) => ({ position: entry.position, title: entry.title, startSeconds: entry.start_seconds })),
    linkedAlbums: links.flatMap((link) => {
      const album = linkedAlbums.get(Number(link.album_id));
      return album ? [{ ...album, albumKind: link.album_kind, isPrimary: link.is_primary_link }] : [];
    }),
    candidateTracks,
    candidateAlbums: albumProposalIds.flatMap((id) => linkedAlbums.get(id) ?? []),
    startMismatches: tracklist?.startMismatches ?? [],
  };
}

export async function loadOpenCases(client: Queryable): Promise<LoadedCases> {
  const reviews = (await client.query<{ id: string; kind: string; payload: Payload | null; video_id: string | null }>(`
    SELECT id::text, kind::text, payload, video_id::text FROM ingest.review_queue
     WHERE status IN ('open','in_progress') AND ${HANDLED} ORDER BY id`)).rows;
  const unsupported = (await client.query<{ kind: string; count: string }>(`
    SELECT kind::text, count(*)::text AS count FROM ingest.review_queue
     WHERE status IN ('open','in_progress') AND NOT ${HANDLED} GROUP BY kind ORDER BY kind`)).rows.map((row) => ({ kind: row.kind, count: Number(row.count) }));

  const loaded: LoadedCases = { albumPairs: [], personPairs: [], youtube: [], stale: [], unsupported };
  const albumReviews = reviews.filter((review) => review.kind === "possible_duplicate" && review.payload?.["entity"] === "album");
  const personReviews = reviews.filter((review) => review.kind === "possible_duplicate" && review.payload?.["entity"] === "person");

  const albumSides = await loadAlbumSides(client, [...new Set(albumReviews.flatMap((review) => asIds(review.payload?.["ids"])))]);
  for (const review of albumReviews) {
    const [aId, bId] = asIds(review.payload?.["ids"]);
    const a = aId === undefined ? undefined : albumSides.get(aId); const b = bId === undefined ? undefined : albumSides.get(bId);
    const titles = Array.isArray(review.payload?.["titles"]) ? (review.payload!["titles"] as string[]).join(" / ") : "";
    if (!a || !b) loaded.stale.push({ reviewId: Number(review.id), kind: "album_pair", title: `${String(review.payload?.["artist"] ?? "")}: ${titles}`, reason: "uno de los dos discos ya no existe (fusionado o retirado)" });
    else loaded.albumPairs.push({ reviewId: Number(review.id), a, b });
  }

  if (personReviews.length) {
    const personSides = await loadPersonSides(client, [...new Set(personReviews.flatMap((review) => asIds(review.payload?.["ids"])))]);
    const prior = await loadPriorPersonDecisions(client);
    const context = await loadPersonContext(client);
    const index = buildPersonIndex((await client.query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons")).rows.map((row) => ({ id: Number(row.id), name: row.name })));
    const indexed = new Map([...index.values()].flat().map((person) => [person.id, person]));
    for (const review of personReviews) {
      const [aId, bId] = asIds(review.payload?.["ids"]);
      const a = aId === undefined ? undefined : personSides.get(aId); const b = bId === undefined ? undefined : personSides.get(bId);
      const names = Array.isArray(review.payload?.["names"]) ? (review.payload!["names"] as string[]).map((name) => `«${name}»`).join(" / ") : "";
      if (!a || !b) { loaded.stale.push({ reviewId: Number(review.id), kind: "person_pair", title: names, reason: "una de las dos personas ya no existe (fusionada o retirada)" }); continue; }
      const ia = indexed.get(a.id); const ib = indexed.get(b.id);
      loaded.personPairs.push({
        reviewId: Number(review.id), a, b, prior: prior.get(`${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`) ?? [],
        competitors: {
          a: ia && ib ? findCompetitors(ia, ib, index, context).map(({ id, name }) => ({ id, name })) : [],
          b: ia && ib ? findCompetitors(ib, ia, index, context).map(({ id, name }) => ({ id, name })) : [],
        },
      });
    }
  }

  for (const review of reviews.filter((item) => item.kind === "youtube_match")) {
    const payload = review.payload ?? {};
    if (review.video_id === null) {
      loaded.stale.push({ reviewId: Number(review.id), kind: "youtube", title: String(payload["title"] ?? "(sin título)"), reason: "la revisión perdió su video" });
      continue;
    }
    const input = await loadYouTubeInput(client, Number(review.id), Number(review.video_id), payload);
    if ("reason" in input) loaded.stale.push(input); else loaded.youtube.push(input);
  }
  return loaded;
}
