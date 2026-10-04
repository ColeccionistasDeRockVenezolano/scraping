// Membresías repetidas (caso Abaddon, Brian, 2026-10-04). La clave de
// idempotencia por rol literal dejaba a la misma persona dos veces en una
// banda («Guitar» de Sincopa y «Guitars» de Metal Archives); 202 pares en 72
// artistas. Además el adaptador de Sincopa < 1.3.5 daba a toda una celda de
// miembros el primer rol («Bass & Vocals» para los trombonistas de Dimensión
// Latina). Se corrige contra el core, sin reingerir:
//
//   --phase=sincopa     roles de Sincopa releídos con el adaptador 1.3.5 en las
//                       fichas que cambian; solo se corrige la fila cuyo rol
//                       sigue siendo el que Sincopa afirmó (el resto se informa).
//   --phase=consolidar  una fila por persona y etapa en cada banda
//                       (consolidateMemberships): rol unido, años completados,
//                       los textos de rol que desaparecen quedan en las notas.
//
// Sin --confirm todo corre en una transacción que se revierte y deja el
// informe *-dry-run.json. Cada fase confirmada es un run deshacible.
//
//   tsx scripts/fix-membresias-repetidas.ts --phase=sincopa|consolidar [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getPool } from "../src/db/client.js";
import { consolidateMemberships } from "../src/merge/equivalent-relations.js";
import { updateRelation, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";

const DATE = "2026-10-04";
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length);
const confirm = process.argv.includes("--confirm");
if (phase !== "sincopa" && phase !== "consolidar") throw new Error("uso: --phase=sincopa|consolidar [--confirm]");

class DryRun extends Error {
  constructor(readonly result: unknown) { super("ensayo: se revierte"); }
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface SincopaFix { artistId: number; artist: string; url: string; membershipId: number; person: string; before: string; after: string }
interface SincopaSkip { artistId: number; url: string; record: string; oldRole: string; newRole: string; reason: string; rows?: string[] }

async function sincopa(context: OperatorContext): Promise<{ fixed: SincopaFix[]; skipped: SincopaSkip[]; pages: number }> {
  const { client } = context;
  const adapter = new SincopaAdapter();
  const pages = (await client.query<{ url: string; stored_path: string; ids: string[] }>(`
    SELECT url, (array_agg(stored_path ORDER BY id DESC))[1] AS stored_path, array_agg(id::text) AS ids
      FROM ingest.raw_pages
     WHERE source_id=(SELECT id FROM ingest.sources WHERE slug='sincopa')
       AND EXISTS (SELECT 1 FROM ingest.claims c WHERE c.raw_page_id=raw_pages.id AND c.entity_kind='artist_membership')
     GROUP BY url ORDER BY url`)).rows;
  const fixed: SincopaFix[] = [];
  const skipped: SincopaSkip[] = [];
  let touchedPages = 0;
  for (const page of pages) {
    let body: string;
    try { body = new TextDecoder("windows-1252").decode(readFileSync(`data/${page.stored_path}`)); } catch { continue; }
    const records = adapter.extractSnapshot({ url: page.url, kind: "html", rawPageId: Number(page.ids[0]), body })
      .filter((record) => record.entityKind === "artist_membership")
      .map((record) => Object.fromEntries(record.fields.map((field) => [field.field, String(field.value)])));
    // Lo que Sincopa afirmó antes: rol por nombre, desde los claims de la página.
    const claimed = (await client.query<{ person: string; role: string; artist_id: string | null }>(`
      SELECT p.raw_value#>>'{}' AS person, r.raw_value#>>'{}' AS role, m.artist_id::text
        FROM ingest.claims p
        JOIN ingest.claims r ON r.raw_page_id=p.raw_page_id AND r.identity_key=p.identity_key AND r.field='role'
                            AND r.entity_kind='artist_membership'
        LEFT JOIN public.artist_members m ON m.id=COALESCE(p.artist_membership_id, r.artist_membership_id)
       WHERE p.raw_page_id=ANY($1::bigint[]) AND p.entity_kind='artist_membership' AND p.field='person_name'`,
    [page.ids])).rows;
    const artistId = claimed.find((row) => row.artist_id)?.artist_id;
    let pageChanged = false;
    for (const record of records) {
      const name = record["person_name"]!;
      const newRole = record["role"]!;
      const old = claimed.find((row) => row.person === name);
      if (!old || old.role === newRole) continue;
      pageChanged = true;
      // El mismo nombre dos veces en la ficha (otra alineación, «Ex-Members»):
      // no se sabe qué rol viejo corresponde a cuál nuevo.
      if (records.filter((other) => other["person_name"] === name).length > 1
        || new Set(claimed.filter((row) => row.person === name).map((row) => row.role)).size > 1) {
        skipped.push({ artistId: Number(artistId ?? 0), url: page.url, record: name, oldRole: old.role, newRole, reason: "nombre repetido en la ficha" });
        continue;
      }
      if (!artistId) {
        skipped.push({ artistId: 0, url: page.url, record: name, oldRole: old.role, newRole, reason: "la ficha no llegó al core" });
        continue;
      }
      // La fila puede seguir con el nombre de Sincopa o venir de dividir un
      // nombre compuesto («Fucho González, Hernán Omero & José Rodríguez»).
      const rows = (await client.query<{ id: string; role: string; person: string }>(`
        SELECT m.id::text, m.role, p.name AS person FROM public.artist_members m JOIN public.persons p ON p.id=m.person_id
         WHERE m.artist_id=$1 ORDER BY m.id`, [artistId])).rows
        .filter((row) => [name, name.replace(/["“”][^"“”]*["“”]/gu, " ")]
          .some((variant) => ` ${fold(variant)} `.includes(` ${fold(row.person)} `)));
      const target = rows.filter((row) => row.role === old.role);
      if (!target.length) {
        skipped.push({ artistId: Number(artistId), url: page.url, record: name, oldRole: old.role, newRole,
          reason: rows.length ? "la fila ya no tiene el rol de Sincopa" : "sin fila con ese nombre en la banda",
          rows: rows.map((row) => `${row.id} ${row.person}: ${row.role}`) });
        continue;
      }
      for (const row of target) {
        await updateRelation(context, "artist_membership", Number(row.id), { role: newRole });
        fixed.push({ artistId: Number(artistId), artist: "", url: page.url, membershipId: Number(row.id), person: row.person, before: row.role, after: newRole });
      }
    }
    if (pageChanged) touchedPages += 1;
  }
  const names = new Map((await client.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.artists WHERE id=ANY($1::bigint[])", [[...new Set(fixed.map((item) => item.artistId))]])).rows
    .map((row) => [Number(row.id), row.name]));
  for (const item of fixed) item.artist = names.get(item.artistId) ?? "";
  return { fixed, skipped, pages: touchedPages };
}

async function consolidate(context: OperatorContext) {
  const { client, runId, note } = context;
  const artists = (await client.query<{ artist_id: string }>(`
    SELECT DISTINCT artist_id::text FROM public.artist_members
     GROUP BY artist_id, person_id HAVING count(*)>1 ORDER BY 1`)).rows.map((row) => Number(row.artist_id));
  // La misma página nombra dos veces a la persona en la banda (otra
  // alineación, o hermanos que la ficha confunde: los O'Brien de Las Cuatro
  // Monedas). Unirlas sería decidir una identidad: decide una persona.
  const samePage = (await client.query<{ artist_id: string; person_id: string; url: string; ids: string[] }>(`
    SELECT m.artist_id::text, m.person_id::text, rp.url, array_agg(DISTINCT m.id::text) AS ids
      FROM public.artist_members m
      JOIN ingest.claims c ON c.artist_membership_id=m.id
      JOIN ingest.raw_pages rp ON rp.id=c.raw_page_id
     WHERE (m.artist_id, m.person_id) IN (SELECT artist_id, person_id FROM public.artist_members GROUP BY 1,2 HAVING count(*)>1)
     GROUP BY 1,2,3 HAVING count(DISTINCT m.id)>1`)).rows;
  const apart = new Set(samePage.map((row) => `${row.artist_id}|${row.person_id}`));
  let reviewsOpened = 0;
  for (const row of samePage) {
    const open = await client.query(`
      SELECT 1 FROM ingest.review_queue WHERE kind='manual_review' AND status IN ('open','in_progress')
         AND payload->>'detector'='membership-same-page' AND payload->>'artistId'=$1 AND payload->>'personId'=$2`,
    [row.artist_id, row.person_id]);
    if (open.rowCount) continue;
    await client.query("INSERT INTO ingest.review_queue(kind,priority,payload,notes) VALUES('manual_review',5,$1::jsonb,$2)", [
      JSON.stringify({ detector: "membership-same-page", version: 1, runId, artistId: Number(row.artist_id), personId: Number(row.person_id),
        ids: row.ids.map(Number), url: row.url }),
      `La misma ficha (${row.url}) nombra dos veces a la persona en la banda: ¿otra alineación o dos personas con el mismo nombre?`,
    ]);
    reviewsOpened += 1;
  }
  const groups = [];
  let merged = 0;
  for (const artistId of artists) {
    const outcome = await consolidateMemberships(client, { artistId }, note, runId,
      { skip: (artist, person) => apart.has(`${artist}|${person}`) });
    merged += outcome.merged;
    reviewsOpened += outcome.reviewsOpened;
    groups.push(...outcome.groups);
  }
  const names = await client.query<{ kind: string; id: string; name: string }>(`
    SELECT 'artist' AS kind, id::text, name FROM public.artists WHERE id=ANY($1::bigint[])
    UNION ALL SELECT 'person', id::text, name FROM public.persons WHERE id=ANY($2::bigint[])`,
  [artists, [...new Set(groups.map((group) => group.personId))]]);
  const label = new Map(names.rows.map((row) => [`${row.kind}:${row.id}`, row.name]));
  const remaining = (await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM (SELECT 1 FROM public.artist_members GROUP BY artist_id, person_id HAVING count(*)>1) pairs")).rows[0]!.n;
  return {
    artists: artists.length, merged, reviewsOpened, pairsLeft: Number(remaining), samePage,
    groups: groups.map((group) => ({
      artist: label.get(`artist:${group.artistId}`), person: label.get(`person:${group.personId}`), ...group,
    })),
  };
}

async function main(): Promise<void> {
  const note = phase === "sincopa"
    ? "Membresías repetidas (Brian, 2026-10-04): roles de Sincopa releídos con el adaptador 1.3.5 (varios roles por celda)"
    : "Membresías repetidas (Brian, 2026-10-04): una fila por persona y etapa en cada banda; roles unidos, textos originales en notas";
  const work = (context: OperatorContext) => (phase === "sincopa" ? sincopa(context) : consolidate(context));
  let runId: number | null = null;
  let result: unknown;
  try {
    const done = await withOperatorRun({ name: `membresias-repetidas-${phase}`, operator: "brian", note, params: { phase } }, async (context) => {
      const output = await work(context);
      if (!confirm) throw new DryRun(output);
      return output;
    });
    runId = done.runId;
    result = done.result;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    result = error.result;
  }
  const file = `reports/membresias-repetidas-${DATE}-${phase}-${confirm ? `run${runId}` : "dry-run"}.json`;
  writeFileSync(file, `${JSON.stringify({ phase, confirm, runId, ...(result as object) }, null, 2)}\n`);
  const summary = Object.fromEntries(Object.entries(result as Record<string, unknown>)
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : value]));
  console.log(JSON.stringify({ runId, file, ...summary }));
  await closeDb();
}

await main();
