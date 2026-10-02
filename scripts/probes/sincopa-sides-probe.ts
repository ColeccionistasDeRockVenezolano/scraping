// Fichas de Sincopa con caras de vinilo («Side B» que vuelve a 01): qué
// número de pista da el adapter actual frente al que ya quedó en los claims.
// Solo lee. Deja la lista de URL a reingerir con --urls-out.
//
//   DATA_DIR=… tsx scripts/probes/sincopa-sides-probe.ts [--urls-out=reports/x.txt]
import { writeFileSync } from "node:fs";
import { SincopaAdapter } from "../../src/adapters/sincopa.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { loadStoredAdapterPages } from "../../src/ingest/runner.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const SIDE = /(?:side|lado|cara)(?:\s|&nbsp;|<[^>]*>)*[a-d1-4]\b/i;

async function main(): Promise<void> {
  const adapter = new SincopaAdapter();
  const pages = (await loadStoredAdapterPages("sincopa", adapter)).filter((page) => SIDE.test(page.body));
  const { rows } = await getPool().query<{ raw_page_id: string; identity_raw: string; value: string }>(`
    SELECT c.raw_page_id::text, c.identity_raw, c.raw_value #>> '{}' AS value
      FROM ingest.claims c
     WHERE c.source_id = (SELECT id FROM ingest.sources WHERE slug = 'sincopa')
       AND c.entity_kind = 'track' AND c.field = 'track_number' AND c.raw_page_id = ANY($1::bigint[])`,
  [pages.map((page) => page.rawPageId)]);
  const stored = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = `${row.raw_page_id}|${row.identity_raw}`;
    stored.set(key, (stored.get(key) ?? new Set()).add(row.value));
  }

  const totals = { pages: pages.length, pagesRenumbered: 0, tracks: 0, renumbered: 0, pagesStillRepeating: 0 };
  const urls: string[] = [];
  const stillRepeating: string[] = [];
  for (const page of pages) {
    const numbers = adapter.extractSnapshot(page).flatMap(normalizeRecord)
      .filter((claim) => claim.entityKind === "track" && claim.field === "track_number");
    let changed = 0;
    for (const claim of numbers) {
      totals.tracks += 1;
      const before = stored.get(`${page.rawPageId}|${claim.originalIdentity}`);
      if (before !== undefined && !before.has(String(claim.rawValue))) changed += 1;
    }
    const seen = numbers.map((claim) => Number(claim.rawValue));
    if (new Set(seen).size < seen.length) { totals.pagesStillRepeating += 1; stillRepeating.push(page.url); }
    if (changed > 0) { totals.pagesRenumbered += 1; totals.renumbered += changed; urls.push(page.url); }
  }
  const out = arg("urls-out");
  if (out !== undefined) writeFileSync(out, `${urls.join("\n")}\n`);
  console.log(JSON.stringify({ ...totals, stillRepeatingSample: stillRepeating.slice(0, 15) }, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
