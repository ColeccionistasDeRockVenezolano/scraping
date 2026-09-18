// CRV · Fusión de discos (PLAN_CURADURIA E6.5).
//
// Dos discos del mismo artista o recopilatorios equivalentes pueden fusionarse
// con previsualización y hash determinista:
//   1. Empareja pistas por (disco, número) y por título normalizado.
//   2. Las pistas emparejadas se fusionan (créditos y enlaces de YouTube incluidos).
//   3. Las pistas sueltas del disco que desaparece se mueven al disco que queda,
//      reubicando su número si colisiona con una pista existente.
//   4. Los créditos del disco y los formatos equivalentes se unifican.
//   5. Los enlaces de medios (media.video_albums, media.media_links) se repuntan.
//   6. El disco se fusiona mediante `mergeInto('album')`, dejando rastro en
//      `merge_audit` con `version: 2`, compatible con `undoMergeRun`.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { mergeInto, MERGE_EMPTY_VALUES } from "../review/duplicates.js";
import { nameKey } from "../curation/lexicon.js";
import { mergeEquivalentCreditsOnParent } from "./equivalent-relations.js";
import { OperatorError, updateEntity, type OperatorContext } from "./operator.js";
import { resolveRedirect } from "./redirects.js";

export const MERGE_ALBUM_FIELDS = [
  "release_year", "album_type", "genre", "label_id", "cover_url", "description",
  "youtube_url", "youtube_status", "instagram_url", "instagram_status",
  "wordpress_url", "wordpress_status", "notes",
] as const;

export type AlbumMergeField = (typeof MERGE_ALBUM_FIELDS)[number];

export interface AlbumTrackSummary {
  id: number;
  discNumber: number;
  trackNumber: number;
  title: string;
  durationSeconds: number | null;
  creditCount: number;
}

export interface AlbumMergeSide {
  id: number;
  title: string;
  artistId: number;
  artistName: string;
  labelId: number | null;
  labelName: string | null;
  fields: Record<string, unknown>;
  aliases: string[];
  tracks: AlbumTrackSummary[];
  counts: { tracks: number; albumCredits: number; formats: number; mediaLinks: number; claims: number };
}

export interface TrackMatch {
  keepTrackId: number;
  dropTrackId: number;
  keepTitle: string;
  dropTitle: string;
  discNumber: number;
  keepTrackNumber: number;
  dropTrackNumber: number;
  matchType: "position_and_title" | "title" | "position";
}

export interface AlbumMergePreview {
  keep: AlbumMergeSide;
  drop: AlbumMergeSide;
  recommendedKeepId: number;
  matchedTracks: TrackMatch[];
  unmatchedDropTracks: AlbumTrackSummary[];
  fieldConflicts: Array<{ field: AlbumMergeField; keepValue: unknown; dropValue: unknown }>;
  fieldsFilledFromDrop: AlbumMergeField[];
  sharedCredits: Array<{ id: number; role: string; creditType: string; targetName: string }>;
  formatsToAdd: Array<{ id: number; format: string }>;
  warnings: string[];
  previewHash: string;
}

export interface AlbumMergeRequest {
  keepId: number;
  dropId: number;
  previewHash: string;
  fieldChoices?: Partial<Record<AlbumMergeField, "keep" | "drop">> | undefined;
  keepDropNameAsAlias?: boolean | undefined;
}

export interface AlbumMergeResult {
  keepId: number;
  dropId: number;
  auditId: number;
  tracksMerged: number;
  tracksMoved: number;
  creditsMerged: number;
  formatsMerged: number;
  fieldsCorrected: AlbumMergeField[];
  runId?: number;
}

function present(field: string, value: unknown): boolean {
  const empty = MERGE_EMPTY_VALUES[`albums.${field}`];
  if (empty === undefined) return value !== null && value !== undefined;
  if (typeof empty === "boolean") return value === !empty;
  return value !== null && value !== undefined && value !== empty;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadAlbumSide(queryable: Pick<PoolClient, "query">, id: number, lock: boolean): Promise<AlbumMergeSide | null> {
  const { rows } = await queryable.query<{
    row: Record<string, unknown> | null;
    artist_name: string;
    label_name: string | null;
  }>(`
    SELECT to_jsonb(a) AS row, ar.name AS artist_name, org.name AS label_name
      FROM public.albums a
      JOIN public.artists ar ON ar.id = a.artist_id
      LEFT JOIN public.organizations org ON org.id = a.label_id
     WHERE a.id = $1${lock ? " FOR UPDATE OF a" : ""}`, [id]);
  const data = rows[0];
  if (!data || !data.row) return null;
  const row = data.row;

  const fields = Object.fromEntries(MERGE_ALBUM_FIELDS.map((field) => [field, row[field] ?? null]));

  const aliases = (await queryable.query<{ alias: string }>(
    "SELECT alias FROM ingest.album_aliases WHERE album_id=$1 ORDER BY alias", [id]
  )).rows.map((r) => r.alias);

  const tracks = (await queryable.query<{
    id: string; disc_number: number; track_number: number; title: string; duration_seconds: number | null; credit_count: string;
  }>(`
    SELECT t.id::text, t.disc_number, t.track_number, t.title, t.duration_seconds,
           (SELECT count(*) FROM public.track_credits tc WHERE tc.track_id = t.id)::text AS credit_count
      FROM public.tracks t
     WHERE t.album_id = $1
     ORDER BY t.disc_number, t.track_number, t.id`, [id])).rows.map((t) => ({
    id: Number(t.id),
    discNumber: t.disc_number,
    trackNumber: t.track_number,
    title: t.title,
    durationSeconds: t.duration_seconds,
    creditCount: Number(t.credit_count),
  }));

  const countsQuery = await queryable.query<{ album_credits: string; formats: string; media_links: string; claims: string }>(`
    SELECT (SELECT count(*) FROM public.album_credits WHERE album_id=$1)::text AS album_credits,
           (SELECT count(*) FROM public.album_formats WHERE album_id=$1)::text AS formats,
           (SELECT count(*) FROM media.video_albums WHERE album_id=$1)::text AS media_links,
           (SELECT count(*) FROM ingest.claims WHERE album_id=$1)::text AS claims`, [id]);
  const c = countsQuery.rows[0]!;

  return {
    id,
    title: String(row["title"]),
    artistId: Number(row["artist_id"]),
    artistName: data.artist_name,
    labelId: row["label_id"] ? Number(row["label_id"]) : null,
    labelName: data.label_name,
    fields,
    aliases,
    tracks,
    counts: {
      tracks: tracks.length,
      albumCredits: Number(c.album_credits),
      formats: Number(c.formats),
      mediaLinks: Number(c.media_links),
      claims: Number(c.claims),
    },
  };
}

async function albumSideOrThrow(queryable: Pick<PoolClient, "query">, id: number, lock: boolean): Promise<AlbumMergeSide> {
  const side = await loadAlbumSide(queryable, id, lock);
  if (side) return side;
  const moved = await resolveRedirect("album", id, queryable);
  throw new OperatorError("not_found", `álbum ${id} inexistente`, { entity: "album", id, ...(moved ? { movedTo: moved } : {}) });
}

function matchTracks(keepTracks: AlbumTrackSummary[], dropTracks: AlbumTrackSummary[]): {
  matched: TrackMatch[];
  unmatched: AlbumTrackSummary[];
} {
  const matched: TrackMatch[] = [];
  const usedKeep = new Set<number>();
  const unmatched: AlbumTrackSummary[] = [];

  // Paso 1: misma posición y título idéntico/normalizado
  for (const drop of dropTracks) {
    const exact = keepTracks.find((k) => !usedKeep.has(k.id)
      && k.discNumber === drop.discNumber
      && k.trackNumber === drop.trackNumber
      && nameKey(k.title) === nameKey(drop.title));
    if (exact) {
      usedKeep.add(exact.id);
      matched.push({
        keepTrackId: exact.id,
        dropTrackId: drop.id,
        keepTitle: exact.title,
        dropTitle: drop.title,
        discNumber: exact.discNumber,
        keepTrackNumber: exact.trackNumber,
        dropTrackNumber: drop.trackNumber,
        matchType: "position_and_title",
      });
    }
  }

  // Paso 2: mismo título normalizado aunque la posición varíe
  for (const drop of dropTracks) {
    if (matched.some((m) => m.dropTrackId === drop.id)) continue;
    const sameTitle = keepTracks.find((k) => !usedKeep.has(k.id)
      && nameKey(k.title) === nameKey(drop.title));
    if (sameTitle) {
      usedKeep.add(sameTitle.id);
      matched.push({
        keepTrackId: sameTitle.id,
        dropTrackId: drop.id,
        keepTitle: sameTitle.title,
        dropTitle: drop.title,
        discNumber: sameTitle.discNumber,
        keepTrackNumber: sameTitle.trackNumber,
        dropTrackNumber: drop.trackNumber,
        matchType: "title",
      });
    }
  }

  // Paso 3: misma posición (si no hay colisión de títulos contradictorios)
  for (const drop of dropTracks) {
    if (matched.some((m) => m.dropTrackId === drop.id)) continue;
    const samePos = keepTracks.find((k) => !usedKeep.has(k.id)
      && k.discNumber === drop.discNumber
      && k.trackNumber === drop.trackNumber);
    if (samePos) {
      usedKeep.add(samePos.id);
      matched.push({
        keepTrackId: samePos.id,
        dropTrackId: drop.id,
        keepTitle: samePos.title,
        dropTitle: drop.title,
        discNumber: samePos.discNumber,
        keepTrackNumber: samePos.trackNumber,
        dropTrackNumber: drop.trackNumber,
        matchType: "position",
      });
    } else {
      unmatched.push(drop);
    }
  }

  return { matched, unmatched };
}

export async function previewAlbumMerge(
  queryable: Pick<PoolClient, "query">, keepId: number, dropId: number,
  options: { lock?: boolean } = {},
): Promise<AlbumMergePreview> {
  if (keepId === dropId) throw new OperatorError("invalid", "no se puede fusionar un disco consigo mismo", { entity: "album", id: keepId });
  const lock = options.lock ?? false;
  const keep = await albumSideOrThrow(queryable, keepId, lock);
  const drop = await albumSideOrThrow(queryable, dropId, lock);

  const fieldConflicts: AlbumMergePreview["fieldConflicts"] = [];
  const fieldsFilledFromDrop: AlbumMergeField[] = [];
  for (const field of MERGE_ALBUM_FIELDS) {
    const keepPresent = present(field, keep.fields[field]);
    const dropPresent = present(field, drop.fields[field]);
    if (!keepPresent && dropPresent) {
      fieldsFilledFromDrop.push(field);
    } else if (keepPresent && dropPresent && !sameValue(keep.fields[field], drop.fields[field])) {
      fieldConflicts.push({ field, keepValue: keep.fields[field], dropValue: drop.fields[field] });
    }
  }

  const { matched: matchedTracks, unmatched: unmatchedDropTracks } = matchTracks(keep.tracks, drop.tracks);

  const warnings: string[] = [];
  if (keep.artistId !== drop.artistId) {
    warnings.push(`Artistas distintos: «${keep.artistName}» (${keep.artistId}) contra «${drop.artistName}» (${drop.artistId}).`);
  }
  if (keep.fields["release_year"] && drop.fields["release_year"] && keep.fields["release_year"] !== drop.fields["release_year"]) {
    warnings.push(`Años de publicación distintos (${keep.fields["release_year"]} vs ${drop.fields["release_year"]}).`);
  }
  if (keep.tracks.length !== drop.tracks.length) {
    warnings.push(`Distinto número de pistas: ${keep.tracks.length} en el disco que queda, ${drop.tracks.length} en el que desaparece.`);
  }

  // Créditos compartidos
  const sharedCredits = (await queryable.query<{
    id: string; role: string; credit_type: string; target_name: string;
  }>(`
    SELECT c.id::text, c.role, c.credit_type::text,
           COALESCE(p.name, ar.name, org.name, '?') AS target_name
      FROM public.album_credits c
      LEFT JOIN public.persons p ON p.id = c.person_id
      LEFT JOIN public.artists ar ON ar.id = c.artist_id
      LEFT JOIN public.organizations org ON org.id = c.organization_id
     WHERE c.album_id = $1
     ORDER BY c.credit_type, c.role`, [dropId])).rows.map((c) => ({
    id: Number(c.id),
    role: c.role,
    creditType: c.credit_type,
    targetName: c.target_name,
  }));

  // Formatos que se incorporarán
  const formatsToAdd = (await queryable.query<{ id: string; format: string }>(`
    SELECT f.id::text, f.format
      FROM public.album_formats f
     WHERE f.album_id = $1
       AND NOT EXISTS (SELECT 1 FROM public.album_formats kf WHERE kf.album_id = $2 AND kf.format = f.format)
     ORDER BY f.id`, [dropId, keepId])).rows.map((f) => ({ id: Number(f.id), format: f.format }));

  // Criterio de recomendación: más pistas o más referencias
  const keepScore = keep.tracks.length * 10 + keep.counts.albumCredits + keep.counts.mediaLinks;
  const dropScore = drop.tracks.length * 10 + drop.counts.albumCredits + drop.counts.mediaLinks;
  const recommendedKeepId = keepScore >= dropScore ? keep.id : drop.id;

  const previewHash = createHash("sha256").update(JSON.stringify([
    "album",
    keep.id, keep.title, keep.fields, keep.tracks.map((t) => [t.discNumber, t.trackNumber, t.title]),
    drop.id, drop.title, drop.fields, drop.tracks.map((t) => [t.discNumber, t.trackNumber, t.title]),
    matchedTracks.map((m) => [m.keepTrackId, m.dropTrackId, m.matchType]),
  ])).digest("hex");

  return {
    keep,
    drop,
    recommendedKeepId,
    matchedTracks,
    unmatchedDropTracks,
    fieldConflicts,
    fieldsFilledFromDrop,
    sharedCredits,
    formatsToAdd,
    warnings,
    previewHash,
  };
}

export async function mergeAlbums(context: OperatorContext, request: AlbumMergeRequest): Promise<AlbumMergeResult> {
  const { keepId, dropId } = request;
  await context.client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");

  const preview = await previewAlbumMerge(context.client, keepId, dropId, { lock: true });
  if (preview.previewHash !== request.previewHash) {
    throw new OperatorError("stale_preview", "el disco cambió desde la previsualización", {
      entity: "album", keepId, dropId, previewHash: preview.previewHash,
    });
  }

  // 1. Correcciones de campo elegidas de drop
  const fieldsCorrected: AlbumMergeField[] = [];
  for (const conflict of preview.fieldConflicts) {
    if (request.fieldChoices?.[conflict.field] !== "drop") continue;
    await updateEntity(context, "album", keepId, { [conflict.field]: conflict.dropValue });
    fieldsCorrected.push(conflict.field);
  }

  // 2. Fusión física de pistas emparejadas
  let tracksMerged = 0;
  for (const match of preview.matchedTracks) {
    if (match.keepTrackId === match.dropTrackId) continue;
    await mergeInto(context.client, "track", match.keepTrackId, match.dropTrackId, context.note, context.runId, { alias: false });
    await mergeEquivalentCreditsOnParent(context.client, { kind: "track", id: match.keepTrackId }, context.note, context.runId);
    tracksMerged += 1;
  }

  // 3. Pistas no emparejadas: mover al álbum destino evitando colisiones en tracks_position_uk
  let tracksMoved = 0;
  for (const track of preview.unmatchedDropTracks) {
    const existing = (await context.client.query<{ max_track: number | null }>(`
      SELECT max(track_number) AS max_track FROM public.tracks WHERE album_id=$1 AND disc_number=$2`,
    [keepId, track.discNumber])).rows[0];
    const maxTrack = existing?.max_track ?? 0;
    // Si la posición colisiona con una existente en keep, asignar max + 1
    const collides = (await context.client.query("SELECT 1 FROM public.tracks WHERE album_id=$1 AND disc_number=$2 AND track_number=$3",
      [keepId, track.discNumber, track.trackNumber])).rowCount;
    const finalNumber = collides ? maxTrack + 1 : track.trackNumber;

    await context.client.query(
      "UPDATE public.tracks SET album_id=$1, track_number=$2 WHERE id=$3",
      [keepId, finalNumber, track.id],
    );
    tracksMoved += 1;
  }

  // 4. Formatos: los que no colisionan se pasan; los duplicados se consolidan
  let formatsMerged = 0;
  for (const fmt of preview.formatsToAdd) {
    await context.client.query("UPDATE public.album_formats SET album_id=$1 WHERE id=$2", [keepId, fmt.id]);
    formatsMerged += 1;
  }

  // 5. Créditos de disco equivalentes se unifican
  const creditsMerged = await mergeEquivalentCreditsOnParent(
    context.client, { kind: "album", id: keepId }, context.note, context.runId,
  );

  // 6. Enlaces de medios: video_albums y media_links
  await context.client.query("UPDATE media.video_albums SET album_id=$1 WHERE album_id=$2", [keepId, dropId]);
  await context.client.query("UPDATE media.media_links SET album_id=$1 WHERE album_id=$2", [keepId, dropId]);

  // 7. Fusión final del disco vía mergeInto
  const merged = await mergeInto(
    context.client, "album", keepId, dropId, context.note, context.runId,
    { alias: request.keepDropNameAsAlias ?? false },
  );


  return {
    keepId,
    dropId,
    auditId: merged.auditId,
    tracksMerged,
    tracksMoved,
    creditsMerged,
    formatsMerged,
    fieldsCorrected,
    runId: context.runId,
  };
}
