// CRV · Resto de la limpieza de personas con nombre roto (run 11814): las
// conversiones que el ER frenó por parecido y el «A/B» que chocó con un
// crédito ya existente. Brian (2026-10-04, opción B / «pasar a artista u
// organización»). Revisadas una por una:
//
//   · ya catalogadas con otro nombre: Big Landin Orquesta (1030), Zaranda
//     (3861), Chonto Musik (1727); Carmelo Russo String Ensamble tenía tres
//     fichas de artista (4392, 4485, 4501) que se fusionan en 4392;
//   · el resto se crea como artista distinto a sabiendas (el parecido era
//     con otra cosa: «Maracaibo», «Chacao», «Sangre»…);
//   · «Eliseo Herrera/De La Colina»: De La Colina ya tenía su crédito; el de
//     la ficha doble pasa a Eliseo Herrera.
//
//   ./scripts/with-node22.sh npx tsx scripts/cleanup-personas-rotas-2026-10-04-resto.ts [--confirm]
import { closeDb } from "../src/db/client.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { createEntity, deleteEntity, deleteRelation, updateRelation, withOperatorRun } from "../src/merge/operator.js";
import { convertPerson } from "../src/review/person-corrections.js";

const NOTE = "Personas con nombre roto: agrupaciones y empresas a su tipo, resto del run 11814 (Brian, 2026-10-04)";
const TO_EXISTING: Record<number, number> = { 6120: 1030, 8615: 3861, 5221: 1727, 7129: 4392, 9066: 4392 };
const CREATE: Record<number, string> = {
  12003: "Grupo Sangre", 5148: "Miami Philharmonic Orchestra", 12150: "Grupo Acuario", 12163: "Grupo Nuestro",
  12052: "Orquesta Paul Mauriat", 12055: "Orquesta MGM", 12093: "Grupo Volcán", 12128: "Grupo Trazos",
  7717: "Orquesta Sinfónica de Maracaibo", 7851: "Grupo Bonsay", 8750: "La Orquesta De Daniel Grau",
  11994: "Orquesta Karavana", 37951: "Sinfónica Juvenil de Chacao",
};
class DryRun extends Error {}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const lines: string[] = [];
  let runId: number | null = null;
  try {
    const done = await withOperatorRun({ name: "cleanup-personas-rotas", operator: "brian", note: NOTE, params: { after: 11814 } }, async (context) => {
      for (const drop of [4485, 4501]) {
        const preview = await previewEntityMerge(context.client, "artist", 4392, drop, { lock: true });
        await mergeEntities(context, { kind: "artist", keepId: 4392, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: true });
        lines.push(`artista ${drop} «${preview.drop.name}» → 4392`);
      }
      for (const [person, artist] of Object.entries(TO_EXISTING)) {
        const result = await convertPerson(context.client, Number(person), { kind: "artist", id: artist }, true, `[run ${context.runId}] ${NOTE}`, context.runId);
        lines.push(`persona ${person} → artista ${artist} — ${result.detail}`);
      }
      for (const [person, name] of Object.entries(CREATE)) {
        const created = await createEntity(context, "artist", { name, artist_type: "group" }, { allowSimilar: true });
        const result = await convertPerson(context.client, Number(person), { kind: "artist", id: created.id }, false, `[run ${context.runId}] ${NOTE}`, context.runId);
        lines.push(`persona ${person} → artista nuevo ${created.id} «${name}» — ${result.detail}`);
      }
      // «Eliseo Herrera/De La Colina» (32409): Eliseo Herrera es 1 sola persona; De La Colina ya está acreditado.
      const eliseo = await context.client.query<{ id: string }>("SELECT id::text FROM public.persons WHERE name='Eliseo Herrera'");
      if (eliseo.rowCount !== 1) throw new Error("Eliseo Herrera no es único");
      for (const credit of (await context.client.query<{ id: string; track_id: string }>("SELECT id::text, track_id::text FROM public.track_credits WHERE person_id=32409")).rows) {
        const taken = await context.client.query("SELECT 1 FROM public.track_credits WHERE track_id=$1 AND person_id=$2 AND role='composer'", [credit.track_id, eliseo.rows[0]!.id]);
        if (taken.rowCount) await deleteRelation(context, "track_credit", Number(credit.id));
        else await updateRelation(context, "track_credit", Number(credit.id), { person_id: Number(eliseo.rows[0]!.id) });
      }
      await deleteEntity(context, "person", 32409);
      lines.push("persona 32409 «Eliseo Herrera/De La Colina» → créditos a Eliseo Herrera");
      if (!confirm) throw new DryRun();
    });
    runId = done.runId;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  console.log([`${confirm ? `run ${runId}` : "ensayo"}`, ...lines].join("\n"));
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
