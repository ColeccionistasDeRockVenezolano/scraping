// Reparación puntual y repetible de organizaciones contaminadas por las dos
// formas de discografía de Sincopa. El parser anterior confundía continuaciones
// de título y filas detalladas de sencillos con sellos discográficos.
//
// La decisión no se basa en la apariencia del nombre. Se vuelve a extraer todo
// el crudo local con el parser vigente y solo se retira una organización si:
//   * nació de un claim de nombre de Sincopa;
//   * ese nombre no aparece como organización en ninguna extracción corregida;
//   * ninguna otra fuente mantiene un claim de nombre no rechazado; y
//   * no tiene dependientes en public/media.
// La aplicación usa el retiro auditado del merge y una sola transacción.
import type { PoolClient } from "pg";
import { adapterFor } from "../adapters/registry.js";
import { getPool } from "../db/client.js";
import { loadStoredAdapterPages } from "../ingest/runner.js";
import { removeEntity, type Dependent, type RemovalResult } from "../merge/removals.js";
import { normalizeIdentitySecondary } from "../normalization/claims.js";

interface OrganizationRow {
  id: string;
  name: string;
  sincopa_claims: number;
  external_claims: number;
  raw_page_ids: number[];
}

export interface SincopaOrganizationCandidate {
  id: number;
  name: string;
  sincopaClaims: number;
  rawPageIds: number[];
}

export interface SincopaOrganizationSkipped extends SincopaOrganizationCandidate {
  dependents: Dependent[];
}

export interface SincopaOrganizationRepairPlan {
  validNames: number;
  candidates: SincopaOrganizationCandidate[];
  skipped: SincopaOrganizationSkipped[];
}

type Queryable = Pick<PoolClient, "query">;

async function correctedNames(): Promise<Set<string>> {
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adapter Sincopa faltante");
  const names = new Set<string>();
  for (const page of await loadStoredAdapterPages("sincopa", adapter)) {
    for (const record of adapter.extractSnapshot(page)) {
      if (record.entityKind !== "organization") continue;
      const value = record.fields.find((field) => field.field === "name")?.value ?? record.identity;
      const normalized = normalizeIdentitySecondary(String(value));
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

async function organizationRows(queryable: Queryable): Promise<OrganizationRow[]> {
  return (await queryable.query<OrganizationRow>(`
    SELECT o.id::text,o.name,
           count(*) FILTER (WHERE s.slug='sincopa')::int AS sincopa_claims,
           count(*) FILTER (WHERE s.slug<>'sincopa' AND c.status<>'rejected')::int AS external_claims,
           coalesce(array_agg(DISTINCT c.raw_page_id::int) FILTER
             (WHERE s.slug='sincopa' AND c.raw_page_id IS NOT NULL),'{}'::int[]) AS raw_page_ids
      FROM public.organizations o
      JOIN ingest.claims c ON c.organization_id=o.id AND c.entity_kind='organization' AND c.field='name'
      JOIN ingest.sources s ON s.id=c.source_id
     GROUP BY o.id,o.name
    HAVING count(*) FILTER (WHERE s.slug='sincopa') > 0
     ORDER BY o.id`)).rows;
}

async function dependentMap(queryable: Queryable, ids: number[]): Promise<Map<number, Dependent[]>> {
  const output = new Map<number, Dependent[]>();
  if (ids.length === 0) return output;
  const refs = (await queryable.query<{ table: string; column: string }>(`
    SELECT c.conrelid::regclass::text AS table,a.attname AS column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
     WHERE c.contype='f' AND c.confrelid='public.organizations'::regclass
       AND c.connamespace IN ('public'::regnamespace,'media'::regnamespace)
     ORDER BY 1,2`)).rows;
  for (const ref of refs) {
    const rows = await queryable.query<{ id: string; rows: number }>(
      `SELECT "${ref.column}"::text AS id,count(*)::int AS rows
         FROM ${ref.table} WHERE "${ref.column}"=ANY($1::bigint[]) GROUP BY "${ref.column}"`,
      [ids],
    );
    for (const row of rows.rows) {
      const id = Number(row.id);
      output.set(id, [...(output.get(id) ?? []), { table: ref.table, column: ref.column, rows: row.rows }]);
    }
  }
  return output;
}

async function buildPlan(validNames: Set<string>, queryable: Queryable): Promise<SincopaOrganizationRepairPlan> {
  const invalid = (await organizationRows(queryable)).filter((row) =>
    row.external_claims === 0 && !validNames.has(normalizeIdentitySecondary(row.name)));
  const dependencies = await dependentMap(queryable, invalid.map((row) => Number(row.id)));
  const candidates: SincopaOrganizationCandidate[] = [];
  const skipped: SincopaOrganizationSkipped[] = [];
  for (const row of invalid) {
    const candidate = {
      id: Number(row.id), name: row.name, sincopaClaims: row.sincopa_claims, rawPageIds: row.raw_page_ids,
    };
    const dependents = dependencies.get(candidate.id) ?? [];
    if (dependents.length > 0) skipped.push({ ...candidate, dependents });
    else candidates.push(candidate);
  }
  return { validNames: validNames.size, candidates, skipped };
}

/** Previsualización sin escritura. */
export async function planSincopaOrganizationRepair(): Promise<SincopaOrganizationRepairPlan> {
  return buildPlan(await correctedNames(), getPool());
}

export interface SincopaOrganizationRepairResult extends SincopaOrganizationRepairPlan {
  runId: number;
  removed: RemovalResult[];
}

/** Aplica exactamente el plan recalculado dentro de una transacción. */
export async function applySincopaOrganizationRepair(note: string): Promise<SincopaOrganizationRepairResult> {
  if (!note.trim()) throw new Error("nota obligatoria para reparar organizaciones de Sincopa");
  const validNames = await correctedNames();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('review:sincopa-organizations'))");
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind,status,params)
      VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "repair_sincopa_organizations", note, parserVersion: "1.1.0" })]);
    const runId = Number(run.rows[0]!.id);
    const plan = await buildPlan(validNames, client);
    const removed: RemovalResult[] = [];
    for (const candidate of plan.candidates) {
      const result = await removeEntity(client, "organization", candidate.id, { note, runId });
      if (result) removed.push(result);
    }
    await client.query(`
      UPDATE ingest.scrape_runs
         SET status='ok',finished_at=now(),counters=$2::jsonb,
             params=params || jsonb_build_object('removedOrganizations',$3::jsonb)
       WHERE id=$1`, [
      runId,
      JSON.stringify({ removed: removed.length, skipped: plan.skipped.length, validNames: plan.validNames }),
      JSON.stringify(removed),
    ]);
    await client.query("COMMIT");
    return { ...plan, runId, removed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
