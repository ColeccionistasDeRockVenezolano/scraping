// CRV · Sonda de la búsqueda de personas contra la base de desarrollo (E11.9).
// SOLO LECTURA: usa el mismo repositorio que la ruta GET /persons (índice en
// memoria + SQL), sin levantar la API ni escribir nada.
//
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/persons-search-probe.mts [q]
//
// Imprime el tiempo de la primera llamada (que incluye cargar el índice) y de
// las siguientes, con el mismo criterio del plan: < 300 ms.
import { closeDb } from "../../src/db/client.js";
import { getEnv } from "../../src/config/env.js";
import { listPersons } from "../../src/api/repositories/persons.js";
import { searchIndexSize, warmSearchIndex } from "../../src/api/search-index.js";

const LIMIT_MS = 300;
const q = process.argv[2] ?? "jose";
const target = new URL(getEnv().DATABASE_URL);

// La carga del índice es un coste de arranque (la API lo calienta en segundo
// plano, E11.9); lo que se mide para el criterio del plan es la consulta.
const coldStart = performance.now();
await warmSearchIndex();
const coldMs = performance.now() - coldStart;

const times: number[] = [];
let total = 0;
for (let run = 0; run < 3; run += 1) {
  const started = performance.now();
  const { rows, total: count } = await listPersons({ q, limit: 50, offset: 0, sort: "name" });
  times.push(performance.now() - started);
  total = count;
  if (run === 0) console.log(`  coincidencias: ${count}; primeras: ${rows.slice(0, 5).map((row) => row.name).join(" | ")}`);
}
await closeDb();

console.log(`búsqueda de personas (solo lectura)`);
console.log(`  base: ${target.hostname}:${target.port}${target.pathname}`);
console.log(`  q=«${q}» · coincidencias: ${total}`);
console.log(`  carga del índice (una vez, en el arranque, índices cargados: ${searchIndexSize()}): ${coldMs.toFixed(0)} ms`);
console.log(`  consultas: ${times.map((time) => `${time.toFixed(0)} ms`).join(", ")}`);
const worst = Math.max(...times);
const ok = worst < LIMIT_MS;
console.log(`RESULTADO: ${ok ? "OK" : `LENTA (${worst.toFixed(0)} ms ≥ ${LIMIT_MS} ms)`} (peor tiempo ${worst.toFixed(0)} ms)`);
if (!ok) process.exitCode = 1;
