// CRV · Etapa 4 del nuevo lote: los sellos que el motor mandó a revisión
// (run 11621; 292 discos, 80 nombres). Decisiones de Brian del 2026-10-03:
//
//   · mismo sello escrito distinto → alias de la ficha existente;
//   · filiales de las grandes («Sony Music | Latin», «Warner Music México»…)
//     → la casa madre (alias en la casa madre);
//   · el resto → sello nuevo (`record_label`), creado a sabiendas aunque el ER
//     viera parecidos (el candidato era otro sello);
//   · «Independiente» y «The Dog House studios» (un estudio) → sin sello.
//
// Todo en UN run de operador: alias, altas, label_id de los discos SIN sello
// (nunca pisa) y cierre de los avisos organization_match del run 11621.
// Sin --confirm corre entero y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-sellos-revision.ts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { createAlias } from "../src/api/repositories/aliases.js";
import { closeDb } from "../src/db/client.js";
import { compareKey } from "../src/ingest/lote-investigacion.js";
import { createEntity, updateEntity, withOperatorRun } from "../src/merge/operator.js";

const REPORT = "reports/nuevo-lote-2026-10-02/etapa4-sellos-confirm-run11621.json";
const REVIEW_RUN = 11621;
const NOTE = "Etapa 4 del nuevo lote: sellos en revisión resueltos por Brian el 2026-10-03 (filiales → casa madre)";

// Nombre del lote → organización existente.
const SAME: Record<string, number> = {
  "ObesoPacanins": 1826, "Zapato3": 2551, "LAD Records": 2030, "Interamerica de Grabaciones, S.A.": 1476,
  "CNR Discos Venezuela": 1898, "Sunnyside Communications": 1865, "Sway Music": 2607, "Mundo Digital": 2550,
  "Sony": 396, "Palacio": 1171, "Palacio Rodven": 1562, "Velvet Rodven": 6, "Atlantic Records": 2646, "Ariola": 2230,
};
const PARENT: Record<string, number> = {
  "Sony Music | Latin": 396, "Sony Latin": 396, "Sony Music México": 396, "Columbia": 396,
  "Universal Music Latino": 322, "Universal Latino": 322, "Universal Music Group": 322, "Universal Music México": 322, "Universal Music Spain, S.L.U.": 322,
  "Warner Music México": 2074, "Warner Music Spain": 2074, "Warner Music Latina": 2074, "WEA Latina": 2074, "WEA Latina, Inc.": 2074,
  "Capitol Latin": 154, "Rimas Entertainment México S.A. de C.V": 2546,
};
const NO_LABEL = new Set(["Independiente", "The Dog House studios"]);

interface Skipped { albumId: number; artist: string; title: string; detail: string }
interface Row { name: string; action: string; orgId: number | null; albums: number; filled: number; kept: number }
class DryRun extends Error {
  constructor(readonly rows: Row[], readonly reviews: number) { super("dry-run"); }
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const skipped = (JSON.parse(readFileSync(REPORT, "utf8")) as { skipped: Skipped[] }).skipped;
  const byName = new Map<string, Skipped[]>();
  for (const row of skipped) {
    const name = /^«([^»]*)»/u.exec(row.detail)![1]!;
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  let runId: number | null = null;
  let rows: Row[];
  let reviews: number;
  try {
    const done = await withOperatorRun({ name: "label_review", operator: "brian", note: NOTE, params: { lote: "nuevo-lote-2026-10-02", etapa: 4, reviewRun: REVIEW_RUN } },
      async (context) => {
        const list: Row[] = [];
        const orgOf = new Map<string, number | null>();
        for (const [name, albums] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          let orgId: number | null = null;
          let action: string;
          const target = SAME[name] ?? PARENT[name];
          if (NO_LABEL.has(name)) {
            action = "sin sello";
          } else if (target !== undefined) {
            orgId = target;
            action = SAME[name] !== undefined ? "alias (mismo sello)" : "alias en la casa madre";
            const has = await context.client.query(
              `SELECT 1 FROM public.organizations WHERE id=$1 AND name=$2
               UNION ALL SELECT 1 FROM ingest.organization_aliases WHERE organization_id=$1 AND alias=$2`, [orgId, name]);
            if (!has.rowCount) await createAlias(context, "organization", orgId, { alias: name, aliasType: "name_variant", isPrimary: false });
          } else {
            const created = await createEntity(context, "organization", { name, organization_type: "record_label" }, { allowSimilar: true });
            orgId = created.id;
            action = "sello nuevo";
          }
          orgOf.set(compareKey(name), orgId);
          let filled = 0;
          let kept = 0;
          if (orgId !== null) {
            for (const album of albums) {
              const current = await context.client.query<{ label_id: string | null }>("SELECT label_id::text FROM public.albums WHERE id=$1", [album.albumId]);
              if (current.rows[0]?.label_id) { kept += 1; continue; }
              await updateEntity(context, "album", album.albumId, { label_id: orgId });
              filled += 1;
            }
          }
          list.push({ name, action, orgId, albums: albums.length, filled, kept });
        }
        // Avisos organization_match que abrió el run 11621.
        const queue = await context.client.query<{ id: string; label: string; candidate: string | null }>(`
          SELECT q.id::text, c.raw_value #>> '{}' AS label, q.organization_a_id::text AS candidate
            FROM ingest.review_queue q JOIN ingest.claims c ON c.id=q.claim_a_id
           WHERE q.status='open' AND q.kind='organization_match' AND c.run_id=$1`, [REVIEW_RUN]);
        for (const item of queue.rows) {
          const orgId = orgOf.get(compareKey(item.label));
          const same = orgId !== undefined && orgId !== null && String(orgId) === item.candidate;
          const what = orgId === undefined ? "sin decisión" : orgId === null ? "sin sello" : same ? `es el candidato ${orgId}` : `va a la organización ${orgId}, no al candidato`;
          await context.client.query(
            `UPDATE ingest.review_queue SET status=$2::ingest.review_status, resolved_at=now(), resolved_by='human', updated_at=now(), resolution_note=$3 WHERE id=$1`,
            [item.id, same ? "approved" : "dismissed", `[run ${context.runId}] ${NOTE}: «${item.label}» ${what}`]);
        }
        if (!confirm) throw new DryRun(list, queue.rowCount ?? 0);
        return { list, reviews: queue.rowCount ?? 0 };
      });
    runId = done.runId;
    rows = done.result.list;
    reviews = done.result.reviews;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    rows = error.rows;
    reviews = error.reviews;
  }
  const mode = confirm ? "confirm" : "dry-run";
  const sum = (key: "albums" | "filled" | "kept") => rows.reduce((total, row) => total + row[key], 0);
  const count = (action: string) => rows.filter((row) => row.action === action).length;
  const lines = [
    `# Etapa 4 — sellos en revisión resueltos (${mode}${runId ? `, run ${runId}` : ""})`, "",
    `${rows.length} nombres · ${sum("albums")} discos · ${sum("filled")} con sello nuevo · ${sum("kept")} ya tenían sello · ${reviews} avisos cerrados`, "",
    `Alias del mismo sello: ${count("alias (mismo sello)")} · casa madre: ${count("alias en la casa madre")} · sellos nuevos: ${count("sello nuevo")} · sin sello: ${count("sin sello")}`, "",
    "| Sello del lote | Decisión | Organización | Discos | Rellenados |", "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.name.replaceAll("|", "\\|")} | ${row.action} | ${row.orgId ?? "—"} | ${row.albums} | ${row.filled} |`), "",
  ];
  const file = `reports/nuevo-lote-2026-10-02/etapa4-sellos-revision-${mode}${runId ? `-run${runId}` : ""}.md`;
  writeFileSync(file, lines.join("\n"));
  console.log(`${lines[2]}\n${lines[4]} → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
