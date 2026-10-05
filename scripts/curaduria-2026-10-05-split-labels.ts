// CRV · Curaduría 2026-10-05: sellos que el ER pegó a la ficha de su estudio.
//
// Sincopa y Hippito citan «Sonográfica», «Discomoda» y «Latin World» como
// SELLO de cientos de discos; el ER los unió por alias a las fichas de los
// ESTUDIOS (Estudios Sonográfica 148, Discomoda Estudios 218, Latin World
// Studios 134), que el canal clasifica como estudio. De ahí 788 «valores en
// disputa» sobre organization_type. Sello ≠ estudio: el estudio se queda como
// está y lo que habla del sello pasa a su propia ficha de sello —Sonográfica y
// Discomoda nuevas; Latin World a la que ya existe (Latin World Entertainment
// Group, 2556, sello de Guaco y Candy66 en Discogs)—, con sus alias de sello,
// los claims de las fuentes que lo nombran como sello y el `label_id` de sus
// discos. Los conflictos que quedan entre claims de fichas distintas se cierran
// como «ambos se conservan».
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-split-labels.ts [--confirm]
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const OPERATOR = "claude-code";
const NOTE = "Curaduría 2026-10-05: el sello citado por Sincopa/Hippito no es el estudio del mismo nombre; el sello pasa a su ficha y el estudio queda como estudio";
const LABEL_SOURCES = ["sincopa", "hippito-y-sus-chatarritas"];

interface Split { studioId: number; labelId?: number; labelName: string; labelAliases: string[] }
const SPLITS: Split[] = [
  { studioId: 148, labelName: "Sonográfica", labelAliases: ["Sonográfica", "Sonografica"] },
  { studioId: 218, labelName: "Discomoda", labelAliases: ["Discomoda"] },
  { studioId: 134, labelId: 2556, labelName: "Latin World Entertainment Group", labelAliases: ["Latin World"] },
];
const norm = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().trim();

async function work(client: PoolClient): Promise<Record<string, unknown>[]> {
  const report: Record<string, unknown>[] = [];
  for (const split of SPLITS) {
    let labelId = split.labelId;
    if (!labelId) {
      const { rows: [row] } = await client.query<{ id: string }>(
        "INSERT INTO public.organizations(name, organization_type, country) VALUES ($1,'record_label','Venezuela') RETURNING id::text", [split.labelName]);
      labelId = Number(row!.id);
    }
    const { rowCount: claims } = await client.query(`
      UPDATE ingest.claims c SET organization_id=$2, status=CASE WHEN c.status IN ('conflict','superseded') THEN 'accepted'::ingest.claim_status ELSE c.status END, updated_at=now()
        FROM ingest.sources s WHERE s.id=c.source_id AND c.organization_id=$1 AND s.slug=ANY($3)`, [split.studioId, labelId, LABEL_SOURCES]);
    // El tipo del sello lo afirman ahora sus propias fuentes.
    await client.query("UPDATE public.organizations SET organization_type='record_label' WHERE id=$1", [labelId]);
    let aliases = 0;
    for (const alias of split.labelAliases) {
      const moved = await client.query("UPDATE ingest.organization_aliases SET organization_id=$2 WHERE organization_id=$1 AND alias=$3", [split.studioId, labelId, alias]);
      if (!moved.rowCount) {
        await client.query(`INSERT INTO ingest.organization_aliases(organization_id, alias, normalized_alias, confidence, notes)
          VALUES ($1,$2,$3,'high',$4) ON CONFLICT (organization_id, alias) DO NOTHING`, [labelId, alias, norm(alias), NOTE]);
      }
      aliases += 1;
    }
    const { rowCount: albums } = await client.query("UPDATE public.albums SET label_id=$2 WHERE label_id=$1", [split.studioId, labelId]);
    report.push({ studio: split.studioId, label: labelId, name: split.labelName, claims, aliases, albums });
  }
  const { rows: stale } = await client.query<{ id: string }>(`
    SELECT cf.id::text FROM ingest.conflicts cf JOIN ingest.claims ca ON ca.id=cf.claim_a_id JOIN ingest.claims cb ON cb.id=cf.claim_b_id
     WHERE cf.status='open' AND cf.entity_kind='organization' AND ca.organization_id IS DISTINCT FROM cb.organization_id`);
  for (const item of stale) {
    await client.query(`UPDATE ingest.claims SET status='accepted', updated_at=now() WHERE status='conflict'
      AND id IN (SELECT claim_a_id FROM ingest.conflicts WHERE id=$1 UNION SELECT claim_b_id FROM ingest.conflicts WHERE id=$1)`, [Number(item.id)]);
    await client.query("UPDATE ingest.conflicts SET status='both_kept', resolved_by='human', resolution_note=$2, resolved_at=now() WHERE id=$1", [Number(item.id), NOTE]);
    await client.query(`UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
      WHERE conflict_id=$1 AND status IN ('open','in_progress')`, [Number(item.id), NOTE]);
  }
  report.push({ conflictsClosed: stale.length });
  return report;
}

async function main(): Promise<void> {
  if (process.argv.includes("--confirm")) {
    const { runId, result } = await withOperatorRun({ name: "curation:split-labels", operator: OPERATOR, note: NOTE }, (context) => work(context.client));
    console.log(`run ${runId}`, result);
  } else {
    const client = await getPool().connect();
    try { await client.query("BEGIN"); console.log(await work(client)); } finally { await client.query("ROLLBACK"); client.release(); }
  }
  await closeDb();
}
void main();
