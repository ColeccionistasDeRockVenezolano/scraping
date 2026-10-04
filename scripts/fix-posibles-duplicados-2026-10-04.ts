// CRV · Bandeja «Posibles duplicados» de Curaduría (Brian, 2026-10-04,
// decisiones por preguntas sobre las 1.033 revisiones person_duplicate abiertas):
//
//   · mismo nombre + banda, disco o ≥2 colegas en común → fusión;
//   · mismo nombre completo sin proyecto común → fusión solo si el apellido es
//     poco común (≤10 fichas), el nombre tiene 3+ palabras o la bio de una
//     banda nombra a la otra; los de nombre común se cierran como distintas;
//   · nombre de una palabra o nombres que no coinciden, sin vínculo → distintas.
//
// Ficha principal: la que tiene bio y más vínculos; las demás variantes quedan
// como alias, las bios se unen (cola text_rewrites) y, si solo difieren en
// tildes, queda la grafía con tilde. La fusión cierra la revisión del par.
//
// Plan: reports/posibles-duplicados-2026-10-04-plan.json (evidencia en
// reports/posibles-duplicados-2026-10-04-evidencia.json). Cada grupo va en su
// SAVEPOINT. UN run de operador. Sin --confirm corre y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/fix-posibles-duplicados-2026-10-04.ts [--sample=40] [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const PLAN = "reports/posibles-duplicados-2026-10-04-plan.json";
const NOTE = "Posibles duplicados de Curaduría (Brian, 2026-10-04)";

interface Group { keep: number; keepName: string; drops: number[]; names: string[]; name: string }
class DryRun extends Error {
  constructor(readonly lines: string[], readonly stats: Record<string, number>) { super("dry-run"); }
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const sample = Number(process.argv.find((arg) => arg.startsWith("--sample="))?.slice(9) ?? 0);
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { merge: Group[]; dismiss: number[] };
  const pick = <T,>(list: T[]): T[] => (sample ? list.filter((_, index) => index % Math.max(1, Math.floor(list.length / sample)) === 0).slice(0, sample) : list);
  const merges = pick(plan.merge);
  const dismiss = sample ? [] : plan.dismiss;
  let runId: number | null = null;
  let lines: string[];
  let stats: Record<string, number>;
  try {
    const done = await withOperatorRun({ name: "merge_entities", operator: "brian", note: NOTE, params: { kind: "person", plan: PLAN, groups: merges.length } }, async (context) => {
      const out: string[] = [];
      const count: Record<string, number> = { grupos: 0, fusionadas: 0, renombradas: 0, fallidos: 0, distintas: 0, abiertasRestantes: 0 };
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
      // «Son distintas»: como rejectReview de la API, sin tocar el core; el
      // detector no vuelve a proponer el par.
      const closed = await context.client.query(`
        UPDATE ingest.review_queue
           SET status='dismissed', resolved_by='human', resolved_at=now(), updated_at=now(),
               resolution_note=$2
         WHERE id = ANY($1::bigint[]) AND status IN ('open','in_progress')`,
      [dismiss, `[run ${context.runId}] ${NOTE}: son distintas (sin proyecto común, nombre común o de una palabra)`]);
      count["distintas"] = closed.rowCount ?? 0;
      const left = await context.client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM ingest.review_queue WHERE kind::text='person_duplicate' AND status IN ('open','in_progress')");
      count["abiertasRestantes"] = Number(left.rows[0]?.n ?? 0);
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
  const file = `reports/posibles-duplicados-2026-10-04-${mode}${sample ? `-muestra${sample}` : ""}${runId ? `-run${runId}` : ""}.md`;
  const summary = Object.entries(stats).map(([key, value]) => `${key} ${value}`).join(" · ");
  writeFileSync(file, [`# Posibles duplicados (${mode}${runId ? `, run ${runId}` : ""})`, "", NOTE, "", summary, "", ...lines, ""].join("\n"));
  console.log(`${summary} → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
