// Las fichas de disco de jazz, clásica, new age, étnica y latin pop llevan una fila
// «Instrument:» entre Company y Genre que el adapter 1.2.0 no contaba: el sello pasó a
// título («Bach To Venezuela Independent») y el instrumento a sello («Violin»). El
// adapter 1.2.1 lo lee bien; este script RECHAZA los claims candidatos viejos de esas
// páginas cuya identidad depende del título (disco, pistas, créditos, sellos) para que
// `ingest-sincopa-stored.ts --urls-file=…` los vuelva a emitir con el título correcto.
// Artistas y personas no cambian (se reutilizan). Nada toca el core: son claims `candidate`.
//   tsx scripts/fix-sincopa-instrument-pages.ts [--confirm] [--urls-out=reports/sincopa-instrument-pages.txt]
import { writeFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb } from "../src/db/client.js";
import { loadStoredAdapterPages } from "../src/ingest/runner.js";
import { withOperatorRun } from "../src/merge/operator.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const HEADER_WITH_INSTRUMENT = /Artist:[\s\S]{0,600}?Instrument[\s\S]{0,200}?Release Year/i;
const DEPENDS_ON_TITLE = ["album", "track", "album_credit", "track_credit", "organization"];

async function main(): Promise<void> {
  const adapter = new SincopaAdapter();
  const pages = (await loadStoredAdapterPages("sincopa", adapter))
    .filter((page) => /\/cdinfo/.test(page.url) && typeof page.body === "string" && HEADER_WITH_INSTRUMENT.test(page.body));
  const ids = pages.map((page) => page.rawPageId).filter((id): id is number => id !== undefined);
  const urlsOut = arg("urls-out") ?? "reports/sincopa-instrument-pages.txt";
  writeFileSync(urlsOut, `${pages.map((page) => page.url).join("\n")}\n`);
  console.log(JSON.stringify({ pages: pages.length, rawPageIds: ids.length, urlsOut, confirm: process.argv.includes("--confirm") }));
  if (!process.argv.includes("--confirm")) return;

  const { runId, result } = await withOperatorRun({
    name: "sincopa-instrument-fix", operator: "Claude",
    note: "Sincopa: fichas con «Instrument:» mal leídas por el adapter 1.2.0 (título con el sello, sello=instrumento); se rechazan los claims candidatos viejos para reemitirlos con 1.2.1",
    params: { pages: ids.length },
  }, async ({ client, runId: id }) => {
    const claims = await client.query<{ n: string }>(`
      WITH hit AS (
        UPDATE ingest.claims SET status='rejected', updated_at=now()
         WHERE raw_page_id = ANY($1::bigint[]) AND status='candidate' AND entity_kind = ANY($2::ingest.claim_entity_kind[])
        RETURNING id)
      SELECT count(*)::text AS n FROM hit`, [ids, DEPENDS_ON_TITLE]);
    const reviews = await client.query(`
      UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolved_at=now(), updated_at=now(),
             resolution_note=$2
       WHERE status IN ('open','in_progress')
         AND claim_a_id IN (SELECT id FROM ingest.claims WHERE raw_page_id = ANY($1::bigint[]) AND status='rejected' AND entity_kind = ANY($3::ingest.claim_entity_kind[]))`,
    [ids, `[run ${id}] claim viejo de ficha con «Instrument:» (adapter 1.2.0): se reemite con 1.2.1`, DEPENDS_ON_TITLE]);
    return { rejectedClaims: Number(claims.rows[0]?.n ?? 0), dismissedReviews: reviews.rowCount ?? 0 };
  });
  console.log(JSON.stringify({ runId, ...result }));
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
