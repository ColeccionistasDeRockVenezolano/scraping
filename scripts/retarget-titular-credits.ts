// CRV · Créditos de un proyecto solista que deben figurar a nombre de su titular.
//
// REGLA DE BRIAN (2026-10-01, caso Canserbero): si el artista es el proyecto de
// una persona (rol «Titular del proyecto», caso Ashwave) y un crédito de persona
// —voz, instrumento, letras, producción— cuelga del ARTISTA, en la ficha del
// disco aparece «Canserbero» donde debería decir «Tirone González». Quien canta
// o escribe es la persona; el artista es el nombre con el que se publica.
//
// Solo mueve el acreditado: no cambia el tipo ni el rol, y los créditos que
// queden repetidos los une `mergeEquivalentCredits` (la misma pieza que usan las
// fusiones, que conserva las notas). Un artista con más de un titular no se
// toca: eso ya no es un proyecto solista.
//
// Previsualiza por defecto; escribe con --confirm, siempre ligado a un run.
//   tsx scripts/retarget-titular-credits.ts [--confirm] [--artist=<id>] [--out=<informe.json>]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { mergeEquivalentCredits } from "../src/merge/equivalent-relations.js";

const TODAY = new Date().toISOString().slice(0, 10);
const NOTE = "Créditos del proyecto a nombre de su titular (regla de Brian, 2026-10-01, caso Canserbero)";

interface Row {
  id: string; parent: string; parent_title: string; credit_type: string; role: string;
  artist_id: string; artist_name: string; person_id: string; person_name: string; titulares: number;
}

function query(table: "album_credits" | "track_credits"): string {
  const parent = table === "album_credits" ? "album_id" : "track_id";
  const parentTable = table === "album_credits" ? "public.albums" : "public.tracks";
  const parentTitle = "title";
  return `
    SELECT c.id::text, c.${parent}::text AS parent, w.${parentTitle} AS parent_title,
           c.credit_type::text AS credit_type, c.role,
           c.artist_id::text, a.name AS artist_name, am.person_id::text, p.name AS person_name,
           (SELECT count(*)::int FROM public.artist_members t
             WHERE t.artist_id = c.artist_id AND t.role = 'Titular del proyecto') AS titulares
      FROM public.${table} c
      JOIN ${parentTable} w ON w.id = c.${parent}
      JOIN public.artists a ON a.id = c.artist_id
      JOIN public.artist_members am ON am.artist_id = c.artist_id AND am.role = 'Titular del proyecto'
      JOIN public.persons p ON p.id = am.person_id
     WHERE c.artist_id IS NOT NULL
     ORDER BY a.name, c.id`;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const onlyArtist = process.argv.find((arg) => arg.startsWith("--artist="))?.slice("--artist=".length);
  const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
    ?? `reports/titular-credits-${TODAY}${confirm ? "-confirm" : "-dry-run"}.json`;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "retarget_titular_credits", note: NOTE, confirm })]);
    const runId = Number(run.rows[0]!.id);

    const moved: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    const touchedPersons = new Set<number>();
    for (const table of ["album_credits", "track_credits"] as const) {
      const rows = (await client.query<Row>(query(table))).rows
        .filter((row) => onlyArtist === undefined || row.artist_id === onlyArtist);
      for (const row of rows) {
        const detail = { table, creditId: Number(row.id), parentId: Number(row.parent), parent: row.parent_title,
          creditType: row.credit_type, role: row.role, from: { artistId: Number(row.artist_id), name: row.artist_name },
          to: { personId: Number(row.person_id), name: row.person_name } };
        if (row.titulares !== 1) {
          skipped.push({ ...detail, reason: `el artista tiene ${row.titulares} titulares: ya no es un proyecto de una sola persona` });
          continue;
        }
        await client.query(`UPDATE public.${table} SET person_id=$2, artist_id=NULL WHERE id=$1`, [Number(row.id), Number(row.person_id)]);
        const column = table === "album_credits" ? "album_credit_id" : "track_credit_id";
        const kind = table === "album_credits" ? "album_credit" : "track_credit";
        const audit = await client.query<{ id: string }>(`
          INSERT INTO ingest.merge_audit(run_id,entity_kind,${column},field,old_value,new_value,reason,confidence,performed_by)
          VALUES($1,$2::ingest.claim_entity_kind,$3,'credited_to',$4::jsonb,$5::jsonb,$6,'high','human') RETURNING id::text`,
        [runId, kind, Number(row.id),
          JSON.stringify({ artistId: Number(row.artist_id), name: row.artist_name }),
          JSON.stringify({ personId: Number(row.person_id), name: row.person_name }),
          `${NOTE} — «${row.role}» en «${row.parent_title}» es de la persona, no del proyecto`]);
        // La evidencia del crédito: sus claims y los de auditorías previas de la
        // misma fila (doctor `merge_audit.coverage`: toda auditoría enlaza claims).
        await client.query(`
          INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id)
          SELECT $1::bigint, id FROM ingest.claims WHERE ${column}=$2
          UNION SELECT $1::bigint, mac.claim_id FROM ingest.merge_audit ma
            JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE ma.${column}=$2
          ON CONFLICT DO NOTHING`, [Number(audit.rows[0]!.id), Number(row.id)]);
        moved.push(detail);
        touchedPersons.add(Number(row.person_id));
      }
    }
    // Reapuntar puede dejar a la persona dos veces en la misma obra con el
    // mismo rol (ya estaba acreditada y además lo estaba el proyecto).
    let mergedCredits = 0;
    for (const personId of touchedPersons) {
      mergedCredits += await mergeEquivalentCredits(client, { column: "person_id", id: personId }, NOTE, runId);
    }

    const result = { runId, confirm, moved: moved.length, mergedCredits, skipped: skipped.length, details: moved, skippedDetails: skipped };
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ moved: moved.length, mergedCredits, skipped: skipped.length })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ out, runId, confirm, moved: moved.length, mergedCredits, skipped: skipped.length }, null, 2));
    if (!confirm) console.log("(previsualización: nada se escribió) para aplicar: --confirm");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
