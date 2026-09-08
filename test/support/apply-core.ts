// CRV · Aplica crv_simple_v1.sql (verbatim) contra un contenedor PG vía
// `docker exec -i ... psql -f -`. Compartido por los tests de contrato que
// necesitan el core como precondición antes de migrar.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

export async function applyCore(containerName: string): Promise<void> {
  const sql = await readFile(path.join(ROOT, "crv_simple_v1.sql"), "utf8");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-q", "-f", "-",
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql -f - salió con código ${code}:\n${stderr}`));
    });
    child.stdin.end(sql);
  });
}
