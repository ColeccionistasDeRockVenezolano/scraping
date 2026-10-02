// CRV · `crv genres …` (PLAN_GENEROS etapa 2): taxonomía, backfill, cambios
// de vocabulario y decisiones humanas. Todo lo que escribe exige --by y
// --reason (o --note) y, salvo las decisiones puntuales, --confirm; sin él se
// ejecuta entero dentro de una transacción que se deshace y se imprime el
// reporte antes/después.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "../db/client.js";
import {
  applyTaxonomyOperations, DEFAULT_TAXONOMY_FILE, planTaxonomyFile,
  type TaxonomyChangeReport, type TaxonomyOperation,
} from "../genres/admin.js";
import { renderBackfillMarkdown, runGenreBackfill } from "../genres/backfill.js";
import { runDeriveArtistGenres } from "../genres/derived.js";
import { decideGenre } from "../genres/curation.js";
import { runGenresExternalCommand } from "./genres-external.js";
import type { GenreEntityKind } from "../genres/rules.js";
import { loadTaxonomy } from "../genres/store.js";
import { resolveGenreValue } from "../genres/taxonomy.js";

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

function printTaxonomyReport(report: TaxonomyChangeReport): void {
  const byOp = new Map<string, number>();
  for (const op of report.operations) byOp.set(op.op, (byOp.get(op.op) ?? 0) + 1);
  console.log(`genres taxonomía (${report.mode}, run ${report.runId}): ${report.operations.length} operaciones`
    + ` · ${[...byOp].map(([op, n]) => `${n} ${op}`).join(" · ") || "sin cambios"}`);
  console.log(`  afectados: ${report.affected.artist} artistas · ${report.affected.album} álbumes · ${report.changes.length} con cambios · ${report.humanNotices} avisos a decisiones humanas`);
  for (const change of report.changes.slice(0, 20)) {
    const show = (rows: typeof change.before.rows) => rows.map((row) => `${row.genre}:${row.status}${row.role === "primary" ? "*" : ""}`).join(", ") || "—";
    console.log(`  ${change.kind} ${change.entityId}: ${show(change.before.rows)} → ${show(change.after.rows)}`);
  }
  if (report.changes.length > 20) console.log(`  … y ${report.changes.length - 20} más`);
  if (report.mode === "dry-run") console.log("  (dry-run: nada se escribió; repite con --confirm)");
}

async function taxonomy(args: string[], operations: () => Promise<TaxonomyOperation[]>, usage: string): Promise<number> {
  const ctx = context(args);
  if (!ctx) {
    console.error(`uso: ${usage} --by=<quién> --reason="<por qué>" [--confirm]`);
    return 1;
  }
  const report = await applyTaxonomyOperations(await operations(), ctx, { confirm: args.includes("--confirm") });
  printTaxonomyReport(report);
  await mkdir(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `genres-taxonomy-${report.mode}.json`);
  await writeFile(file, `${JSON.stringify({ ...ctx, ...report }, null, 2)}\n`);
  console.log(`  reporte antes/después: ${path.relative(process.cwd(), file)}`);
  return 0;
}

function parseKind(value: string | undefined): GenreEntityKind | undefined {
  return value === "album" || value === "artist" ? value : undefined;
}

async function human(args: string[], action: "confirm_primary" | "add_secondary" | "reject" | "revert", usage: string): Promise<number> {
  const [, kindArg, idArg, slug] = positional(args);
  const kind = parseKind(kindArg);
  const entityId = Number(idArg);
  const ctx = context(args);
  if (!kind || !Number.isSafeInteger(entityId) || entityId <= 0 || !slug || !ctx) {
    console.error(`uso: ${usage}`);
    return 1;
  }
  // El mismo camino que la Mesa: un run propio, diario de cambios y historial.
  const result = await decideGenre({ action, kind, entityId, genreSlug: slug, actor: ctx.actor, reason: ctx.reason, closeCases: false });
  const projection = result.albumGenre;
  console.log(`genres: ${kind} ${entityId} · ${slug} · ${action} (run ${result.runId})`
    + (projection ? ` · albums.genre ${JSON.stringify(projection.before)} → ${JSON.stringify(projection.after)}${projection.changed ? "" : " (sin escribir)"}` : ""));
  return 0;
}

export async function runGenresCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  switch (subcommand) {
    // Fuentes externas (etapa 4): fichas, autorización, muestra e importación.
    case "external":
      return runGenresExternalCommand(args.slice(1));
    case "taxonomy-apply": {
      const file = option(args, "file") ?? DEFAULT_TAXONOMY_FILE;
      return taxonomy(args, () => planTaxonomyFile(file, { prune: args.includes("--prune") }),
        "crv genres taxonomy-apply [--file=<taxonomy.json>] [--prune]");
    }
    case "alias-set": {
      const [, alias, target] = positional(args);
      if (!alias || !target) {
        console.error('uso: crv genres alias-set "<texto>" <slug|not_a_genre> --by=… --reason=… [--confirm]');
        return 1;
      }
      return taxonomy(args, async () => [{ op: "set_alias", alias, target, notes: option(args, "notes") ?? null }], "crv genres alias-set");
    }
    case "alias-remove": {
      const [, alias] = positional(args);
      if (!alias) {
        console.error('uso: crv genres alias-remove "<texto>" --by=… --reason=… [--confirm]');
        return 1;
      }
      return taxonomy(args, async () => [{ op: "remove_alias", alias }], "crv genres alias-remove");
    }
    case "rename": {
      const [, slug, name] = positional(args);
      if (!slug || !name) {
        console.error('uso: crv genres rename <slug> "<nombre nuevo>" --by=… --reason=… [--confirm]  (el slug no cambia)');
        return 1;
      }
      return taxonomy(args, async () => [{ op: "rename_genre", slug, name }], "crv genres rename");
    }
    case "deactivate": {
      const [, slug] = positional(args);
      const replacementSlug = option(args, "replacement");
      if (!slug || !replacementSlug) {
        console.error("uso: crv genres deactivate <slug> --replacement=<slug> --by=… --reason=… [--confirm]");
        return 1;
      }
      return taxonomy(args, async () => [{ op: "deactivate_genre", slug, replacementSlug }], "crv genres deactivate");
    }
    case "backfill": {
      const level = option(args, "level");
      if (level !== undefined && !parseKind(level)) {
        console.error("uso: crv genres backfill [--level=artist|album] [--by=<quién>] [--confirm]");
        return 1;
      }
      const confirm = args.includes("--confirm");
      const report = await runGenreBackfill({
        confirm, actor: option(args, "by") ?? "cli", ...(level ? { levels: [level as GenreEntityKind] } : {}),
      });
      await mkdir(REPORTS_DIR, { recursive: true });
      const base = path.join(REPORTS_DIR, `genres-backfill-${report.mode}`);
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(`${base}.md`, renderBackfillMarkdown(report));
      const b = report.before.albums;
      const a = report.after.albums;
      console.log(`genres backfill (${report.mode}, run ${report.runId}): ${report.processed.artist} artistas · ${report.processed.album} álbumes`);
      console.log(`  filas: +${report.writes.inserted} ~${report.writes.updated} -${report.writes.deleted} · avisos +${report.writes.reviewsOpened} -${report.writes.reviewsClosed}`);
      console.log(`  álbumes con principal confirmado: ${b.withConfirmedPrimary} → ${a.withConfirmedPrimary} · albums.genre no nulo: ${b.genreNotNull} → ${a.genreNotNull}`
        + `${report.projectionEnabled ? "" : " (proyección apagada: albums.genre no se toca)"}`);
      console.log(`  reporte: ${path.relative(process.cwd(), base)}.{json,md}`);
      if (!confirm) console.log("  (dry-run: todo se deshizo; repite con --confirm)");
      return 0;
    }
    case "derive-artists": {
      // Reconciliación completa de 0036 (la regla ya corre sola en cada cambio).
      const confirm = args.includes("--confirm");
      const report = await runDeriveArtistGenres({ confirm, actor: option(args, "by") ?? "cli" });
      console.log(`genres derive-artists (${report.mode}, run ${report.runId}): ${report.artistsChanged} artistas · ${report.rowsChanged} filas cambian`);
      console.log(`  filas de sus discos: ${report.before.rows} → ${report.after.rows} (principales ${report.before.primaries} → ${report.after.primaries})`
        + ` · artistas sin género: ${report.before.artistsWithoutGenre} → ${report.after.artistsWithoutGenre}`);
      if (!confirm) console.log("  (dry-run: todo se deshizo; repite con --confirm)");
      return 0;
    }
    case "resolve": {
      const [, value] = positional(args);
      if (!value) {
        console.error('uso: crv genres resolve "<valor de la fuente>"');
        return 1;
      }
      const client = await getPool().connect();
      try {
        const tax = await loadTaxonomy(client);
        const resolution = resolveGenreValue(tax, value);
        const names = new Map([...tax.genres.values()].map((genre) => [genre.id, genre]));
        console.log(`«${resolution.raw}» → normalizado «${resolution.normalized}»${resolution.isList ? " (lista)" : ""}`);
        for (const item of resolution.items) {
          if (item.kind === "genre") {
            const genre = names.get(item.genreId)!;
            console.log(`  ✓ ${item.fragment} → ${genre.name} [${genre.slug}, ${genre.level}] vía ${item.via}`);
          } else {
            console.log(`  ? ${item.fragment} → sin resolver${resolution.hyphenCompound ? " (compuesto con guion: a revisión)" : ""}`);
          }
        }
        for (const fragment of resolution.notAGenre) console.log(`  · ${fragment} → no es género`);
        return 0;
      } finally {
        client.release();
      }
    }
    case "confirm": {
      const role = option(args, "role") ?? "primary";
      if (role !== "primary" && role !== "secondary") {
        console.error("--role debe ser primary o secondary");
        return 1;
      }
      return human(args, role === "primary" ? "confirm_primary" : "add_secondary",
        "crv genres confirm <album|artist> <id> <slug> [--role=primary|secondary] --by=<quién> --reason=\"<por qué>\"");
    }
    case "reject":
      return human(args, "reject", "crv genres reject <album|artist> <id> <slug> --by=<quién> --reason=\"<por qué>\"");
    case "revert":
      return human(args, "revert", "crv genres revert <album|artist> <id> <slug> --by=<quién> --reason=\"<por qué>\"");
    default:
      console.error(`subcomando de genres desconocido: "${subcommand ?? ""}"`);
      console.error("  taxonomy-apply | backfill | derive-artists | resolve | alias-set | alias-remove | rename | deactivate | confirm | reject | revert | external");
      return 1;
  }
}
