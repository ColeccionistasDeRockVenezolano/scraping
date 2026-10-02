// CRV · Mesa del caso Canserbero extendido (Brian, 2026-10-02: «apruébalos según
// lo que recomiendes»). Decisiones par a par, revisadas con bandas, discos y
// fuentes de cada ficha (reports/canserbero-choques-2026-10-02-confirm.json).
//
//   merge    proyecto o colegas en común que el detector no vio: dos integrantes
//            de Luz Verde que también son Frankie & The Blue Devils; dos de Niño
//            Nuclear que también son Los Spectors; el mismo apodo en la misma
//            banda; el mismo disco; una nota «ex La Corte»; o una biografía que da
//            el nombre real y un recopilatorio común.
//   dismiss  personas distintas (otro instrumento, otra escena, otro país, o dos
//            perfiles separados en Metal Archives). Al ser distintas, cada ficha
//            se llama por su nombre limpio aunque coincida con la otra.
//   (resto)  mismo nombre y mismo rol sin proyecto común: quedan abiertos (regla
//            de Brian del 2026-09-28: la firma parecida sola no basta).
//
// Tanda 2 (Brian: «¿no hay nada que los relacione?»): de los 8 abiertos, tres
// tenían prueba escrita que el detector no vio porque solo comparaba con el
// PRIMER homónimo: la biografía de Big Mandrake dice que la formaron músicos de
// Sin Sospechas (mismo cantante, guitarrista y saxofonista); la de Factor
// Mental, que Felipe Nevado formó Arian en 2005; y la de Demise, que su bajista
// Christian Estepa es el de Intemperia (donde había dos fichas suyas).
//
// Previsualiza por defecto; --confirm escribe (fusiones y renombres en una run,
// descartes con `rejectReview`, cada uno con su run). --tanda=1|2 (por defecto 1).
import { writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";
import { rejectReview } from "../src/review/operator-review.js";

const OPERATOR = "claude-code (delegado por Brian)";
const CONFIRM = process.argv.includes("--confirm");

const MERGES: Array<{ keep: number; drop: number; name: string; aliases?: string[]; why: string }> = [
  { keep: 599, drop: 5764, name: "Carlos Mendoza", why: "Luz Verde (Carlos Mendoza y Eduardo Benatar) es también Frankie & The Blue Devils (Charlie y Eddie Devil)" },
  { keep: 3034, drop: 5766, name: "Eduardo Benatar", why: "Luz Verde (Carlos Mendoza y Eduardo Benatar) es también Frankie & The Blue Devils (Charlie y Eddie Devil)" },
  { keep: 15539, drop: 17042, name: "Miguel Soteldo", why: "Niño Nuclear (Miguel Soteldo y Ovidio Pernalete) es también Los Spectors" },
  { keep: 15538, drop: 17039, name: "Ovidio Pernalete", why: "Niño Nuclear (Miguel Soteldo y Ovidio Pernalete) es también Los Spectors" },
  { keep: 15736, drop: 15735, name: "Jesus Nieto", why: "mismo apodo «El gordo» y misma batería en Raped Dolls" },
  { keep: 16811, drop: 9004, name: "Trece", why: "«A.K.A. Trece» acreditado en Dioslepague / Venus Mixes (2001), disco donde figura Trece" },
  { keep: 15451, drop: 16586, name: "El Cura", aliases: ["Roamin 'Alley 69'"], why: "la fuente lo nombra «El Cura ex La Corte»" },
  { keep: 18060, drop: 18077, name: "Cristian Moraga", aliases: ["Funky C"], why: "la biografía de C-funk da su nombre real, Cristian Moraga; ambos en los recopilatorios de DJ Afro" },
  { keep: 17663, drop: 3602, name: "Reynaldo Morales", why: "la biografía de DJ Rey da su nombre real, Reynaldo Morales; ambos en Noveno Festival Nuevas Bandas (1999)" },
];

const BIG_MANDRAKE = "la biografía de Big Mandrake (2011) dice que la integran músicos que antes tocaron en Sin Sospechas: mismo cantante, guitarrista y saxofonista";
const MERGES_2: typeof MERGES = [
  { keep: 3777, drop: 3810, name: "Gilberto Lazo", aliases: ["Control X"], why: "«Control X - Gilberto Lazo» acreditado en La Fantástica Máquina Mágica, disco de Big Mandrake donde Gilberto Lazo es la voz" },
  { keep: 3777, drop: 16244, name: "Gilberto Lazo", why: BIG_MANDRAKE },
  { keep: 3774, drop: 16246, name: "Eduardo Malavé", why: BIG_MANDRAKE },
  { keep: 2509, drop: 16250, name: "Francisco Issa", why: `${BIG_MANDRAKE} («Frank» Issa en Sin Sospechas, Francisco Issa al saxo en Big Mandrake)` },
  { keep: 4782, drop: 5648, name: "Felipe Nevado", why: "la biografía de Factor Mental: «Felipe Nevado desarrolló una carrera como solista al formar la agrupación Arian en 2005»; la de Arian: «formada por Felipe Nevado, conocido como Arian»" },
  { keep: 13887, drop: 262, name: "Christian Estepa", why: "las dos fichas son el bajista de Intemperia; la biografía de Demise nombra a «Christian Estepa en el bajo (Intemperia)» y Metal Archives da Pipi = Christian Estepa" },
];

const DISMISS: Array<{ review: number; rename?: { id: number; to: string }; why: string }> = [
  { review: 1171494, rename: { id: 6021, to: "Carlos Hernández" }, why: "DJ de Jahkogba frente a guitarrista de jazz (Tree Of Life, Pablo Gil)" },
  { review: 1171495, rename: { id: 8562, to: "Jorge García" }, why: "guitarrista de Icaro (1983) frente a Paté Sónico de Colectivo Proyectil (2002)" },
  { review: 1171502, rename: { id: 13388, to: "Jesus Soto" }, why: "dos perfiles separados en Metal Archives: batería de Noctis Imperium y guitarra de Carnage" },
  { review: 1171503, rename: { id: 13784, to: "Luis Rojas" }, why: "bajo de Nocturnal (metal) frente a batería de Dandy León" },
  { review: 1171505, rename: { id: 13943, to: "Luis Martinez" }, why: "guitarra de Axariel (metal) frente a Ficción y Ojo Fatuo" },
  { review: 1171506, rename: { id: 14299, to: "Raul Garcia" }, why: "dos perfiles separados en Metal Archives: guitarra de Funebria y voz de Infestus" },
  { review: 1171508, rename: { id: 14544, to: "Alejandro García" }, why: "guitarrista colombiano de Morghduet frente a Jahbafana (reggae)" },
  { review: 1171510, rename: { id: 14737, to: "Luis Aguilar" }, why: "bajo de Disturbing Behavior y Overhate frente a Los Oceánicos y The Luchos" },
  { review: 1171511, rename: { id: 15045, to: "Alejandro Galicia" }, why: "voz de Hater (metal) frente a guitarra de Sin Salida" },
  { review: 1171512, rename: { id: 15239, to: "Luis Gonzalez" }, why: "bajo de Grotesque Deformity frente a batería de Stereografía" },
  { review: 1171513, rename: { id: 15362, to: "Daniel Perdomo" }, why: "Danian (Wikipedia) frente al proyecto unipersonal Dhargorak" },
  { review: 903992, rename: { id: 16525, to: "Marco León" }, why: "batería de Tensión Cero frente a voz y guitarra de Odo'Sha" },
  { review: 904363, rename: { id: 17597, to: "Nelson Ramírez" }, why: "voz de Sepulcro frente a teclados de Radio Clip" },
];

async function rename(client: PoolClient, runId: number, id: number, to: string, why: string): Promise<string | null> {
  const current = (await client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1 FOR UPDATE", [id])).rows[0]?.name;
  if (current === undefined || current === to) return null;
  await client.query("UPDATE public.persons SET name=$2, updated_at=now() WHERE id=$1", [id, to]);
  await client.query(`
    INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
    VALUES($1,$2,'name_variant',$3,false,'high','Nombre anterior a una corrección del propietario') ON CONFLICT DO NOTHING`,
  [id, current, normalizeEntityName(current).primaryKey]);
  const audit = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,'person',$2,'name',$3::jsonb,$4::jsonb,$5,'high','human') RETURNING id::text`,
  [runId, id, JSON.stringify(current), JSON.stringify(to), `Caso Canserbero extendido (mesa): ${why}`]);
  await client.query(`
    INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id)
    SELECT $1::bigint, id FROM ingest.claims WHERE person_id=$2
    UNION SELECT $1::bigint, mac.claim_id FROM ingest.merge_audit ma
      JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE ma.person_id=$2
    ON CONFLICT DO NOTHING`, [Number(audit.rows[0]!.id), id]);
  return current;
}

async function main(): Promise<void> {
  const tanda = process.argv.find((value) => value.startsWith("--tanda="))?.slice("--tanda=".length) ?? "1";
  const merges = tanda === "2" ? MERGES_2 : MERGES;
  const dismiss = tanda === "2" ? [] : DISMISS;
  const out: Record<string, unknown> = { tanda, merges, dismiss, confirm: CONFIRM };
  if (!CONFIRM) { console.log(JSON.stringify({ tanda, merges: merges.length, dismiss: dismiss.length })); return; }

  const failed: Array<{ step: string; error: string }> = [];
  out["mergeRunId"] = (await withOperatorRun({
    name: "personas:canserbero-mesa", operator: OPERATOR,
    note: "Caso Canserbero extendido: pares de la mesa decididos con evidencia (Brian, 2026-10-02: «apruébalos según lo que recomiendes»).",
  }, async (context) => {
    for (const pair of merges) {
      await context.client.query("SAVEPOINT pair");
      try {
        const preview = await previewEntityMerge(context.client, "person", pair.keep, pair.drop);
        await mergeEntities(context, { kind: "person", keepId: pair.keep, dropId: pair.drop, previewHash: preview.previewHash, keepDropNameAsAlias: true });
        await rename(context.client, context.runId, pair.keep, pair.name, pair.why);
        for (const alias of pair.aliases ?? []) {
          await context.client.query(`
            INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
            SELECT $1::bigint,$2::text,'name_variant',$3::text,false,'high','Alias añadido por una corrección del propietario'
             WHERE NOT EXISTS (SELECT 1 FROM ingest.person_aliases WHERE person_id=$1::bigint AND normalized_alias=$3::text)`,
          [pair.keep, alias, normalizeEntityName(alias).primaryKey]);
        }
        await context.client.query("RELEASE SAVEPOINT pair");
      } catch (error) {
        await context.client.query("ROLLBACK TO SAVEPOINT pair");
        failed.push({ step: `merge ${pair.drop}→${pair.keep}`, error: (error as Error).message.slice(0, 200) });
      }
    }
    for (const item of dismiss) {
      if (!item.rename) continue;
      await rename(context.client, context.runId, item.rename.id, item.rename.to, `son personas distintas: ${item.why}`);
    }
  })).runId;

  const dismissed: number[] = [];
  for (const item of dismiss) {
    try {
      await rejectReview(item.review, { operator: OPERATOR, note: `Son personas distintas: ${item.why} (caso Canserbero extendido, 2026-10-02)` });
      dismissed.push(item.review);
    } catch (error) {
      failed.push({ step: `dismiss ${item.review}`, error: (error as Error).message.slice(0, 200) });
    }
  }
  out["dismissed"] = dismissed;
  out["failed"] = failed;
  writeFileSync(tanda === "2" ? "reports/canserbero-mesa-2026-10-02-tanda2.json" : "reports/canserbero-mesa-2026-10-02.json", `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ mergeRunId: out["mergeRunId"], dismissed: dismissed.length, failed }, null, 2));
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
