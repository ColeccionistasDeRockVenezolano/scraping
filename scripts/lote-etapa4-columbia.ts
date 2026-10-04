// CRV · Etapa 4 del nuevo lote: Brian (2026-10-03) decidió que Columbia es un
// sello propio, no una filial de Sony Music. Deshace esa parte del run 11798:
// crea «Columbia» (record_label), le pasa los 7 discos y quita el alias
// «Columbia» de Sony Music (396). Un run de operador.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-columbia.ts
import { deleteAlias } from "../src/api/repositories/aliases.js";
import { closeDb } from "../src/db/client.js";
import { createEntity, updateEntity, withOperatorRun } from "../src/merge/operator.js";

const ALBUMS = [445, 446, 448, 4236, 6959, 7899, 7900];
const SONY = 396;
const NOTE = "Columbia es un sello propio, no una filial de Sony Music (Brian, 2026-10-03; corrige el run 11798)";

async function main(): Promise<void> {
  const { runId, result } = await withOperatorRun({ name: "label_review", operator: "brian", note: NOTE, params: { lote: "nuevo-lote-2026-10-02", etapa: 4 } }, async (context) => {
    const created = await createEntity(context, "organization", { name: "Columbia", organization_type: "record_label" }, { allowSimilar: true });
    for (const albumId of ALBUMS) await updateEntity(context, "album", albumId, { label_id: created.id });
    const alias = await context.client.query<{ id: string }>("SELECT id::text FROM ingest.organization_aliases WHERE organization_id=$1 AND alias='Columbia'", [SONY]);
    for (const row of alias.rows) await deleteAlias(context, "organization", SONY, Number(row.id));
    return created.id;
  });
  console.log(`run ${runId}: Columbia = organización ${result}, ${ALBUMS.length} discos`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
