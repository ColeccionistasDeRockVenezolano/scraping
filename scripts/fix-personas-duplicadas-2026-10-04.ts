// CRV · Personas duplicadas (Brian, 2026-10-04, decisiones por preguntas):
// mismo nombre salvo tildes, mayúsculas y signos, Y con proyecto común (misma
// banda, disco o pista; regla [[fusion-personas-solo-con-proyecto]]). Los pares
// que Brian marcó como distintos o que ya están en la cola no entran.
//
//   · nombre completo → fusión en la ficha con bio o más vínculos; las demás
//     variantes quedan como alias y las bios se unen y quedan para que DeepSeek
//     flash las reescriba (cola text_rewrites);
//   · nombre de una palabra o con iniciales → aviso person_duplicate en la cola.
//
// Plan: reports/personas-duplicadas-2026-10-04-plan.json (lo genera el
// análisis del 2026-10-04). Cada grupo va en su SAVEPOINT: si uno falla, se
// anota y sigue. UN run de operador. Sin --confirm corre y se deshace;
// --sample=N limita el ensayo a N grupos repartidos.
//
//   ./scripts/with-node22.sh npx tsx scripts/fix-personas-duplicadas-2026-10-04.ts [--sample=40] [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const PLAN = "reports/personas-duplicadas-2026-10-04-plan.json";
const NOTE = "Personas duplicadas: mismo nombre y proyecto común (Brian, 2026-10-04)";

interface Group { keep: number; keepName: string; drops: number[]; names: string[]; name: string }
class DryRun extends Error {
  constructor(readonly lines: string[], readonly stats: Record<string, number>) { super("dry-run"); }
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const sample = Number(process.argv.find((arg) => arg.startsWith("--sample="))?.slice(9) ?? 0);
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { merge: Group[]; queue: Group[] };
  const pick = <T,>(list: T[]): T[] => (sample ? list.filter((_, index) => index % Math.max(1, Math.floor(list.length / sample)) === 0).slice(0, sample) : list);
  const merges = pick(plan.merge);
  const queue = pick(plan.queue);
  let runId: number | null = null;
  let lines: string[];
  let stats: Record<string, number>;
  try {
    const done = await withOperatorRun({ name: "merge_entities", operator: "brian", note: NOTE, params: { kind: "person", plan: PLAN, groups: merges.length } }, async (context) => {
      const out: string[] = [];
      const count: Record<string, number> = { grupos: 0, fusionadas: 0, renombradas: 0, fallidos: 0, avisos: 0 };
      for (const group of merges) {
        await context.client.query("SAVEPOINT grupo");
        try {
          let merged = 0;
          for (const drop of group.drops) {
            const preview = await previewEntityMerge(context.client, "person", group.keep, drop, { lock: true });
            await mergeEntities(context, {
              kind: "person", keepId: group.keep, dropId: drop, previewHash: preview.previewHash,
              keepDropNameAsAlias: preview.drop.name !== preview.keep.name, rewriteLater: true,
            });
            merged += 1;
          }
          if (group.name !== group.keepName) {
            await updateEntity(context, "person", group.keep, { name: group.name });
            count["renombradas"]! += 1;
          }
          await context.client.query("RELEASE SAVEPOINT grupo");
          count["grupos"]! += 1;
          count["fusionadas"]! += merged;
          out.push(`- ${group.keep} «${group.name}» ← ${group.drops.join(", ")} (${group.names.join(" · ")})`);
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT grupo");
          count["fallidos"]! += 1;
          out.push(`- FALLÓ ${group.keep} «${group.keepName}» ← ${group.drops.join(", ")}: ${(error as Error).message.slice(0, 160)}`);
        }
      }
      for (const group of queue) {
        for (const drop of group.drops) {
          const inserted = await context.client.query(`
            INSERT INTO ingest.review_queue(kind, priority, person_a_id, person_b_id, payload, notes)
            SELECT 'person_duplicate', 5, $1, $2, $3::jsonb, $4
             WHERE NOT EXISTS (SELECT 1 FROM ingest.review_queue q WHERE q.kind='person_duplicate' AND q.status IN ('open','in_progress')
                                 AND LEAST(q.person_a_id,q.person_b_id)=LEAST($1::bigint,$2::bigint) AND GREATEST(q.person_a_id,q.person_b_id)=GREATEST($1::bigint,$2::bigint))`,
          [group.keep, drop, JSON.stringify({ source: "barrido 2026-10-04", names: group.names, reason: "mismo nombre de una palabra o con iniciales y proyecto común" }),
            `[run ${context.runId}] ${NOTE}: nombre de una palabra o con iniciales, decide la Mesa`]);
          count["avisos"]! += inserted.rowCount ?? 0;
        }
      }
      if (!confirm) throw new DryRun(out, count);
      return { out, count };
    });
    runId = done.runId;
    lines = done.result.out;
    stats = done.result.count;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    lines = error.lines;
    stats = error.stats;
  }
  const mode = confirm ? "confirm" : "dry-run";
  const file = `reports/personas-duplicadas-2026-10-04-${mode}${sample ? `-muestra${sample}` : ""}${runId ? `-run${runId}` : ""}.md`;
  const summary = Object.entries(stats).map(([key, value]) => `${key} ${value}`).join(" · ");
  writeFileSync(file, [`# Personas duplicadas (${mode}${runId ? `, run ${runId}` : ""})`, "", NOTE, "", summary, "", ...lines, ""].join("\n"));
  console.log(`${summary} → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
