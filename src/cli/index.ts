// CRV · CLI (ARCHITECTURE.md §4.13). Se invoca vía `tsx` (ver package.json:
// scripts "cli"/"doctor"/"db:migrate"), no como binario ejecutable directo.
// Mismos casos de uso que la futura API,
// sin UI. Comandos se añaden fase a fase; los no implementados todavía
// devuelven un mensaje explícito en vez de fallar en silencio.
import { runDoctor } from "../doctor/index.js";
import { migrateUp, migrateDownAll } from "../db/migrate.js";
import { closeDb } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("cli");

const KNOWN_FUTURE_COMMANDS = new Set([
  "sources:list", "sources:add", "scrape", "seed:import-yt", "yt:sync",
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
