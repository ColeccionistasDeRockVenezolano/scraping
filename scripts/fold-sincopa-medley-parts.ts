// Pistas de Sincopa sin número que no son pistas: las canciones de un popurrí
// («05- Cinco Recuerdos Latinos» y debajo «Tú Eres Mi Destino», «Vestida de
// Novia»…) y el título de una obra sobre sus movimientos numerados («Birds
// Op. 66» → «07- Swallows», «08- The Swan»…). El core exige posición y nunca
// las creará; quedaban candidatas para siempre.
//
// Se relee cada página con el adaptador actual para conocer el orden:
//   - dos o más títulos sin número tras una pista numerada → partes de esa pista:
//     van a sus notas («Incluye: A; B; C.») si la pista del core en ese número
//     tiene el mismo título; los claims se rechazan con la nota;
//   - un solo título sin número seguido de una pista numerada → encabezado de
//     obra: se rechaza como pista (el dato queda en el claim);
//   - lo demás (títulos sueltos al principio, páginas sin ningún número) se deja.
//
//   tsx scripts/fold-sincopa-medley-parts.ts [--confirm --note="…"] [--out=…json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getPool } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const DATA_DIR = process.env["CRV_RAW_DATA_DIR"] ?? "/home/brian/apps/Coleccionistas De Rock Venezolano/data";

interface Loose { identityRaw: string; title: string }
type Plan =
  | { op: "partes"; url: string; trackId: number; parent: string; number: number; parts: Loose[]; notes: string }
  | { op: "encabezado"; url: string; header: Loose; before: string }
  | { op: "dejar"; url: string; items: Loose[]; why: string };

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: títulos sin número que son partes de un popurrí o el encabezado de una obra (no son pistas)";
  const pool = getPool();
  const { rows: pages } = await pool.query<{ id: string; url: string; stored_path: string; album_id: string | null; loose: string[] }>(`
    WITH t AS (
      SELECT c.raw_page_id, c.identity_raw, bool_or(c.field='track_number') has_num, bool_or(c.status='candidate') cand
        FROM ingest.claims c WHERE c.source_id=7 AND c.entity_kind='track' AND c.status IN ('candidate','accepted')
       GROUP BY 1, 2)
    SELECT p.id::text, p.url, p.stored_path,
           (SELECT max(a.album_id)::text FROM ingest.claims a WHERE a.source_id=7 AND a.entity_kind='album' AND a.status='accepted' AND a.raw_page_id=p.id) AS album_id,
           array_agg(t.identity_raw) FILTER (WHERE NOT t.has_num AND t.cand) AS loose
      FROM t JOIN ingest.raw_pages p ON p.id=t.raw_page_id
     GROUP BY p.id
    HAVING count(*) FILTER (WHERE t.has_num) > 0 AND count(*) FILTER (WHERE NOT t.has_num AND t.cand) > 0`);
  const adapter = new SincopaAdapter();
  const plan: Plan[] = [];
  for (const page of pages) {
    const loose = new Set(page.loose);
    if (page.album_id === null) { plan.push({ op: "dejar", url: page.url, items: [...loose].map((identityRaw) => ({ identityRaw, title: identityRaw })), why: "el disco no está en el core" }); continue; }
    const body = adapter.decodeBody(readFileSync(join(DATA_DIR, page.stored_path)));
    const tracks = adapter.extractSnapshot({ body, url: page.url } as never).filter((record) => record.entityKind === "track").map((record) => {
      const value = (field: string): string | undefined => { const found = record.fields.find((item) => item.field === field)?.value; return found === undefined || found === null ? undefined : String(found); };
      return { identityRaw: record.identity, title: value("title") ?? "", number: value("track_number") === undefined ? undefined : Number(value("track_number")) };
    });
    const { rows: core } = await pool.query<{ id: string; track_number: number; title: string; notes: string | null }>(
      "SELECT id::text, track_number, title, notes FROM public.tracks WHERE album_id=$1", [page.album_id]);
    const seen = new Set<string>();
    for (let i = 0; i < tracks.length; i += 1) {
      if (tracks[i]!.number !== undefined || !loose.has(tracks[i]!.identityRaw) || seen.has(tracks[i]!.identityRaw)) continue;
      let end = i;
      while (end + 1 < tracks.length && tracks[end + 1]!.number === undefined) end += 1;
      const run = tracks.slice(i, end + 1).filter((item) => loose.has(item.identityRaw) && !seen.has(item.identityRaw));
      for (const item of run) seen.add(item.identityRaw);
      const items = run.map(({ identityRaw, title }) => ({ identityRaw, title }));
      const previous = tracks.slice(0, i).reverse().find((item) => item.number !== undefined);
      const next = tracks[end + 1];
      if (end === i && next?.number !== undefined) {
        plan.push({ op: "encabezado", url: page.url, header: items[0]!, before: `${next.number}. ${next.title}` });
        continue;
      }
      if (previous === undefined || end === i) { plan.push({ op: "dejar", url: page.url, items, why: previous === undefined ? "antes de la primera pista numerada" : "un solo título suelto al final" }); continue; }
      const matches = core.filter((track) => track.track_number === previous.number && fold(track.title) === fold(previous.title));
      if (matches.length !== 1) { plan.push({ op: "dejar", url: page.url, items, why: `la pista ${previous.number} del core no es «${previous.title}»` }); continue; }
      const target = matches[0]!;
      const line = `Incluye: ${items.map((item) => item.title.replace(/^[\s\-–—•·*]+/u, "")).join("; ")}.`;
      if (target.notes?.includes(line)) { plan.push({ op: "partes", url: page.url, trackId: Number(target.id), parent: previous.title, number: previous.number!, parts: items, notes: target.notes }); continue; }
      plan.push({ op: "partes", url: page.url, trackId: Number(target.id), parent: previous.title, number: previous.number!, parts: items, notes: target.notes ? `${target.notes}\n${line}` : line });
    }
    const missing = [...loose].filter((identityRaw) => !seen.has(identityRaw));
    if (missing.length > 0) plan.push({ op: "dejar", url: page.url, items: missing.map((identityRaw) => ({ identityRaw, title: identityRaw })), why: "el adaptador actual ya no la emite sin número" });
  }

  const count = (op: Plan["op"]) => plan.filter((item) => item.op === op).reduce((sum, item) => sum + (item.op === "partes" ? item.parts.length : item.op === "encabezado" ? 1 : item.items.length), 0);
  const summary = { pages: pages.length, partes: count("partes"), pistasConPartes: plan.filter((item) => item.op === "partes").length, encabezados: count("encabezado"), dejadas: count("dejar") };
  let runId: number | undefined;
  const done = { notes: 0, rejected: 0, failed: 0 };
  if (confirm) {
    const result = await withOperatorRun({ name: "fold-sincopa-medley-parts", operator: "brian", note, params: {} }, async (context) => {
      const reason = `[run ${context.runId}] ${note}`;
      // Los rechazos van juntos al final: review_queue no tiene índice por claim
      // y una sentencia por título la recorre entera cada vez.
      const rejections: Array<{ identityRaw: string; why: string }> = [];
      for (const item of plan) {
        if (item.op === "encabezado") rejections.push({ identityRaw: item.header.identityRaw, why: `encabezado de obra sobre «${item.before}», no es una pista` });
        if (item.op !== "partes") continue;
        await context.client.query("SAVEPOINT medley");
        try {
          await updateEntity(context, "track", item.trackId, { notes: item.notes });
          done.notes += 1;
          for (const part of item.parts) rejections.push({ identityRaw: part.identityRaw, why: `parte de la pista ${item.number} «${item.parent}» (track ${item.trackId}), anotada en sus notas` });
          await context.client.query("RELEASE SAVEPOINT medley");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT medley");
          done.failed += 1;
          console.error(item.url, (error as Error).message);
        }
      }
      const { rows: rejected } = await context.client.query<{ id: string }>(`
        UPDATE ingest.claims c SET status='rejected', notes=$3 || ': ' || r.why, updated_at=now()
          FROM unnest($1::text[], $2::text[]) AS r(identity_raw, why)
         WHERE c.source_id=7 AND c.entity_kind='track' AND c.identity_raw=r.identity_raw AND c.status='candidate'
        RETURNING c.id::text`, [rejections.map((item) => item.identityRaw), rejections.map((item) => item.why), reason]);
      done.rejected = rejected.length;
      await context.client.query(`UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                                   WHERE status IN ('open','in_progress') AND claim_a_id = ANY($1::bigint[])`, [rejected.map((row) => row.id), reason]);
      return done;
    });
    runId = result.runId;
  }
  const out = arg("out");
  if (out) writeFileSync(out, `${JSON.stringify({ dryRun: !confirm, runId, ...summary, ...done, plan }, null, 2)}\n`);
  console.log(JSON.stringify({ dryRun: !confirm, runId, ...summary, ...done }, null, 2));
  await closeDb();
}

await main();
