// Aplicación de RYM «nuevos» · etapa 1 — completa los discos que YA existen con lo capturado en
// RYM, solo en sus vacíos (decisión de Brian 2026-10-05: «completar + altas»):
//
//   * pistas — solo discos que siguen sin ninguna pista; posición y duración de la ficha RYM;
//   * año    — solo discos sin año.
//
// Géneros y portadas van por sus aplicadores de siempre (mismo ensayo/confirmación):
//   géneros  → scripts/apply-source-genres.ts --ledger=reports/rym-nuevos-aplicacion-2026-10-05/completar-generos.jsonl
//   portadas → npm run media:localize -- --candidates reports/rym-nuevos-aplicacion-2026-10-05/completar-portadas.jsonl
//
// Entrada: completar-pistas.jsonl y completar-anios.jsonl de plan-discos.py (re-ejecutarlo tras
// las altas para que los discos recién creados entren aquí). Un run reversible por lote
// (--batch=150 discos); sin --confirm cada lote corre dentro de su transacción y se deshace.
//
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/completar-discos.mts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { OperatorError, createEntity, updateEntity, withOperatorRun } from "../../src/merge/operator.js";

// `--dir=` reutiliza el completador con otro plan del mismo formato (p. ej. la etapa 4 de fuentes web).
const DIR = process.argv.find((a) => a.startsWith("--dir="))?.slice(6) ?? "reports/rym-nuevos-aplicacion-2026-10-05";
const confirm = process.argv.includes("--confirm");

interface Pistas { albumId: number; title: string; url: string; tracks: Array<{ disc: number; position: number; title: string; duration: number | null }> }
interface Anio { albumId: number; title: string; year: number; url: string; note: string }

const jsonl = <T,>(name: string): T[] => readFileSync(`${DIR}/${name}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
class Ensayo extends Error { constructor(readonly resumen: Record<string, number>) { super("ensayo"); } }

const pistas = jsonl<Pistas>("completar-pistas.jsonl");
const anios = jsonl<Anio>("completar-anios.jsonl");
const pool = getPool();
const sinPistas = new Set((await pool.query<{ id: string }>(
  "SELECT a.id::text FROM public.albums a WHERE NOT EXISTS (SELECT 1 FROM public.tracks t WHERE t.album_id=a.id)")).rows.map((r) => Number(r.id)));
const sinAnio = new Set((await pool.query<{ id: string }>(
  "SELECT id::text FROM public.albums WHERE release_year IS NULL")).rows.map((r) => Number(r.id)));
const planP = pistas.filter((p) => sinPistas.has(p.albumId));
const planA = anios.filter((a) => sinAnio.has(a.albumId));

const resumen: Record<string, number> = { discos_con_pistas: 0, pistas: 0, pistas_error: 0, años: 0, años_error: 0 };
const errores: Array<{ albumId: number; error: string }> = [];
// Por lotes: una sola transacción con miles de savepoints agota max_locks_per_transaction
// (visto 2026-10-05 con 3.671 discos). Cada lote es su propio run reversible.
const LOTE = Number(process.argv.find((a) => a.startsWith("--batch="))?.slice(8) ?? 150);
const runIds: number[] = [];
const lotes: Array<{ p: Pistas[]; a: Anio[] }> = [];
for (let i = 0; i < planP.length; i += LOTE) lotes.push({ p: planP.slice(i, i + LOTE), a: [] });
if (planA.length) lotes.push({ p: [], a: planA });
for (const [n, lote] of lotes.entries()) {
  try {
    const out = await withOperatorRun({
      name: `claude-code:completar-discos (${DIR.split("/").pop()}) lote ${n + 1}/${lotes.length}`, operator: "claude-code (delegado por Brian)",
      note: `Pistas y año de discos que no los tenían, desde ${DIR} (fuente citada por fila); decisión «completar + altas» de Brian 2026-10-05.`,
      params: { albums: [...new Set([...lote.p.map((p) => p.albumId), ...lote.a.map((a) => a.albumId)])] },
    }, async (context) => {
      for (const disco of lote.p) {
        await context.client.query("SAVEPOINT d");
        try {
          for (const t of disco.tracks) {
            await createEntity(context, "track", {
              title: t.title, disc_number: t.disc, track_number: t.position,
              ...(t.duration ? { duration_seconds: t.duration } : {}),
            }, { albumId: disco.albumId, allowSimilar: true });
            resumen["pistas"]!++;
          }
          resumen["discos_con_pistas"]!++;
          await context.client.query("RELEASE SAVEPOINT d");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT d");
          resumen["pistas_error"]!++;
          errores.push({ albumId: disco.albumId, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        }
      }
      for (const a of lote.a) {
        await context.client.query("SAVEPOINT y");
        try {
          await updateEntity(context, "album", a.albumId, { release_year: a.year });
          resumen["años"]!++;
          await context.client.query("RELEASE SAVEPOINT y");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT y");
          resumen["años_error"]!++;
          errores.push({ albumId: a.albumId, error: error instanceof OperatorError ? error.message : String(error) });
        }
      }
      if (!confirm) throw new Ensayo(resumen);
      return resumen;
    });
    runIds.push(out.runId);
    console.log(`lote ${n + 1}/${lotes.length}: run ${out.runId} · pistas ${resumen["pistas"]}`);
  } catch (error) {
    if (!(error instanceof Ensayo)) throw error;
  }
}
const runId = runIds.length ? `${runIds[0]}-${runIds[runIds.length - 1]}` : null;

const informe = { modo: confirm ? "aplicado" : "ensayo (revertido)", runId, entrada: { pistas: pistas.length, anios: anios.length },
  vigentes: { pistas: planP.length, anios: planA.length }, ...resumen, errores };
writeFileSync(`${DIR}/completar-discos-${confirm ? `run${runId}` : "ensayo"}.json`, JSON.stringify(informe, null, 2));
console.log(JSON.stringify({ ...informe, errores: errores.slice(0, 5) }, null, 2));
await closeDb();
