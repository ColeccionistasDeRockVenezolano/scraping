// Etapa 4 «Altas» — alta de alias del careo de homónimos (paquete de confirmación).
//
// Cada alias confirmado entra por el camino de la web: withOperatorRun +
// createAlias (un run por alias → deshacer quirúrgico con `runs undo`).
//
// Uso (dry-run por defecto; --confirm escribe):
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/cerrar-alias-homonimos.mts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../../src/db/client.js";
import { withOperatorRun } from "../../src/merge/operator.js";
import { createAlias } from "../../src/api/repositories/aliases.js";
import { normalizeEntityName } from "../../src/normalization/entity-name.js";

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const TSV = "reports/etapa4-altas-2026-10-03/careo-homonimos.tsv";
const SALIDA = "reports/etapa4-altas-2026-10-03/aplicacion-alias-homonimos.json";
const OPERATOR = "hermes-curaduria";

const KIND: Record<string, "artist" | "person"> = { artista: "artist", persona: "person" };
const ALIAS_TYPE: Record<string, string> = {
  "Rafael Mussett": "misspelling", "Carlos Huertas": "misspelling", "Fredy Reyna": "misspelling",
  "Neblinna": "misspelling", "Acero Plastiko": "misspelling", "Aloisio": "misspelling",
  "Francisco Tejera": "name_variant", "Miguel A. Ferrer": "name_variant", "La Banda Casablanca": "name_variant",
};

interface Row { rym_name: string; cat_tipo: string; cat_id: string; cat_nombre: string; propuesta: string; }

function loadRows(): Row[] {
  const [head = "", ...lines] = readFileSync(TSV, "utf8").trim().split("\n");
  const cols = head.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [cols[i], v])) as unknown as Row);
}

async function planAlias(client: PoolClient, kind: "artist" | "person", id: number, alias: string): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const clean = alias.trim();
  if (!clean) return { ok: false, motivo: "alias vacío" };
  const tabla = kind === "artist" ? "artists" : "persons";
  const tablaAl = kind === "artist" ? "ingest.artist_aliases" : "ingest.person_aliases";
  const col = kind === "artist" ? "artist_id" : "person_id";
  const name = (await client.query<{ name: string }>(`SELECT name FROM public.${tabla} WHERE id=$1`, [id])).rows[0]?.name;
  if (name === undefined) return { ok: false, motivo: `no existe ${tabla} ${id}` };
  const key = normalizeEntityName(clean).primaryKey;
  if (normalizeEntityName(name).primaryKey === key) return { ok: false, motivo: `«${clean}» ya es el nombre canónico` };
  const present = await client.query(`SELECT 1 FROM ${tablaAl} WHERE ${col}=$1 AND (alias=$2 OR normalized_alias=$3)`, [id, clean, key]);
  if (present.rowCount) return { ok: false, motivo: "alias ya presente en la ficha" };
  if (kind === "artist") {
    const taken = await client.query<{ id: string; name: string }>(`
      SELECT a.id::text AS id, a.name FROM public.artists a WHERE a.id<>$1 AND lower(a.name)=lower($2)
      UNION SELECT a.id::text AS id, a.name FROM ingest.artist_aliases al JOIN public.artists a ON a.id=al.artist_id
       WHERE al.artist_id<>$1 AND lower(al.alias)=lower($2) LIMIT 1`, [id, clean]);
    if (taken.rowCount) return { ok: false, motivo: `el nombre ya es de ${taken.rows[0]!.name} (${taken.rows[0]!.id})` };
  }
  return { ok: true };
}

const filas = loadRows().filter((r) => r.propuesta === "alias");
if (!filas.length) throw new Error("el TSV no trae alias confirmados (¿se regeneró el paquete?)");
console.log(`alias confirmados: ${filas.length}`);

const pool = getPool();
const plan: Array<{ f: Row; kind: "artist" | "person"; id: number }> = [];
for (const f of filas) {
  const kind = KIND[f.cat_tipo];
  const id = Number(f.cat_id);
  if (!kind || !Number.isInteger(id)) { console.log(`AVISO: ${f.rym_name} sin tipo/id (${f.cat_tipo}/${f.cat_id}) — se omite`); continue; }
  const check = await planAlias(pool as unknown as PoolClient, kind, id, f.rym_name);
  if (!check.ok) { console.log(`AVISO: «${f.rym_name}» → omite (${check.motivo})`); continue; }
  plan.push({ f, kind, id });
}

if (!confirm) {
  for (const p of plan) console.log(`[dry-run] alias «${p.f.rym_name}» (${ALIAS_TYPE[p.f.rym_name] ?? "name_variant"}) → ${p.kind} ${p.id} «${p.f.cat_nombre}»`);
  console.log(`[dry-run] ${plan.length} alias listos; nada escrito.`);
  await closeDb();
  process.exit(0);
}

const resultados: Array<Record<string, unknown>> = [];
for (const p of plan) {
  const aliasType = ALIAS_TYPE[p.f.rym_name] ?? "name_variant";
  try {
    const { runId, result } = await withOperatorRun({
      name: `hermes:etapa4-alias «${p.f.rym_name}»`,
      operator: OPERATOR,
      note: `Alias del paquete de homónimos de la etapa 4: «${p.f.rym_name}» → ${p.kind} ${p.id} («${p.f.cat_nombre}»), con el OK de Brian del 2026-10-04.`,
    }, async (context) => {
      const check = await planAlias(context.client, p.kind, p.id, p.f.rym_name);
      if (!check.ok) throw new Error(check.motivo);
      return createAlias(context, p.kind, p.id, { alias: p.f.rym_name.trim(), aliasType, isPrimary: false });
    });
    resultados.push({ alias: p.f.rym_name, kind: p.kind, entityId: p.id, aliasType, estado: "aplicado", runId, aliasId: result.id });
    console.log(`alias «${p.f.rym_name}» → ${p.kind} ${p.id}: aplicado (run ${runId}, alias ${result.id})`);
  } catch (error) {
    resultados.push({ alias: p.f.rym_name, kind: p.kind, entityId: p.id, estado: "omitido", motivo: (error as Error).message });
    console.log(`alias «${p.f.rym_name}»: OMITIDO — ${(error as Error).message}`);
  }
}

writeFileSync(SALIDA, JSON.stringify({ fecha: new Date().toISOString(), resultados }, null, 2));
console.log(`salida: ${SALIDA}`);
await closeDb();
