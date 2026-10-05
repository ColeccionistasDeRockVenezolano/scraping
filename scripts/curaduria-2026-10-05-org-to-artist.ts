// CRV · Curaduría 2026-10-05: organización que en realidad es el artista (orquesta acreditada como
// sección de cuerdas, banda acreditada como productora de su propio disco). Sus créditos pasan a la
// ficha del artista (sin repetir uno que ya exista) y la organización se retira.
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-org-to-artist.ts --map="orgId=artistId;…" [--drop-credits=ids] --note="…"
import { closeDb } from "../src/db/client.js";
import { deleteEntity, withOperatorRun } from "../src/merge/operator.js";
import { removeRelation } from "../src/merge/removals.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const map = arg("map")!.split(";").map((pair) => pair.split("=").map(Number) as [number, number]);
const drop = (arg("drop-credits") ?? "").split(",").filter(Boolean).map(Number);
const note = arg("note")!;
const { runId } = await withOperatorRun({ name: "curation:organization-to-artist", operator: "claude-code", note }, async (context) => {
  for (const id of drop) await removeRelation(context.client, "album_credit", id, { note, runId: context.runId });
  for (const [orgId, artistId] of map) {
    for (const [table, parent] of [["album_credits", "album_id"], ["track_credits", "track_id"]] as const) {
      const { rows } = await context.client.query<{ id: string; dup: boolean }>(`
        SELECT c.id::text, EXISTS (SELECT 1 FROM public.${table} d WHERE d.${parent}=c.${parent} AND d.artist_id=$2 AND d.credit_type=c.credit_type) AS dup
          FROM public.${table} c WHERE c.organization_id=$1`, [orgId, artistId]);
      for (const row of rows) {
        if (row.dup) await removeRelation(context.client, table === "album_credits" ? "album_credit" : "track_credit", Number(row.id), { note, runId: context.runId });
        else await context.client.query(`UPDATE public.${table} SET organization_id=NULL, artist_id=$2 WHERE id=$1`, [row.id, artistId]);
      }
    }
    // Un sello real homónimo (PAN de Berlín publica a Arca) conserva su ficha: solo se le quita el crédito ajeno.
    const { rowCount } = await context.client.query("SELECT 1 FROM public.albums WHERE label_id=$1", [orgId]);
    if (!rowCount) await deleteEntity(context, "organization", orgId);
  }
});
console.log(`run ${runId}: ${map.length} organizaciones pasadas a artista`);
await closeDb();
