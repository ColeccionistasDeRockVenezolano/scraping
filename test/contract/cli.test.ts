import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";

// Auditoría de pruebas #4 — El CLI (838 líneas, ~20 subcomandos) es la
// interfaz operativa real del sistema y no tenía una sola prueba. Aquí corre
// DE VERDAD, como proceso hijo contra un PostgreSQL desechable: los caminos
// que no tocan datos (ayuda, avisos de comandos, doctor, listados y los
// `--dry-run`) no pueden volver a romperse en silencio.
interface CliRun { code: number; stdout: string; stderr: string; }

describe("CLI (contrato de humo)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  function cli(...args: string[]): Promise<CliRun> {
    return new Promise((resolve, reject) => {
      const child = spawn("./scripts/with-node22.sh", ["node_modules/.bin/tsx", "src/cli/index.ts", ...args], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`el CLI no terminó: crv ${args.join(" ")}`)); }, 60_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  it("help lista los comandos reales, incluido er:prune", async () => {
    const run = await cli("help");
    expect(run.code).toBe(0);
    for (const line of ["doctor", "db:migrate [down]", "curation scan [--dry-run]", "er:prune", "ambiguity:resolve"]) {
      expect(run.stdout).toContain(line);
    }
  });

  it("un comando desconocido sale con error y muestra la ayuda", async () => {
    const run = await cli("comando-que-no-existe");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('comando desconocido: "comando-que-no-existe"');
    expect(run.stdout).toContain("CRV CLI");
  });

  it("los nombres viejos y los futuros se explican en vez de fallar en silencio", async () => {
    const renamed = await cli("yt:sync");
    expect(renamed.code).toBe(1);
    expect(renamed.stderr).toContain('"yt:sync" se implementó como: crv youtube sync [--pending]');

    const future = await cli("genre:add");
    expect(future.code).toBe(1);
    expect(future.stderr).toContain('"genre:add" está especificado en ARCHITECTURE.md §4');
  });

  it("doctor corre contra la base migrada y no reporta fallos", async () => {
    const run = await cli("doctor");
    expect(run.stdout).toContain("migrations.applied");
    expect(run.stdout).toContain("0022_er_decisions_retention");
    expect(run.stdout).not.toContain("HAY PROBLEMAS");
    expect(run.code).toBe(0);
  });

  it("los listados y resúmenes responden con la base vacía", async () => {
    const sources = await cli("sources:list");
    expect(sources.code).toBe(0);
    expect(sources.stdout).toContain("fuentes registradas");

    const runs = await cli("runs", "list");
    expect(runs.code).toBe(0);

    const summary = await cli("curation", "summary");
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain("último análisis: ninguno");
  });

  it("los --dry-run no escriben: er:prune y curation scan informan y salen en 0", async () => {
    const prune = await cli("er:prune", "--dry-run");
    expect(prune.code).toBe(0);
    expect(prune.stdout).toContain("er:prune --dry-run: 0 decisiones pendientes de compactar");
    expect(prune.stdout).toContain("nada se escribió");

    const scan = await cli("curation", "scan", "--dry-run");
    expect(scan.code).toBe(0);
    expect(scan.stdout).toContain("(dry-run: nada se escribió)");
  });
});
