// CRV · `crv genres external …` (PLAN_GENEROS etapa 4).
//
// Todo lo que decide una persona pasa por aquí y exige `--by` y `--reason`:
// cargar las fichas de evaluación, autorizar una fuente, habilitar su
// importación, medir la muestra, habilitar el volumen, importar y retirar.
// Lo que escribe en el catálogo va en seco por omisión (`--confirm` aplica).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "../db/client.js";
import type { GenreEntityKind } from "../genres/rules.js";
import { runAccept, type AcceptReport } from "../genres/external/accept.js";
import { runExternalImport, type ImportReport, type ImportScope } from "../genres/external/import.js";
import { renderImportMarkdown } from "../genres/external/report.js";
import { DEFAULT_SHEETS_FILE, loadSheetsFile } from "../genres/external/sheets.js";
import {
  ExternalSourceError, listExternalSources, purgeSuggestions, recordPrecision, requireExternalSource,
  setExternalAuthorization, upsertExternalSource, type ExternalSourceRow,
} from "../genres/external/store.js";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const positional = (args: string[]) => args.filter((arg) => !arg.startsWith("--"));

function context(args: string[]): { actor: string; reason: string } | undefined {
  const actor = option(args, "by")?.trim();
  const reason = (option(args, "reason") ?? option(args, "note"))?.trim();
  return actor && reason ? { actor, reason } : undefined;
}

function idList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const ids = value.split(",").map((part) => Number(part.trim())).filter((id) => Number.isSafeInteger(id) && id > 0);
  return ids.length ? ids : undefined;
}

function parseLevel(value: string | undefined): GenreEntityKind | undefined {
  return value === "album" || value === "artist" ? value : undefined;
}

function describeSource(source: ExternalSourceRow): string {
  const flags = [
    source.status,
    source.importEnabled ? "importa" : "sin importar",
    source.bulkEnabled ? "volumen" : "sin volumen",
  ].join(" · ");
  const precision = source.precisionMeasured === null
    ? "sin medir"
    : `${(source.precisionMeasured * 100).toFixed(1)} % sobre ${source.sampleSize} fichas (umbral ${(source.precisionThreshold * 100).toFixed(0)} %)`;
  return `  ${source.slug.padEnd(14)} ${flags}\n`
    + `    ${source.name} · ${source.levels} · ${source.license}\n`
    + `    precisión: ${precision}\n`
    + `    acceso: ${source.accessNote}\n`
    + `    atribución: ${source.attribution}`;
}

async function withClient<T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function writeReport(report: ImportReport, source: ExternalSourceRow): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true });
  const base = path.join(REPORTS_DIR, `genres-external-${report.sourceSlug}-${report.level}-${report.scope}-${report.mode}`);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${base}.md`, renderImportMarkdown(report, source));
  return `${path.relative(process.cwd(), base)}.{json,md}`;
}

function printImport(report: ImportReport): void {
  console.log(`genres external ${report.scope} (${report.mode}, run ${report.runId}): ${report.candidates} fichas de ${report.sourceSlug} (${report.level})`);
  console.log(`  identidad: ${report.identities.matched} resueltas · ${report.identities.ambiguous} dudosas · ${report.identities.none} sin candidato`);
  console.log(`  acuerdo: ${report.agreement.agree} exacto · ${report.agreement.family_agree} de familia · ${report.agreement.disagree} discrepa`
    + ` · precisión ${report.precision === null ? "—" : `${(report.precision * 100).toFixed(1)} %`}`);
  console.log(`  sugerencias: +${report.suggestions.inserted} (${report.suggestions.skipped} ya estaban) · cobertura nueva ${report.coverageAdded} · casos ${report.cases.opened}`);
  console.log(`  red: ${report.network.requests} peticiones · ${report.network.cacheHits} de caché${report.errors.length ? ` · ${report.errors.length} errores` : ""}`);
}

function printAccept(report: AcceptReport): void {
  console.log(`genres external accept (${report.mode}, run ${report.runId}): ${report.candidates} fichas de ${report.sourceSlug}`
    + ` (${report.level}) con propuestas vivas`);
  console.log(`  confirmados: ${report.primaries} principales · ${report.secondariesConfirmed} secundarios`);
  if (report.skipped.length) console.log(`  saltados: ${report.skipped.length} (ver detalle)`);
  for (const entity of report.accepted.slice(0, 15)) {
    console.log(`    ${report.level} ${entity.entityId} · ${entity.title}: ${entity.primary}`
      + `${entity.secondaries.length ? ` (+${entity.secondaries.join(", ")})` : ""}`);
  }
  if (report.accepted.length > 15) console.log(`    … y ${report.accepted.length - 15} fichas más`);
  for (const skip of report.skipped.slice(0, 10)) {
    console.log(`    saltado ${skip.entityId} · ${skip.title}: ${skip.reason}`);
  }
}

/** Cambios de autorización: siempre en seco salvo `--confirm`. */
async function authorization(
  args: string[], slug: string | undefined, change: Parameters<typeof setExternalAuthorization>[2], usage: string,
): Promise<number> {
  const ctx = context(args);
  if (!slug || !ctx) {
    console.error(`uso: ${usage} --by=<quién> --reason="<por qué>" [--confirm]`);
    return 1;
  }
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const source = await setExternalAuthorization(client, slug, change, ctx);
      console.log(`genres external: ${slug}`);
      console.log(describeSource(source));
      await client.query(args.includes("--confirm") ? "COMMIT" : "ROLLBACK");
      if (!args.includes("--confirm")) console.log("  (dry-run: nada se guardó; repite con --confirm)");
      return 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function runGenresExternalCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  const slug = option(args, "source") ?? positional(args)[1];
  try {
    switch (subcommand) {
      case "sources": {
        return withClient(async (client) => {
          const sources = await listExternalSources(client);
          if (!sources.length) {
            console.log("genres external: no hay fichas cargadas (`crv genres external sheets --confirm`)");
            return 0;
          }
          console.log(`genres external: ${sources.length} fichas`);
          for (const source of sources) console.log(describeSource(source));
          return 0;
        });
      }

      case "sheets": {
        const ctx = context(args);
        if (!ctx) {
          console.error('uso: crv genres external sheets [--file=<json>] --by=<quién> --reason="<por qué>" [--confirm]');
          return 1;
        }
        const file = option(args, "file") ?? DEFAULT_SHEETS_FILE;
        const sheets = await loadSheetsFile(file);
        return withClient(async (client) => {
          await client.query("BEGIN");
          try {
            for (const sheet of sheets) {
              const saved = await upsertExternalSource(client, sheet, ctx);
              console.log(describeSource(saved));
            }
            console.log(`genres external: ${sheets.length} fichas de ${path.relative(process.cwd(), file)}`);
            console.log("  cargar una ficha no autoriza nada: usa `authorize` y `enable` para eso.");
            await client.query(args.includes("--confirm") ? "COMMIT" : "ROLLBACK");
            if (!args.includes("--confirm")) console.log("  (dry-run: nada se guardó; repite con --confirm)");
            return 0;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        });
      }

      case "authorize":
        return authorization(args, slug, { status: "authorized" }, "crv genres external authorize <slug>");
      case "block":
        return authorization(args, slug, { status: "blocked", importEnabled: false, bulkEnabled: false },
          "crv genres external block <slug>");
      case "enable":
        return authorization(args, slug, { importEnabled: true }, "crv genres external enable <slug>");
      case "bulk-enable":
        return authorization(args, slug, { bulkEnabled: true }, "crv genres external bulk-enable <slug>");
      case "bulk-disable":
        return authorization(args, slug, { bulkEnabled: false }, "crv genres external bulk-disable <slug>");

      case "disable": {
        // Apagar la importación y, si se pide, retirar sus propuestas sin
        // resolver. Lo que decidió una persona no se toca (PLAN etapa 4).
        const ctx = context(args);
        if (!slug || !ctx) {
          console.error('uso: crv genres external disable <slug> [--purge] --by=<quién> --reason="<por qué>" [--confirm]');
          return 1;
        }
        return withClient(async (client) => {
          await client.query("BEGIN");
          try {
            const source = await setExternalAuthorization(client, slug, { importEnabled: false, bulkEnabled: false }, ctx);
            if (args.includes("--purge")) {
              const purged = await purgeSuggestions(client, source.id);
              console.log(`genres external: ${slug} retirado · sugerencias sin resolver borradas: ${purged.album} de discos, ${purged.artist} de artistas · ${purged.cases} casos cerrados`);
              console.log("  las decisiones humanas (confirmadas o rechazadas) se conservan intactas.");
            } else {
              console.log(`genres external: ${slug} deja de importar; sus sugerencias siguen en la cola (usa --purge para retirarlas)`);
            }
            await client.query(args.includes("--confirm") ? "COMMIT" : "ROLLBACK");
            if (!args.includes("--confirm")) console.log("  (dry-run: nada se guardó; repite con --confirm)");
            return 0;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        });
      }

      case "accept": {
        const ctx = context(args);
        const level = parseLevel(option(args, "level")) ?? "album";
        if (!slug || !ctx) {
          console.error("uso: crv genres external accept --source=<slug> [--level=album|artist] [--limit=N] [--ids=1,2]"
            + " [--secondaries=confirm|leave] --by=<quién> --reason=\"<por qué>\" [--confirm]");
          return 1;
        }
        const limitOption = Number(option(args, "limit"));
        const report = await runAccept({
          sourceSlug: slug, level, confirm: args.includes("--confirm"),
          actor: ctx.actor, reason: ctx.reason,
          secondaries: option(args, "secondaries") === "confirm" ? "confirm" : "leave",
          ...(Number.isSafeInteger(limitOption) && limitOption > 0 ? { limit: limitOption } : {}),
          ...(idList(option(args, "ids")) ? { entityIds: idList(option(args, "ids"))! } : {}),
        });
        printAccept(report);
        if (!args.includes("--confirm")) console.log("  (dry-run: nada se escribió; repite con --confirm)");
        return 0;
      }

      case "sample":
      case "import": {
        const ctx = context(args);
        const level = parseLevel(option(args, "level"));
        if (!slug || !ctx || !level) {
          console.error(`uso: crv genres external ${subcommand} --source=<slug> --level=album|artist [--limit=N]`
            + `${subcommand === "import" ? " [--ids=1,2,3]" : ""} --by=<quién> --reason="<por qué>" [--confirm]`);
          return 1;
        }
        const ids = idList(option(args, "ids"));
        const scope: ImportScope = subcommand === "sample" ? "sample" : ids ? "targets" : "pending";
        const limitOption = Number(option(args, "limit"));
        const report = await runExternalImport({
          sourceSlug: slug, level, scope, confirm: args.includes("--confirm"),
          actor: ctx.actor, reason: ctx.reason,
          ...(Number.isSafeInteger(limitOption) && limitOption > 0 ? { limit: limitOption } : {}),
          ...(ids ? { entityIds: ids } : {}),
          ...(args.includes("--offline") ? { offline: true } : {}),
        });
        const source = await withClient((client) => requireExternalSource(client, slug));
        printImport(report);
        console.log(`  reporte: ${await writeReport(report, source)}`);

        if (scope === "sample" && args.includes("--confirm")) {
          if (report.precision === null) {
            console.error("  la muestra no tiene nada comparable: no se guarda precisión (elige fichas con principal confirmado)");
            return 1;
          }
          const measured = await withClient((client) => recordPrecision(client, slug, {
            precision: report.precision!,
            sampleSize: report.agreement.agree + report.agreement.family_agree + report.agreement.disagree,
            report: `run ${report.runId} · ${ctx.actor}: ${ctx.reason}`,
          }));
          console.log(`  precisión guardada en la ficha: ${(report.precision * 100).toFixed(1)} % sobre ${measured.sampleSize} fichas`);
          console.log(report.precision >= measured.precisionThreshold
            ? "  alcanza el umbral: `crv genres external bulk-enable` ya es posible."
            : "  no alcanza el umbral: la carga masiva sigue cerrada.");
        } else if (!args.includes("--confirm")) {
          console.log("  (dry-run: nada se escribió; repite con --confirm)");
        }
        return 0;
      }

      default:
        console.error(`subcomando de genres external desconocido: "${subcommand ?? ""}"`);
        console.error("  sources | sheets | authorize | block | enable | disable | sample | bulk-enable | bulk-disable | import | accept");
        return 1;
    }
  } catch (error) {
    if (error instanceof ExternalSourceError) {
      console.error(`genres external: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
