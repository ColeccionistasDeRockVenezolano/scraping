// CRV · Etapa 1 de PLAN_GENEROS_CATALOGO_Y_RADIO_CRV.md.
//
//   npm run genres:coverage
//
// Mide, contra la base de desarrollo, qué géneros ya publican las fuentes
// incorporadas, por fuente y por nivel (artista / álbum), y deja el
// inventario completo de valores que alimentará la taxonomía de la etapa 2.
// Solo lee: ninguna fila del core ni de ingest se toca.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getEnv } from "../src/config/env.js";
import {
  classifyGenreValue, renderGenreSourceCoverageMarkdown,
  type GenreSourceCoverageReport, type GenreValueRow, type MultiSourceEntity, type SourceLevelCoverageRow,
} from "../src/curation/genre-coverage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../reports");

async function main(): Promise<void> {
  const env = getEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    // Denominador por fuente y nivel: entidades que la fuente afirmó alguna
    // vez (por su claim de identidad, `name` o `title`), tenga o no género.
    const totals = await client.query<{ source_slug: string; source_name: string; entity_kind: "artist" | "album"; total_entities: string }>(`
      SELECT s.slug AS source_slug, s.name AS source_name, c.entity_kind,
             count(DISTINCT CASE WHEN c.entity_kind = 'artist' THEN c.artist_id ELSE c.album_id END) AS total_entities
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.entity_kind IN ('artist', 'album') AND c.field IN ('name', 'title')
       GROUP BY s.slug, s.name, c.entity_kind`);

    const genreTotals = await client.query<{ source_slug: string; source_name: string; entity_kind: "artist" | "album"; genre_claims: string; entities_with_genre: string; distinct_values: string }>(`
      SELECT s.slug AS source_slug, s.name AS source_name, c.entity_kind,
             count(*) AS genre_claims,
             count(DISTINCT CASE WHEN c.entity_kind = 'artist' THEN c.artist_id ELSE c.album_id END) AS entities_with_genre,
             count(DISTINCT (c.raw_value #>> '{}')) AS distinct_values
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.field = 'genre'
       GROUP BY s.slug, s.name, c.entity_kind`);

    const valueInventory = await client.query<{ entity_kind: "artist" | "album"; value: string; claims: string; sources: string[] }>(`
      SELECT c.entity_kind, (c.raw_value #>> '{}') AS value, count(*) AS claims,
             array_agg(DISTINCT s.slug ORDER BY s.slug) AS sources
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.field = 'genre'
       GROUP BY c.entity_kind, value
       ORDER BY c.entity_kind, claims DESC`);

    const multiSource = await client.query<{ entity_kind: "artist" | "album"; entity_id: string; sources: string[]; values: string[] }>(`
      SELECT c.entity_kind,
             (CASE WHEN c.entity_kind = 'artist' THEN c.artist_id ELSE c.album_id END) AS entity_id,
             array_agg(DISTINCT s.slug ORDER BY s.slug) AS sources,
             array_agg(DISTINCT (c.raw_value #>> '{}') ORDER BY (c.raw_value #>> '{}')) AS values
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE c.field = 'genre'
       GROUP BY c.entity_kind, entity_id
      HAVING count(DISTINCT s.slug) > 1
       ORDER BY c.entity_kind, entity_id`);

    const albumsProjection = await client.query<{ total: string; with_genre: string; distinct_values: string }>(
      "SELECT count(*) AS total, count(genre) AS with_genre, count(DISTINCT genre) AS distinct_values FROM public.albums");

    const withoutGenre = await client.query<{ source_slug: string; source_name: string; total_claims: string; distinct_fields: string }>(`
      SELECT s.slug AS source_slug, s.name AS source_name, count(*) AS total_claims, count(DISTINCT c.field) AS distinct_fields
        FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
       WHERE s.slug NOT IN (SELECT DISTINCT s2.slug FROM ingest.claims c2 JOIN ingest.sources s2 ON s2.id = c2.source_id WHERE c2.field = 'genre')
       GROUP BY s.slug, s.name
       ORDER BY s.slug`);

    await client.query("COMMIT");

    const bySourceAndLevel: SourceLevelCoverageRow[] = [];
    const totalsBySourceLevel = new Map<string, number>();
    for (const row of totals.rows) totalsBySourceLevel.set(`${row.source_slug}::${row.entity_kind}`, Number(row.total_entities));
    for (const row of genreTotals.rows) {
      const key = `${row.source_slug}::${row.entity_kind}`;
      bySourceAndLevel.push({
        sourceSlug: row.source_slug, sourceName: row.source_name, level: row.entity_kind,
        totalEntities: totalsBySourceLevel.get(key) ?? Number(row.entities_with_genre),
        entitiesWithGenre: Number(row.entities_with_genre), genreClaims: Number(row.genre_claims),
        distinctValues: Number(row.distinct_values),
      });
    }
    bySourceAndLevel.sort((a, b) => a.sourceSlug.localeCompare(b.sourceSlug) || a.level.localeCompare(b.level));

    const valueRows: GenreValueRow[] = valueInventory.rows.map((row) => ({
      level: row.entity_kind, value: row.value, claims: Number(row.claims),
      shape: classifyGenreValue(row.value), sources: row.sources,
    }));

    const multiSourceEntities: MultiSourceEntity[] = multiSource.rows.map((row) => ({
      level: row.entity_kind, entityId: Number(row.entity_id), sources: row.sources, values: row.values,
    }));

    const report: GenreSourceCoverageReport = {
      generatedAt: new Date().toISOString(),
      bySourceAndLevel,
      valueInventory: valueRows,
      albumsGenreProjection: {
        totalAlbums: Number(albumsProjection.rows[0]!.total),
        albumsWithGenre: Number(albumsProjection.rows[0]!.with_genre),
        distinctGenreValues: Number(albumsProjection.rows[0]!.distinct_values),
      },
      multiSourceEntities,
      sourcesWithoutGenreEvidence: withoutGenre.rows.map((row) => ({
        sourceSlug: row.source_slug, sourceName: row.source_name,
        totalClaims: Number(row.total_claims), distinctFields: Number(row.distinct_fields),
      })),
    };

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "genre-source-coverage.json"), JSON.stringify(report, null, 2));
    await writeFile(path.join(OUT_DIR, "genre-source-coverage.md"), renderGenreSourceCoverageMarkdown(report));

    process.stdout.write(
      `Reporte de cobertura de géneros escrito en ${OUT_DIR}/genre-source-coverage.{json,md}\n`
      + `  filas fuente×nivel: ${bySourceAndLevel.length} · valores distintos: ${valueRows.length}`
      + ` · entidades con varias fuentes: ${multiSourceEntities.length}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
