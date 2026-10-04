// Créditos de varios autores de Sincopa («Lennon/McCartney»): tras reingerir
// las fichas con el adapter 1.3.0, que da un crédito por autor, rechaza los
// claims candidatos de la cadena combinada (persona y créditos) que la ficha
// ya no afirma. Los aceptados solo se informan: el core no se toca aquí.
//
//   DATA_DIR=… tsx scripts/reject-stale-sincopa-credits.ts --urls-file=…txt            # ensayo
//   DATA_DIR=… tsx scripts/reject-stale-sincopa-credits.ts --urls-file=… --confirm --note="…"
import { readFileSync, writeFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getDb, getPool } from "../src/db/client.js";
import { withRunScope } from "../src/db/run-binding.js";
import { scrapeRuns } from "../src/db/schema/ingest.js";
import { loadStoredAdapterPages } from "../src/ingest/runner.js";
import { finishRun } from "../src/ingest/runs.js";
import { normalizeRecord } from "../src/normalization/claims.js";
import { rejectClaims } from "../src/review/approval.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const KINDS = ["person", "track_credit", "album_credit"];

async function main(): Promise<void> {
  const urlsFile = arg("urls-file");
  if (urlsFile === undefined) throw new Error("--urls-file obligatorio");
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: crédito de varios autores separado por «/»; la ficha da ahora un crédito por autor";
  const wanted = new Set(readFileSync(urlsFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean));
  const adapter = new SincopaAdapter();
  const pages = (await loadStoredAdapterPages("sincopa", adapter)).filter((page) => wanted.has(page.url));

  const { rows } = await getPool().query<{ id: string; raw_page_id: string; entity_kind: string; identity_raw: string; status: string }>(`
    SELECT c.id::text, c.raw_page_id::text, c.entity_kind::text, c.identity_raw, c.status::text
      FROM ingest.claims c
     WHERE c.source_id = (SELECT id FROM ingest.sources WHERE slug = 'sincopa')
       AND c.entity_kind::text = ANY($2::text[]) AND c.identity_raw LIKE '%/%'
       AND c.status IN ('candidate','accepted') AND c.raw_page_id = ANY($1::bigint[])`,
  [pages.map((page) => page.rawPageId), KINDS]);
  const byPage = new Map<string, typeof rows>();
  for (const row of rows) byPage.set(row.raw_page_id, [...(byPage.get(row.raw_page_id) ?? []), row]);

  const stale: number[] = [];
  const acceptedStale = new Map<string, number>();
  for (const page of pages) {
    const expected = new Set(adapter.extractSnapshot(page).flatMap(normalizeRecord)
      .filter((claim) => KINDS.includes(claim.entityKind)).map((claim) => `${claim.entityKind}|${claim.originalIdentity}`));
    for (const row of byPage.get(String(page.rawPageId)) ?? []) {
      if (expected.has(`${row.entity_kind}|${row.identity_raw}`)) continue;
      if (row.status === "candidate") stale.push(Number(row.id));
      else acceptedStale.set(`${row.entity_kind}|${row.identity_raw}`, (acceptedStale.get(`${row.entity_kind}|${row.identity_raw}`) ?? 0) + 1);
    }
  }

  let result = { rejected: 0, reviewsClosed: 0 };
  let runId: number | undefined;
  if (confirm && stale.length > 0) {
    const [run] = await getDb().insert(scrapeRuns).values({
      kind: "manual", status: "running", params: { action: "reject-stale-sincopa-credits", note, urlsFile, pages: pages.length },
    }).returning();
    if (!run) throw new Error("no se pudo abrir el run");
    runId = run.id;
    for (let offset = 0; offset < stale.length; offset += 5_000) {
      const part = await withRunScope(run.id, () => rejectClaims(stale.slice(offset, offset + 5_000), `[run ${run.id}] ${note}`));
      result = { rejected: result.rejected + part.rejected, reviewsClosed: result.reviewsClosed + part.reviewsClosed };
    }
    await finishRun(run.id, "ok", { ...result, acceptedStale: acceptedStale.size });
  }
  const report = { dryRun: !confirm, runId, pages: pages.length, staleCandidates: stale.length, ...result, acceptedStale: acceptedStale.size };
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...report, acceptedStaleList: [...acceptedStale.keys()] }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
