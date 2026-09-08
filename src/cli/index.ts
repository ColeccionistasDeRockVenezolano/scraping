// CRV · CLI (ARCHITECTURE.md §4.13). Se invoca vía `tsx` (ver package.json:
// scripts "cli"/"doctor"/"db:migrate"), no como binario ejecutable directo.
// Mismos casos de uso que la futura API,
// sin UI. Comandos se añaden fase a fase; los no implementados todavía
// devuelven un mensaje explícito en vez de fallar en silencio.
import { runDoctor } from "../doctor/index.js";
import { migrateUp, migrateDownAll } from "../db/migrate.js";
import { closeDb } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { seedSources, listSources, proposeSource, LINKS_XLSX_PATH } from "../ingest/sources.js";
import { runObserve } from "../fetcher/observe.js";

const log = moduleLogger("cli");

const KNOWN_SITE_TYPES = ["blogspot", "wordpress", "website", "database", "instagram", "spreadsheet", "youtube_api"] as const;

const KNOWN_FUTURE_COMMANDS = new Set([
  "seed:import-yt", "yt:sync",
  "yt:link", "yt:enrich", "merge:run", "review:list", "review:approve",
  "review:dismiss", "genre:add", "genre:disable", "export:json",
]);

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "doctor": {
      const report = await runDoctor();
      for (const check of report.checks) {
        const mark = check.ok ? "✓" : "✗";
        // eslint-disable-next-line no-console
        console.log(`  ${mark} ${check.name}: ${check.detail}`);
      }
      // eslint-disable-next-line no-console
      console.log(report.ok ? "doctor: TODO VERDE" : "doctor: HAY PROBLEMAS");
      return report.ok ? 0 : 1;
    }

    case "db:migrate": {
      const mode = args[0] === "down" ? "down" : "up";
      const result = mode === "down" ? await migrateDownAll() : await migrateUp();
      log.info(result, mode === "down" ? "rollback completo" : "migración completa");
      return 0;
    }

    case "sources:seed": {
      const result = await seedSources(LINKS_XLSX_PATH);
      // eslint-disable-next-line no-console
      console.log(`ingest.sources: ${result.inserted} insertadas, ${result.updated} actualizadas`);
      return 0;
    }

    case "sources:list": {
      const rows = await listSources();
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(`  [${r.enabled ? "✓" : "✗"}] ${r.slug.padEnd(32)} ${r.siteType.padEnd(10)} trust=${r.trustLevel}`);
      }
      // eslint-disable-next-line no-console
      console.log(`${rows.length} fuentes registradas`);
      return 0;
    }

    case "sources:add": {
      const [name, url, siteType, ...justificationParts] = args;
      if (!name || !url || !siteType || justificationParts.length === 0) {
        // eslint-disable-next-line no-console
        console.error(`uso: sources:add "<nombre>" <url> <site_type> <justificación...>\n  site_type ∈ ${KNOWN_SITE_TYPES.join(", ")}`);
        return 1;
      }
      if (!(KNOWN_SITE_TYPES as readonly string[]).includes(siteType)) {
        // eslint-disable-next-line no-console
        console.error(`site_type inválido: "${siteType}". Debe ser uno de: ${KNOWN_SITE_TYPES.join(", ")}`);
        return 1;
      }
      const result = await proposeSource({
        name, url, siteType: siteType as (typeof KNOWN_SITE_TYPES)[number],
        justification: justificationParts.join(" "),
      });
      // eslint-disable-next-line no-console
      console.log(
        `Fuente propuesta con enabled=false (source id ${result.sourceId}). ` +
        `Ítem de revisión creado (review id ${result.reviewId}, kind=new_source). ` +
        "Requiere aprobación manual antes de habilitarla (SOURCES.md §6).",
      );
      return 0;
    }

    case "scrape": {
      const slug = args[0];
      const observe = args.includes("--observe");
      if (!slug) {
        // eslint-disable-next-line no-console
        console.error('uso: scrape <slug> --observe   (solo modo observación implementado: descarga + almacenamiento crudo, sin extracción)');
        return 1;
      }
      if (!observe) {
        // eslint-disable-next-line no-console
        console.log("solo --observe está implementado en esta fase (F1); la extracción llega en F4.");
        return 1;
      }
      const result = await runObserve(slug);
      // eslint-disable-next-line no-console
      console.log(`scrape --observe ${slug}: ${result.fetched} descargadas, ${result.cached} desde caché, ${result.errors} errores`);
      return result.errors > 0 ? 1 : 0;
    }

    case undefined:
    case "help":
    case "--help":
      printHelp();
      return 0;

    default:
      if (KNOWN_FUTURE_COMMANDS.has(cmd)) {
        // eslint-disable-next-line no-console
        console.log(`"${cmd}" está especificado en ARCHITECTURE.md §4 pero aún no implementado (ver PHASES.md).`);
        return 1;
      }
      // eslint-disable-next-line no-console
      console.error(`comando desconocido: "${cmd}"`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
CRV CLI

  doctor              integridad: core (hash+catálogo), schemas aux, migraciones, fuentes
  db:migrate [down]   aplica migrations/*.up.sql pendientes (o revierte todo con "down")
  sources:seed        siembra las 11 fuentes del XLSX + YouTube Data API + 2 seeds internos
  sources:list        lista ingest.sources (slug, tipo, confianza, enabled)
  sources:add "<nombre>" <url> <site_type> <justificación>
                      propone una fuente NUEVA: enabled=false + review(new_source);
                      nunca la habilita directo (requiere aprobación manual, SOURCES.md §6)
  scrape <slug> --observe   descarga + cachea crudo de una fuente habilitada (sin extracción)

Comandos especificados para fases futuras (F1+): ${[...KNOWN_FUTURE_COMMANDS].join(", ")}
`);
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    log.error({ err }, "fallo en CLI");
    await closeDb();
    process.exitCode = 1;
  });
