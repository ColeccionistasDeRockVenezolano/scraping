// CRV · Lectura de fuentes (PHASES §E7A: "lectura de fuentes, claims...").
// CONTRACT §11: las fuentes se almacenan internamente pero no es requisito
// mostrarlas públicamente — esta API es administrativa, no la vitrina pública,
// así que expone también las que tienen public_display=false.
import { asc, eq } from "drizzle-orm";
import { getDb, getPool } from "../../db/client.js";
import { sources } from "../../db/schema/ingest.js";

export async function listSourcesRead() {
  return getDb().select().from(sources).orderBy(asc(sources.name));
}

export interface SourceDetail {
  id: number;
  slug: string;
  name: string;
  url: string | null;
  siteType: string;
  accessStrategy: string | null;
  requiresJs: boolean;
  trustLevel: string;
  enabled: boolean;
  publicDisplay: boolean;
  notes: string | null;
  lastRun: { id: number; kind: string; status: string; startedAt: string; finishedAt: string | null } | null;
}

export async function getSourceDetail(id: number): Promise<SourceDetail | null> {
  const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
  if (!row) return null;
  const { rows } = await getPool().query<{ id: string; kind: string; status: string; started_at: string; finished_at: string | null }>(
    `SELECT id, kind, status, started_at::text AS started_at, finished_at::text AS finished_at
       FROM ingest.scrape_runs
      WHERE source_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [id],
  );
  const last = rows[0];
  return {
    id: row.id, slug: row.slug, name: row.name, url: row.url, siteType: row.siteType,
    accessStrategy: row.accessStrategy, requiresJs: row.requiresJs, trustLevel: row.trustLevel,
    enabled: row.enabled, publicDisplay: row.publicDisplay, notes: row.notes,
    lastRun: last
      ? { id: Number(last.id), kind: last.kind, status: last.status, startedAt: last.started_at, finishedAt: last.finished_at }
      : null,
  };
}
