// CRV · Sonda del clasificador de nombres de persona contra la base de
// desarrollo (E11.7). SOLO LECTURA: no escribe nada, ni siquiera en una
// transacción; el clasificador es puro.
//
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/person-junk-dryrun.mts
//
// Imprime el conteo por clase (organization_like, duration, fragment,
// multiple_people), la comparación esperada del plan y una muestra de cada
// clase para revisar a mano. Código de salida 1 si algún conteo se aleja más
// del 15 % de la cifra del plan (§1.2: ≈477 organization_like, 22 duration).
import { closeDb, getPool } from "../../src/db/client.js";
import { getEnv } from "../../src/config/env.js";
import { classifyPersonName, type PersonNameClass } from "../../src/review/person-junk.js";

const EXPECTED: Partial<Record<PersonNameClass, number>> = { organization_like: 477, duration: 22 };
const MAX_DRIFT = 0.15;

const target = new URL(getEnv().DATABASE_URL);
const { rows } = await getPool().query<{ id: string; name: string }>(
  "SELECT id::text, name FROM public.persons ORDER BY name");
await closeDb();

const counts = new Map<PersonNameClass, Array<{ id: number; name: string; reason: string }>>();
for (const row of rows) {
  const classification = classifyPersonName(row.name);
  const bucket = counts.get(classification.kind) ?? [];
  bucket.push({ id: Number(row.id), name: row.name, reason: classification.reason });
  counts.set(classification.kind, bucket);
}

console.log("clasificador de nombres de persona (solo lectura)");
console.log(`  base: ${target.hostname}:${target.port}${target.pathname}`);
console.log(`  personas: ${rows.length}`);
let failed = false;
for (const kind of ["ok", "organization_like", "duration", "fragment", "multiple_people"] as const) {
  const bucket = counts.get(kind) ?? [];
  const expected = EXPECTED[kind];
  const drift = expected === undefined ? undefined : (bucket.length - expected) / expected;
  const verdict = drift === undefined ? "" : ` (plan ${expected}${Math.abs(drift) > MAX_DRIFT ? `, DESVÍO ${(drift * 100).toFixed(0)} %` : ""})`;
  if (drift !== undefined && Math.abs(drift) > MAX_DRIFT) failed = true;
  console.log(`  ${kind}: ${bucket.length}${verdict}`);
  for (const item of bucket.slice(0, 8)) console.log(`      ${item.id} «${item.name}» — ${item.reason}`);
}
console.log(`RESULTADO: ${failed ? "DESVÍO" : "OK"}`);
if (failed) process.exitCode = 1;
