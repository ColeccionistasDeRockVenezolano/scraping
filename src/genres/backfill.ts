// CRV · Backfill de géneros (PLAN_GENEROS etapa 2, punto 7).
//
// Recalcula, por separado para artistas y álbumes, las filas `rule` de toda
// entidad con claims `genre` (o con filas `rule` que ya no tengan evidencia) y,
// con la proyección encendida, `albums.genre`. Es el mismo recálculo que usan
// el motor de fusión y los cambios de taxonomía: repetirlo sobre los mismos
// datos no cambia nada.
//
// `--dry-run` corre entero dentro de una transacción que se deshace: el
// reporte describe exactamente lo que `--confirm` escribiría.
import type { PoolClient } from "pg";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";
import { projectAlbumGenre } from "../merge/genre-projection.js";
import type { GenreEntityKind } from "./rules.js";
import { loadAssignments, loadGenreClaims, loadTaxonomy, lockGenres, recomputeEntityGenres } from "./store.js";

export interface GenreCoverage {
  albums: { total: number; withConfirmedPrimary: number; withAnyConfirmed: number; genreNotNull: number; pending: number; unclassified: number };
  artists: { total: number; withConfirmedPrimary: number; withAnyConfirmed: number };
  rows: Array<{ level: GenreEntityKind; status: string; decisionKind: string; decisionRule: string; rows: number }>;
  openReviews: Array<{ level: string; genreCase: string; reviews: number }>;
}

export async function measureGenreCoverage(client: PoolClient): Promise<GenreCoverage> {
  const albums = await client.query<Record<string, string>>(`
    WITH primary_albums AS (SELECT DISTINCT album_id FROM ingest.album_genres WHERE role='primary' AND status='confirmed'),
         confirmed_albums AS (SELECT DISTINCT album_id FROM ingest.album_genres WHERE status='confirmed')
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE a.id IN (SELECT album_id FROM primary_albums))::text AS with_primary,
           count(*) FILTER (WHERE a.id IN (SELECT album_id FROM confirmed_albums))::text AS with_confirmed,
           count(a.genre)::text AS genre_not_null,
           count(*) FILTER (WHERE a.genre IS NOT NULL AND a.id NOT IN (SELECT album_id FROM primary_albums))::text AS pending,
           count(*) FILTER (WHERE a.genre IS NULL AND a.id NOT IN (SELECT album_id FROM primary_albums))::text AS unclassified
      FROM public.albums a`);
  const artists = await client.query<Record<string, string>>(`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.artist_genres x WHERE x.artist_id=a.id AND x.role='primary' AND x.status='confirmed'))::text AS with_primary,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ingest.artist_genres x WHERE x.artist_id=a.id AND x.status='confirmed'))::text AS with_confirmed
      FROM public.artists a`);
  const rows = await client.query<{ level: GenreEntityKind; status: string; decision_kind: string; decision_rule: string; rows: string }>(`
    SELECT 'album' AS level, status, decision_kind, decision_rule, count(*)::text AS rows FROM ingest.album_genres GROUP BY 2,3,4
    UNION ALL
    SELECT 'artist', status, decision_kind, decision_rule, count(*)::text FROM ingest.artist_genres GROUP BY 2,3,4
    ORDER BY 1,2,3,4`);
  const reviews = await client.query<{ level: string; genre_case: string; reviews: string }>(`
    SELECT payload->>'entityKind' AS level, payload->>'genreCase' AS genre_case, count(*)::text AS reviews
      FROM ingest.review_queue
     WHERE kind='genre_unknown' AND status IN ('open','in_progress') AND payload->>'origin' LIKE 'genres%'
     GROUP BY 1,2 ORDER BY 1,2`);
  const a = albums.rows[0]!; const r = artists.rows[0]!;
  return {
    albums: {
      total: Number(a["total"]), withConfirmedPrimary: Number(a["with_primary"]), withAnyConfirmed: Number(a["with_confirmed"]),
      genreNotNull: Number(a["genre_not_null"]), pending: Number(a["pending"]), unclassified: Number(a["unclassified"]),
    },
    artists: { total: Number(r["total"]), withConfirmedPrimary: Number(r["with_primary"]), withAnyConfirmed: Number(r["with_confirmed"]) },
    rows: rows.rows.map((row) => ({ level: row.level, status: row.status, decisionKind: row.decision_kind, decisionRule: row.decision_rule, rows: Number(row.rows) })),
    openReviews: reviews.rows.map((row) => ({ level: row.level, genreCase: row.genre_case, reviews: Number(row.reviews) })),
  };
}

export interface BackfillReport {
  mode: "dry-run" | "confirm";
  runId: number;
  projectionEnabled: boolean;
  levels: GenreEntityKind[];
  processed: Record<GenreEntityKind, number>;
  writes: { inserted: number; updated: number; deleted: number; humanEvidence: number; reviewsOpened: number; reviewsClosed: number };
  before: GenreCoverage;
  after: GenreCoverage;
  projection: {
    changed: number;
    toNull: number;
    /** Álbumes con `albums.genre` y sin ningún claim que lo respalde (§2 midió 0). */
    withoutEvidence: number[];
    sample: Array<{ albumId: number; before: string | null; after: string | null; basis: string }>;
  };
  /** Tramos sin resolver más frecuentes: la lista de trabajo de la revisión. */
  unresolved: Array<{ fragment: string; entities: number }>;
}

export async function runGenreBackfill(options: {
  confirm: boolean; actor: string; levels?: GenreEntityKind[];
}): Promise<BackfillReport> {
  const levels = options.levels ?? ["artist", "album"];
  const projectionEnabled = getEnv().GENRES_PROJECTION_ENABLED;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "genres_backfill", actor: options.actor, confirm: options.confirm, levels, projectionEnabled })]);
    const runId = Number(run.rows[0]!.id);
    const taxonomy = await loadTaxonomy(client);
    if (taxonomy.genres.size === 0) throw new Error("la taxonomía está vacía: aplica antes `crv genres taxonomy-apply --confirm`");
    const before = await measureGenreCoverage(client);
    const report: BackfillReport = {
      mode: options.confirm ? "confirm" : "dry-run", runId, projectionEnabled, levels,
      processed: { artist: 0, album: 0 },
      writes: { inserted: 0, updated: 0, deleted: 0, humanEvidence: 0, reviewsOpened: 0, reviewsClosed: 0 },
      before, after: before,
      projection: { changed: 0, toNull: 0, withoutEvidence: [], sample: [] },
      unresolved: [],
    };
    const unresolved = new Map<string, Set<string>>();

    for (const kind of levels) {
      const claims = await loadGenreClaims(client, kind);
      const assignments = await loadAssignments(client, kind, undefined, true);
      const ids = [...new Set([...claims.keys(), ...[...assignments].filter(([, rows]) => rows.some((row) => row.decisionKind === "rule")).map(([id]) => id)])]
        .sort((a, b) => a - b);
      for (const entityId of ids) {
        const result = await recomputeEntityGenres(client, taxonomy, kind, entityId, {
          runId, claims: claims.get(entityId) ?? [], assignments: assignments.get(entityId) ?? [], project: false,
        });
        report.processed[kind] += 1;
        report.writes.inserted += result.write.inserted;
        report.writes.updated += result.write.updated;
        report.writes.deleted += result.write.deleted;
        report.writes.humanEvidence += result.write.humanEvidence;
        report.writes.reviewsOpened += result.reviews.opened;
        report.writes.reviewsClosed += result.reviews.closed;
      }
    }

    const openCases = await client.query<{ entity: string; unresolved: string[] | null }>(`
      SELECT concat(payload->>'entityKind', ':', payload->>'entityId') AS entity,
             ARRAY(SELECT jsonb_array_elements_text(COALESCE(payload->'unresolved','[]'::jsonb))) AS unresolved
        FROM ingest.review_queue
       WHERE kind='genre_unknown' AND status IN ('open','in_progress') AND payload->>'origin'='genres'`);
    for (const row of openCases.rows) {
      for (const fragment of row.unresolved ?? []) {
        const key = fragment.trim();
        unresolved.set(key, (unresolved.get(key) ?? new Set<string>()).add(row.entity));
      }
    }
    report.unresolved = [...unresolved].map(([fragment, entities]) => ({ fragment, entities: entities.size }))
      .sort((a, b) => b.entities - a.entities || a.fragment.localeCompare(b.fragment)).slice(0, 100);

    if (levels.includes("album") && projectionEnabled) {
      // Todo álbum con evidencia, con filas o con texto visible pasa por la regla.
      const targets = await client.query<{ id: string; has_claims: boolean }>(`
        SELECT a.id::text,
               EXISTS (SELECT 1 FROM ingest.claims c WHERE c.album_id=a.id AND c.field='genre') AS has_claims
          FROM public.albums a
         WHERE a.genre IS NOT NULL
            OR EXISTS (SELECT 1 FROM ingest.claims c WHERE c.album_id=a.id AND c.field='genre')
            OR EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=a.id)
         ORDER BY a.id`);
      for (const row of targets.rows) {
        const albumId = Number(row.id);
        if (!row.has_claims) report.projection.withoutEvidence.push(albumId);
        const projected = await projectAlbumGenre(client, albumId, { runId });
        if (!projected.changed) continue;
        report.projection.changed += 1;
        if (projected.after === null) report.projection.toNull += 1;
        if (report.projection.sample.length < 200) {
          report.projection.sample.push({ albumId, before: projected.before, after: projected.after, basis: projected.basis });
        }
      }
    }

    report.after = await measureGenreCoverage(client);
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ processed: report.processed, writes: report.writes, projectionChanged: report.projection.changed })]);
    await client.query(options.confirm ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)} %`);

export function renderBackfillMarkdown(report: BackfillReport): string {
  const lines: string[] = [];
  const b = report.before; const a = report.after;
  lines.push(`# Backfill de géneros (${report.mode})`, "");
  lines.push(`Run ${report.runId} · proyección de \`albums.genre\`: ${report.projectionEnabled ? "ENCENDIDA" : "apagada (el motor de fusión sigue escribiendo albums.genre)"}`, "");
  lines.push("## Cobertura antes / después", "");
  lines.push("| Métrica | Antes | Después |", "|---|---:|---:|");
  lines.push(`| Álbumes | ${b.albums.total} | ${a.albums.total} |`);
  lines.push(`| Álbumes con principal confirmado | ${b.albums.withConfirmedPrimary} (${pct(b.albums.withConfirmedPrimary, b.albums.total)}) | ${a.albums.withConfirmedPrimary} (${pct(a.albums.withConfirmedPrimary, a.albums.total)}) |`);
  lines.push(`| Álbumes con algún género confirmado | ${b.albums.withAnyConfirmed} | ${a.albums.withAnyConfirmed} |`);
  lines.push(`| \`albums.genre\` no nulo | ${b.albums.genreNotNull} | ${a.albums.genreNotNull} |`);
  lines.push(`| Pendientes (texto de fuente, sin principal) | ${b.albums.pending} | ${a.albums.pending} |`);
  lines.push(`| Sin clasificar | ${b.albums.unclassified} | ${a.albums.unclassified} |`);
  lines.push(`| Artistas | ${b.artists.total} | ${a.artists.total} |`);
  lines.push(`| Artistas con principal confirmado | ${b.artists.withConfirmedPrimary} | ${a.artists.withConfirmedPrimary} |`);
  lines.push(`| Artistas con algún género confirmado | ${b.artists.withAnyConfirmed} | ${a.artists.withAnyConfirmed} |`, "");
  lines.push("## Escrituras", "");
  lines.push(`Procesados: ${report.processed.artist} artistas, ${report.processed.album} álbumes. Filas: +${report.writes.inserted} / ~${report.writes.updated} / −${report.writes.deleted}; evidencia añadida a decisiones humanas: ${report.writes.humanEvidence}. Revisiones abiertas: ${report.writes.reviewsOpened}, cerradas: ${report.writes.reviewsClosed}.`, "");
  lines.push("## Asignaciones por estado y regla (después)", "");
  lines.push("| Nivel | Estado | Decisión | Regla | Filas |", "|---|---|---|---|---:|");
  for (const row of a.rows) lines.push(`| ${row.level} | ${row.status} | ${row.decisionKind} | ${row.decisionRule} | ${row.rows} |`);
  lines.push("", "## Casos en revisión (después)", "");
  lines.push("| Nivel | Caso | Abiertos |", "|---|---|---:|");
  for (const row of a.openReviews) lines.push(`| ${row.level} | ${row.genreCase} | ${row.reviews} |`);
  lines.push("", "## Proyección de `albums.genre`", "");
  if (!report.projectionEnabled) {
    lines.push("Apagada: no se escribió `albums.genre`. Enciende `GENRES_PROJECTION_ENABLED=true` y repite el backfill para proyectar.");
  } else {
    lines.push(`Cambian ${report.projection.changed} álbumes (${report.projection.toNull} pasan a NULL). Sin evidencia: ${report.projection.withoutEvidence.length}.`, "");
    lines.push("| Álbum | Antes | Después | Base |", "|---:|---|---|---|");
    for (const item of report.projection.sample.slice(0, 60)) lines.push(`| ${item.albumId} | ${item.before ?? "∅"} | ${item.after ?? "∅"} | ${item.basis} |`);
  }
  lines.push("", "## Tramos sin resolver más frecuentes", "");
  lines.push("| Tramo | Entidades |", "|---|---:|");
  for (const item of report.unresolved.slice(0, 50)) lines.push(`| ${item.fragment} | ${item.entities} |`);
  lines.push("");
  return lines.join("\n");
}

