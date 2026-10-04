// CRV · Nuuro (1250) y Arca son proyectos distintos de la misma persona
// (Alejandra Ghersi, P2528), según Brian (2026-10-02). La etapa 1 del lote
// (run 11461) tomó la ficha del lote «arca» como si fuera Nuuro: le rellenó
// origin_city y years_active y le colgó 26 claims del lote.
//
// En UN run reversible: devuelve a vacío los dos campos (solo si siguen con el
// valor que puso el lote) y desengancha de 1250 los claims del lote, que
// vuelven a `candidate` con su `identity_key` (`lote-2026-10-02:artist:arca`)
// para la ficha de Arca que crea la etapa 2. Los datos de la persona P2528
// (nombre real, nacimiento) son de Alejandra y valen para los dos proyectos.
//
//   ./scripts/with-node22.sh tsx scripts/lote-investigacion-separar-arca.ts [--confirm]
import { closeDb, getPool } from "../src/db/client.js";

const ARTIST_ID = 1250;
const STAGE1_RUN = 11461;
const FILLED: Record<string, string> = { origin_city: "Caracas", years_active: "2003-present" };
const NOTE = "Nuuro ≠ Arca (Brian, 2026-10-02): desenganchado del artista 1250; es de la ficha de Arca que crea la etapa 2";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const run = await client.query<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('manual','running',$1::jsonb) RETURNING id::text",
      [JSON.stringify({ action: "lote_investigacion_separar_arca", artistId: ARTIST_ID, stage1Run: STAGE1_RUN, confirm })]);
    const runId = Number(run.rows[0]!.id);
    const reverted: string[] = [];
    for (const [field, value] of Object.entries(FILLED)) {
      const updated = await client.query(
        `UPDATE public.artists SET ${field}=NULL, updated_at=now() WHERE id=$1 AND ${field}=$2`, [ARTIST_ID, value]);
      if (!updated.rowCount) continue;
      reverted.push(field);
      await client.query(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,artist_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'artist',$2,$3,to_jsonb($4::text),'null'::jsonb,$5,'high','human')`,
      [runId, ARTIST_ID, field, value, `${NOTE}; deshace el relleno del run ${STAGE1_RUN}`]);
    }
    const detached = await client.query(`
      UPDATE ingest.claims SET artist_id=NULL, status='candidate', updated_at=now(),
             notes = concat_ws(' · ', notes, $3::text)
       WHERE run_id=$1 AND artist_id=$2`, [STAGE1_RUN, ARTIST_ID, NOTE]);
    const person = await client.query(
      "UPDATE ingest.claims SET identity_secondary_key=NULL, updated_at=now() WHERE run_id=$1 AND identity_secondary_key=$2",
      [STAGE1_RUN, `artist:${ARTIST_ID}`]);
    const counters = { reverted, claimsDetached: detached.rowCount, personClaimsUnlinked: person.rowCount };
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1", [runId, JSON.stringify(counters)]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
    console.log(`separar Arca de Nuuro (${confirm ? "confirm" : "dry-run"}, run ${runId}): ${JSON.stringify(counters)}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
