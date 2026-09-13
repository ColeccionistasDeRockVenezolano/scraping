// Clasificaciones de la hoja por disco (migración 0011).
//
// El core guarda un solo `album_type`; la hoja maestra, fuente de los tipos por
// decisión del propietario, escribe varias por disco ("Solo Artist, Studio
// Album"). Esta proyección las guarda todas sin tocar el core y se regenera
// entera desde `ingest.seed_uploads`.
//
// Una fila con video se ata a su disco SOLO por el enlace del video: por nombre,
// el videoclip "Otra Tarde Más" acabaría clasificando al single del mismo
// título. Las filas sin video se atan por artista (o alias) + título + año, y
// solo cuando el resultado es único.
import { getPool } from "../db/client.js";
import { normalizeEntityName } from "../normalization/entity-name.js";
import { inferSheetType, inferredTypeLabel, sheetClassifications } from "./normalization.js";

export interface ClassificationSyncResult {
  rows: number; matched: number; unmatched: number; ambiguous: number;
  albums: number; classifications: number; inferred: number; dryRun: boolean;
}

export interface SheetClassificationRow {
  type_raw: string | null; artist_name_raw: string | null; album_name_raw: string | null;
}

/** Lo que la celda dice, en su orden; vacía, el tipo inferido y marcado como tal. */
export function rowClassifications(row: SheetClassificationRow): Array<{ classification: string; inferred: boolean }> {
  const written = sheetClassifications(row.type_raw).filter((part) => part.toLowerCase() !== "empty");
  if (written.length > 0) return written.map((classification) => ({ classification: classification.slice(0, 60), inferred: false }));
  const inferred = inferSheetType(row.artist_name_raw, row.album_name_raw);
  return inferred ? [{ classification: inferredTypeLabel(inferred), inferred: true }] : [];
}

interface SeedRow extends SheetClassificationRow { id: string; album_year_raw: number | null; video_id: string | null; }

const nameKey = (value: string): string => normalizeEntityName(value).secondaryKey;

export async function syncAlbumClassifications(options: { dryRun?: boolean } = {}): Promise<ClassificationSyncResult> {
  const pool = getPool();
  const seeds = (await pool.query<SeedRow>(`
    SELECT id::text, artist_name_raw, album_name_raw, album_year_raw, type_raw, video_id
      FROM ingest.seed_uploads ORDER BY upload_order`)).rows;
  const links = (await pool.query<{ video_id: string; album_id: string }>(`
    SELECT v.video_id, va.album_id::text FROM media.video_albums va JOIN media.youtube_videos v ON v.id=va.video_id`)).rows;
  const albums = (await pool.query<{ id: string; title: string; release_year: number | null; names: string[] }>(`
    SELECT a.id::text, a.title, a.release_year,
           array_remove(array_agg(DISTINCT ar.name) || array_agg(DISTINCT al.alias), NULL) AS names
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
      LEFT JOIN ingest.artist_aliases al ON al.artist_id=ar.id
     GROUP BY a.id`)).rows;

  const albumsByVideo = new Map<string, Set<string>>();
  for (const link of links) albumsByVideo.set(link.video_id, (albumsByVideo.get(link.video_id) ?? new Set()).add(link.album_id));
  const albumsByName = new Map<string, Array<{ id: string; year: number | null }>>();
  for (const album of albums) {
    for (const name of new Set(album.names.map(nameKey))) {
      const releaseKey = `${name}::${nameKey(album.title)}`;
      albumsByName.set(releaseKey, [...(albumsByName.get(releaseKey) ?? []), { id: album.id, year: album.release_year }]);
    }
  }

  const planned = new Map<string, Array<{ classification: string; inferred: boolean; seedUploadId: string }>>();
  const result: ClassificationSyncResult = { rows: seeds.length, matched: 0, unmatched: 0, ambiguous: 0, albums: 0, classifications: 0, inferred: 0, dryRun: options.dryRun === true };
  for (const row of seeds) {
    const classes = rowClassifications(row);
    if (classes.length === 0 || !row.artist_name_raw || !row.album_name_raw) continue;
    let targets: string[];
    if (row.video_id) {
      targets = [...(albumsByVideo.get(row.video_id) ?? [])];
    } else {
      const candidates = albumsByName.get(`${nameKey(row.artist_name_raw)}::${nameKey(row.album_name_raw)}`) ?? [];
      const sameYear = candidates.filter((album) => row.album_year_raw === null || album.year === null || album.year === row.album_year_raw);
      targets = [...new Set(sameYear.map((album) => album.id))];
    }
    if (targets.length === 0) { result.unmatched += 1; continue; }
    if (targets.length > 1) { result.ambiguous += 1; continue; }
    result.matched += 1;
    const list = planned.get(targets[0]!) ?? [];
    for (const item of classes) {
      if (!list.some((existing) => existing.classification.toLowerCase() === item.classification.toLowerCase())) list.push({ ...item, seedUploadId: row.id });
    }
    planned.set(targets[0]!, list);
  }
  result.albums = planned.size;
  for (const list of planned.values()) {
    result.classifications += list.length;
    result.inferred += list.filter((item) => item.inferred).length;
  }
  if (options.dryRun === true) return result;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM ingest.album_classifications");
    for (const [albumId, list] of planned) {
      for (const [index, item] of list.entries()) {
        await client.query(`
          INSERT INTO ingest.album_classifications(album_id,classification,position,inferred,seed_upload_id)
          VALUES($1,$2,$3,$4,$5)`, [albumId, item.classification, index + 1, item.inferred, item.seedUploadId]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return result;
}
