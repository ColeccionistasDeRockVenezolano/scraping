// CRV · Confirmar en bloque lo que propuso una fuente externa
// (PLAN_GENEROS etapa 4, decisión editorial de Brian del 2026-09-24).
//
// La importación escribe SUGERENCIAS: la fuente propone y una persona decide.
// Este paso es la decisión de esa persona tomada de una vez para toda una
// fuente, y por eso:
//
//  * NO INVENTA NADA. Solo confirma sugerencias que la fuente ya escribió y
//    que siguen `suggested` con `decision_kind = 'rule'`.
//  * NO PISA A NADIE. Una ficha que ya tiene principal confirmado se salta, y
//    lo que alguien decidió a mano no se toca jamás.
//  * SE SABE QUIÉN FUE. Las filas quedan a nombre de `auto:<fuente>` y no del
//    actor, para que el diario distinga lo que miró una persona de lo que
//    entró en bloque. El motivo lleva el run, y revertir es por run.
//  * EL PRINCIPAL ES EL MÁS PRECISO. De las propuestas de una ficha se elige
//    un género hijo antes que una familia y, a igualdad, el que la fuente
//    nombró primero (Discogs ofrece sus «styles» —el detalle— antes que sus
//    «genres» —el cajón—).
import type { PoolClient } from "pg";
import { getPool } from "../../db/client.js";
import { moduleLogger } from "../../logger/index.js";
import { confirmGenre } from "../human.js";
import type { GenreEntityKind } from "../rules.js";
import { DERIVED_FROM_ALBUMS_SQL, GENRE_COLUMN, GENRE_TABLE, loadTaxonomy, lockGenres } from "../store.js";
import { isAncestorOf, type Taxonomy } from "../taxonomy.js";
import { ExternalSourceError, requireExternalSource } from "./store.js";

const log = moduleLogger("genres:external:accept");

export interface AcceptOptions {
  sourceSlug: string;
  level: GenreEntityKind;
  confirm: boolean;
  actor: string;
  reason: string;
  limit?: number;
  entityIds?: number[];
  /** Qué hacer con las propuestas que no son el principal. */
  secondaries: "confirm" | "leave";
}

export interface AcceptedEntity {
  entityId: number;
  title: string;
  primary: string;
  secondaries: string[];
  rawValues: string[];
}

export interface AcceptReport {
  sourceSlug: string;
  level: GenreEntityKind;
  mode: "dry-run" | "confirm";
  runId: number;
  /** Fichas con sugerencias vivas de esta fuente. */
  candidates: number;
  accepted: AcceptedEntity[];
  primaries: number;
  secondariesConfirmed: number;
  skipped: Array<{ entityId: number; title: string; reason: string }>;
}

interface SuggestionRow {
  entityId: number;
  title: string;
  genreId: number;
  slug: string;
  level: string;
  rawValue: string | null;
  rowId: number;
}

/**
 * Sugerencias vivas de la fuente, por ficha y en el orden en que la fuente las
 * nombró (el id de la fila lo conserva: se insertan según llegan).
 */
async function loadSuggestions(
  client: PoolClient, sourceId: number, options: AcceptOptions, limit: number,
): Promise<Map<number, SuggestionRow[]>> {
  const table = GENRE_TABLE[options.level];
  const column = GENRE_COLUMN[options.level];
  const entityTable = options.level === "album" ? "public.albums" : "public.artists";
  const titleColumn = options.level === "album" ? "title" : "name";
  const { rows } = await client.query<{
    entity_id: string; title: string; genre_id: string; slug: string; level: string; raw_value: string | null; id: string;
  }>(`
    SELECT g.${column}::text AS entity_id, e.${titleColumn} AS title, g.genre_id::text, t.slug, t.level,
           g.raw_value, g.id::text
      FROM ${table} g
      JOIN ${entityTable} e ON e.id = g.${column}
      JOIN ingest.genres t ON t.id = g.genre_id
     WHERE g.external_source_id = $1 AND g.source_kind = 'external'
       AND g.status = 'suggested' AND g.decision_kind = 'rule'
       AND t.active
       AND ($2::bigint[] IS NULL OR g.${column} = ANY($2::bigint[]))
       -- Una ficha que ya tiene principal confirmado PROPIO no se toca (el que
       -- un artista recibe de sus discos, 0036, cede ante el de una fuente).
       AND NOT EXISTS (SELECT 1 FROM ${table} p
                        WHERE p.${column} = g.${column} AND p.role = 'primary' AND p.status = 'confirmed'
                          AND NOT ${DERIVED_FROM_ALBUMS_SQL("p")})
       AND g.${column} IN (
         SELECT DISTINCT s.${column} FROM ${table} s
          WHERE s.external_source_id = $1 AND s.source_kind = 'external'
            AND s.status = 'suggested' AND s.decision_kind = 'rule'
            AND ($2::bigint[] IS NULL OR s.${column} = ANY($2::bigint[]))
          ORDER BY s.${column} LIMIT $3)
     ORDER BY g.${column}, g.id`, [sourceId, options.entityIds ?? null, limit]);
  const byEntity = new Map<number, SuggestionRow[]>();
  for (const row of rows) {
    const entityId = Number(row.entity_id);
    const list = byEntity.get(entityId) ?? [];
    list.push({
      entityId, title: row.title, genreId: Number(row.genre_id), slug: row.slug, level: row.level,
      rawValue: row.raw_value, rowId: Number(row.id),
    });
    byEntity.set(entityId, list);
  }
  return byEntity;
}

/**
 * El principal de una ficha: un género o subgénero antes que una familia y,
 * dentro de cada grupo, el que la fuente nombró primero. Devuelve el resto
 * como secundarios, en el mismo orden.
 */
export function pickPrimary(suggestions: SuggestionRow[]): { primary: SuggestionRow; rest: SuggestionRow[] } | null {
  if (!suggestions.length) return null;
  const primary = suggestions.find((row) => row.level !== "family") ?? suggestions[0]!;
  return { primary, rest: suggestions.filter((row) => row.rowId !== primary.rowId) };
}

/**
 * Un nodo cuyo descendiente también viene propuesto (familia o género de un
 * subgénero) no se confirma: sería perder precisión, y `confirmGenre` lo
 * rechaza de todos modos.
 */
function redundantFamily(taxonomy: Taxonomy, row: SuggestionRow, others: SuggestionRow[]): boolean {
  if (row.level === "subgenre") return false;
  return others.some((other) => isAncestorOf(taxonomy, row.genreId, other.genreId));
}

export async function runAccept(options: AcceptOptions): Promise<AcceptReport> {
  const limit = options.limit ?? 200;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const source = await requireExternalSource(client, options.sourceSlug);
    // Regla de Brian del 2026-09-26: si una fuente nombra el género, basta.
    // Sin umbral ni autorización previa; solo una fuente bloqueada se detiene.
    if (source.status === "blocked") {
      throw new ExternalSourceError("not_authorized", `la fuente ${source.slug} está bloqueada`);
    }
    const taxonomy = await loadTaxonomy(client);
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({
      action: "genres_external_accept", source: source.slug, level: options.level,
      actor: options.actor, confirm: options.confirm, secondaries: options.secondaries,
    })]);
    const runId = Number(run.rows[0]!.id);
    const report: AcceptReport = {
      sourceSlug: source.slug, level: options.level, mode: options.confirm ? "confirm" : "dry-run",
      runId, candidates: 0, accepted: [], primaries: 0, secondariesConfirmed: 0, skipped: [],
    };

    const byEntity = await loadSuggestions(client, source.id, options, limit);
    report.candidates = byEntity.size;
    // El motivo escrito en cada fila: quién lo autorizó y con qué run, para
    // que revertirlo sea un `WHERE run_id = …` y no una arqueología.
    const reason = `${options.actor}: ${options.reason} (confirmación automática de ${source.slug}, run ${runId})`;
    const decidedBy = `auto:${source.slug}`;

    for (const [entityId, suggestions] of byEntity) {
      const chosen = pickPrimary(suggestions);
      if (!chosen) continue;
      const title = suggestions[0]!.title;
      try {
        await confirmGenre(client, {
          kind: options.level, entityId, genreSlug: chosen.primary.slug,
          actor: decidedBy, reason, role: "primary", runId,
        });
        report.primaries += 1;
        const secondaries: string[] = [];
        if (options.secondaries === "confirm") {
          for (const row of chosen.rest) {
            if (redundantFamily(taxonomy, row, [chosen.primary, ...chosen.rest])) continue;
            try {
              await confirmGenre(client, {
                kind: options.level, entityId, genreSlug: row.slug,
                actor: decidedBy, reason, role: "secondary", runId,
              });
              secondaries.push(row.slug);
              report.secondariesConfirmed += 1;
            } catch (error) {
              log.warn({ entityId, slug: row.slug, err: (error as Error).message }, "no se pudo confirmar el secundario");
            }
          }
        }
        report.accepted.push({
          entityId, title, primary: chosen.primary.slug, secondaries,
          rawValues: suggestions.map((row) => row.rawValue ?? row.slug),
        });
      } catch (error) {
        report.skipped.push({ entityId, title, reason: (error as Error).message });
      }
    }

    await client.query(`UPDATE ingest.scrape_runs SET status=$2::ingest.run_status, finished_at=now() WHERE id=$1`,
      [runId, report.skipped.length ? "partial" : "ok"]);
    await client.query(options.confirm ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
