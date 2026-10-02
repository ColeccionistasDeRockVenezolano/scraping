// Promoción masiva de Sincopa al core, por sección (src/review/bulk-promotion.ts).
//
//   tsx scripts/promote-sincopa.ts --section=jazz                 # ensayo: plan y listas, no escribe
//   tsx scripts/promote-sincopa.ts --section=jazz --confirm --note="…"
//   opciones: --kinds=artist,album  --limit=50  --out=reports/…json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { closeDb } from "../src/db/client.js";
import { PROMOTION_SECTIONS, promoteSection, type PromotionKind, type PromotionSection } from "../src/review/bulk-promotion.js";

function flag(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  const section = flag("section") as PromotionSection | undefined;
  if (section === undefined || !PROMOTION_SECTIONS.includes(section)) {
    throw new Error(`--section obligatorio, una de: ${PROMOTION_SECTIONS.join(", ")}`);
  }
  const confirm = process.argv.includes("--confirm");
  const note = flag("note") ?? `Sincopa ${section}: promoción masiva por reglas`;
  const kinds = flag("kinds")?.split(",") as PromotionKind[] | undefined;
  const limit = flag("limit") === undefined ? undefined : Number(flag("limit"));
  const report = await promoteSection({
    section, note, confirm,
    ...(kinds === undefined ? {} : { kinds }),
    ...(limit === undefined ? {} : { limitPerKind: limit }),
  });
  const out = flag("out") ?? `reports/promocion-sincopa-${section}-${confirm ? `run${report.runId}` : "ensayo"}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const brief = {
    section: report.section, dryRun: report.dryRun, runId: report.runId, out,
    kinds: report.kinds, holds: report.holds.length, duplicateFlags: report.duplicateFlags.length, errors: report.errors.length,
  };
  console.log(JSON.stringify(brief, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
