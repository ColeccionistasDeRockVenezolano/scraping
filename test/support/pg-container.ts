// CRV · Contenedor PostgreSQL desechable para tests de integración/contrato.
// Puerto TS de la lógica de tests/lib_pg.sh (arranque en dos fases de la
// imagen oficial: servidor temporal solo-socket -> apagado -> definitivo).
// Ver ese archivo para la evidencia empírica de tiempos.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PG_IMAGE = process.env["PG_IMAGE"] ?? "postgres:16-alpine";
// Por debajo del hookTimeout de vitest (180 s): si el arranque se pasa, queremos
// el error claro de waitForPg («no aceptó conexiones en 100 s»), no un
// «Hook timed out» que además deja `container` sin asignar.
const WAIT_TIMEOUT_MS = Number(process.env["PG_WAIT_TIMEOUT_MS"] ?? 100_000);

export interface PgContainer {
  name: string;
  port: number;
  databaseUrl: string;
  stop: () => Promise<void>;
}

async function sh(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args);
}

async function isRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await sh("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function pgReady(name: string): Promise<boolean> {
  try {
    await sh("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-q"]);
    await sh("docker", ["exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-tAq", "-c", "SELECT 1"]);
    return true;
  } catch {
    return false;
  }
}

async function waitForPg(name: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let streak = 0;
  while (Date.now() < deadline) {
    if (!(await isRunning(name))) {
      const { stdout } = await sh("docker", ["logs", "--tail", "30", name]).catch(() => ({ stdout: "" }));
      throw new Error(`el contenedor ${name} dejó de correr durante el arranque:\n${stdout}`);
    }
    if (await pgReady(name)) {
      streak += 1;
      if (streak >= 2) return;
    } else {
      streak = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`PostgreSQL no aceptó conexiones TCP en ${WAIT_TIMEOUT_MS}ms (${name})`);
}

let counter = 0;

async function runContainer(name: string, port: number): Promise<void> {
  await sh("docker", [
    "run", "-d", "--name", name,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p", `${port}:5432`,
    PG_IMAGE,
  ]);
}

/** Levanta un PostgreSQL desechable con el puerto expuesto en el host. */
export async function startPgContainer(): Promise<PgContainer> {
  counter += 1;
  const name = `crv-pg-vitest-${process.pid}-${counter}`;

  await sh("docker", ["rm", "-f", name]).catch(() => undefined);
  // El puerto sale de un rango al azar: si otro proceso (otra suite corriendo a
  // la vez, un contenedor huérfano) ya lo tiene, `docker run` muere con «port is
  // already allocated» y el archivo entero fallaba por eso (visto en CI y en
  // local el 2026-09-18). Reintentar con otro puerto, no fallar la prueba.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 55400 + (Math.floor(Math.random() * 400) + counter + attempt);
    try {
      await runContainer(name, port);
      await waitForPg(name);
      return {
        name,
        port,
        databaseUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
        stop: async () => {
          await sh("docker", ["rm", "-f", name]).catch(() => undefined);
        },
      };
    } catch (error: unknown) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      await sh("docker", ["rm", "-f", name]).catch(() => undefined);
      if (!/already allocated|address already in use/iu.test(message)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`no se pudo arrancar ${name}: ${String(lastError)}`);
}
