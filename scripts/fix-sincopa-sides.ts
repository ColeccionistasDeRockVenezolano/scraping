// Vinilos de Sincopa: tras reingerir las fichas con caras («Side B» que vuelve
// a 01) con el adapter corregido, rechaza los `track_number` candidatos que la
// ficha ya no afirma (el «01» viejo de la cara B). Los aceptados con número
// distinto al de la ficha solo se informan: el core no se toca aquí.
//
//   DATA_DIR=… tsx scripts/fix-sincopa-sides.ts --urls-file=reports/…txt            # ensayo
//   DATA_DIR=… tsx scripts/fix-sincopa-sides.ts --urls-file=… --confirm --note="…"
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

async function main(): Promise<void> {
  const urlsFile = arg("urls-file");
  if (urlsFile === undefined) throw new Error("--urls-file obligatorio");
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: número de pista de la cara B leído como reinicio (01); la ficha numera corrido";
  const wanted = new Set(readFileSync(urlsFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean));
  const adapter = new SincopaAdapter();
  const pages = (await loadStoredAdapterPages("sincopa", adapter)).filter((page) => wanted.has(page.url));

  const { rows } = await getPool().query<{ id: string; raw_page_id: string; identity_raw: string; value: string; status: string }>(`
    SELECT c.id::text, c.raw_page_id::text, c.identity_raw, c.raw_value #>> '{}' AS value, c.status::text
      FROM ingest.claims c
     WHERE c.source_id = (SELECT id FROM ingest.sources WHERE slug = 'sincopa')
       AND c.entity_kind = 'track' AND c.field = 'track_number' AND c.raw_page_id = ANY($1::bigint[])`,
  [pages.map((page) => page.rawPageId)]);
  const byKey = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.raw_page_id}|${row.identity_raw}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  const stale: number[] = [];
  const acceptedWrong: Array<{ url: string; identity: string; core: string; page: string }> = [];
  let missingNew = 0;
  for (const page of pages) {
    const expected = adapter.extractSnapshot(page).flatMap(normalizeRecord)
      .filter((claim) => claim.entityKind === "track" && claim.field === "track_number");
    for (const claim of expected) {
      const want = Number(claim.rawValue);
      const have = byKey.get(`${page.rawPageId}|${claim.originalIdentity}`) ?? [];
      if (!have.some((row) => Number(row.value) === want && row.status !== "rejected")) missingNew += 1;
      for (const row of have) {
        if (Number(row.value) === want) continue;
        if (row.status === "candidate") stale.push(Number(row.id));
        else if (row.status === "accepted") acceptedWrong.push({ url: page.url, identity: claim.originalIdentity, core: row.value, page: String(claim.rawValue) });
      }
    }
  }

  let result = { rejected: 0, reviewsClosed: 0 };
  let runId: number | undefined;
  if (confirm && stale.length > 0) {
    const [run] = await getDb().insert(scrapeRuns).values({
      kind: "manual", status: "running",
      params: { action: "fix-sincopa-sides", note, urlsFile, pages: pages.length },
    }).returning();
    if (!run) throw new Error("no se pudo abrir el run");
    runId = run.id;
    result = await withRunScope(run.id, () => rejectClaims(stale, `[run ${run.id}] ${note}`));
    await finishRun(run.id, "ok", { ...result, acceptedWrong: acceptedWrong.length });
  }
  const report = { dryRun: !confirm, runId, pages: pages.length, staleCandidates: stale.length, missingNew, ...result, acceptedWrong: acceptedWrong.length };
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...report, acceptedWrongList: acceptedWrong }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
