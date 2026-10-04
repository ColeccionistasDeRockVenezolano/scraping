// Personas que una promoción de Sincopa creó y que la política actual ya NO
// crearía (rótulos, paréntesis de título, empresas, lugares). Solo lee.
//
//   tsx scripts/probes/promoted-persons-audit.ts --runs=11352,11353 [--out=reports/…json]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { decideVerdict } from "../../src/review/bulk-policy.js";
import { loadTitleParenthesisOnly, PROMOTION_SECTIONS, type PromotionSection } from "../../src/review/bulk-promotion.js";
import { normalizeEntityName } from "../../src/normalization/entity-name.js";

function flag(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  const runs = (flag("runs") ?? "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (runs.length === 0) throw new Error("--runs=<id,id…> obligatorio");
  const { rows: source } = await getPool().query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='sincopa'");
  const sourceId = Number(source[0]!.id);
  const { rows } = await getPool().query<{ id: string; name: string; run_id: string; section: string | null; other_sources: number; album_credits: number; track_credits: number; members: number }>(`
    WITH created AS (
      SELECT DISTINCT ON ((row_pk->>'id')::bigint) (row_pk->>'id')::bigint AS id, run_id
        FROM ingest.change_journal WHERE run_id = ANY($1::bigint[]) AND table_name = 'public.persons' AND op = 'I'
       ORDER BY (row_pk->>'id')::bigint, id)
    SELECT p.id::text, p.name, c.run_id::text,
           (SELECT min(substring(rp.url from 'sincopa\\.com/([^/]+)/')) FROM ingest.claims cl JOIN ingest.raw_pages rp ON rp.id = cl.raw_page_id
             WHERE cl.person_id = p.id AND cl.source_id = $2) AS section,
           (SELECT count(*)::int FROM ingest.claims cl WHERE cl.person_id = p.id AND cl.source_id <> $2) AS other_sources,
           (SELECT count(*)::int FROM public.album_credits ac WHERE ac.person_id = p.id) AS album_credits,
           (SELECT count(*)::int FROM public.track_credits tc WHERE tc.person_id = p.id) AS track_credits,
           (SELECT count(*)::int FROM public.artist_members am WHERE am.person_id = p.id) AS members
      FROM created c JOIN public.persons p ON p.id = c.id
     ORDER BY p.id`, [runs, sourceId]);

  const parenthesis = new Map<string, Set<string>>();
  for (const section of new Set(rows.map((row) => row.section).filter((s): s is string => s !== null))) {
    if (!PROMOTION_SECTIONS.includes(section as PromotionSection)) continue;
    parenthesis.set(section, await loadTitleParenthesisOnly(sourceId, section as PromotionSection));
  }
  const flagged = rows.flatMap((row) => {
    const onlyTitleParenthesis = row.section !== null && (parenthesis.get(row.section)?.has(normalizeEntityName(row.name).primaryKey) ?? false);
    const verdict = decideVerdict({
      kind: "person", name: row.name, decision: { action: "NO_MATCH", score: 0, candidates: [] }, sameName: [],
      ...(onlyTitleParenthesis ? { onlyTitleParenthesis } : {}),
    });
    if (verdict.kind !== "hold" && verdict.kind !== "dismiss") return [];
    return [{ id: Number(row.id), name: row.name, run: Number(row.run_id), section: row.section, rule: verdict.rule,
      albumCredits: row.album_credits, trackCredits: row.track_credits, members: row.members, otherSources: row.other_sources }];
  });
  const byRule: Record<string, number> = {};
  for (const item of flagged) byRule[item.rule] = (byRule[item.rule] ?? 0) + 1;
  const report = { runs, created: rows.length, flagged: flagged.length, byRule, persons: flagged };
  const out = flag("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, persons: undefined }, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
