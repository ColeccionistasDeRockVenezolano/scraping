// RYM «nuevos» · corrección de los cruces por PREFIJO de título (Brian 2026-10-06: «deshacer los 330 y
// rehacer exacto»). Lee prefijos-plan.json (plan-revertir-prefijos.py) y, por disco del catálogo, quita lo
// que las tandas de RYM le pusieron desde una edición casada por prefijo:
//   * pistas de completar-discos cuyo tracklist no es el de ninguna edición exacta → deleteEntity;
//   * año de completar-discos (runs 16901/17809) que no da ninguna edición exacta → valor anterior del diario;
//   * portada localizada cuyo origen (manifest) es una edición por prefijo → valor anterior del diario;
//   * géneros de RYM (runs 16902/17123/17810) si el disco no tiene edición exacta → fila fuera + recálculo;
//   * candidatas de imagen abiertas con la portada de una edición por prefijo → rechazadas.
// Los claims de lo revertido pasan a «superseded». Un run reversible por lote (--batch=40 discos).
// Luego: plan-discos.py (ya solo exacto) rehace pistas/año/portada/géneros y manda las ediciones a altas.
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/revertir-prefijos.mts [--confirm]
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { deleteEntity, withOperatorRun } from "../../src/merge/operator.js";
import { syncEntityGenres } from "../../src/genres/store.js";

interface Edicion { url: string; titulo: string; anio: number | null; portada: string | null; pistas: string[] }
interface Disco { albumId: number; titulo: string; exactas: Edicion[]; prefijo: Edicion[] }

const DIR = "reports/rym-nuevos-aplicacion-2026-10-05";
const MANIFEST = "web/public/media/manifest.json";
const confirm = process.argv.includes("--confirm");
const LOTE = Number(process.argv.find((a) => a.startsWith("--batch="))?.slice(8) ?? 40);
const plan = JSON.parse(readFileSync(`${DIR}/prefijos-plan.json`, "utf8")) as Disco[];
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { entries: Record<string, { sourceUrl?: string; localPath?: string }> };
const note = "RYM «nuevos» 2026-10-06: el dato vino de una edición de RYM casada por prefijo de título (otro disco: remix, demo, volumen, parte…); se deshace y se rehace con cruce exacto";
const pool = getPool();

// Runs de las tandas (del diario): pistas de completar-discos, años, géneros y portadas.
const runsDe = async (sql: string) => (await pool.query<{ run_id: string }>(sql)).rows.map((r) => Number(r.run_id));
const RUNS_PISTAS = await runsDe(`SELECT DISTINCT run_id FROM ingest.change_journal WHERE table_name='public.tracks' AND op='I' AND run_id BETWEEN 16876 AND 17808`);
const RUNS_ANIO = [16901, 17809];
const RUNS_GENERO = [16902, 17123, 17810];
const RUNS_PORTADA = await runsDe(`SELECT DISTINCT run_id FROM ingest.claims WHERE field='cover_url' AND run_id BETWEEN 16904 AND 17815`);

const mismaLista = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
const informe = { discos: 0, pistas: 0, anios: 0, portadas: 0, generos: 0, candidatas: 0, detalle: [] as unknown[], errores: [] as unknown[] };
const manifestFuera: string[] = [];

async function revertirCampo(client: import("pg").PoolClient, albumId: number, field: string, runs: number[], acepta: (v: unknown) => boolean) {
  const claims = (await client.query<{ id: string; run_id: string; v: unknown }>(`
    SELECT id::text, run_id::text, normalized_value AS v FROM ingest.claims
     WHERE album_id=$1 AND field=$2 AND status='accepted' AND run_id = ANY($3::bigint[])`, [albumId, field, runs])).rows;
  let n = 0;
  for (const c of claims) {
    if (acepta(c.v)) continue;
    const j = (await client.query<{ old: unknown; nuevo: unknown }>(`
      SELECT old_data->$3 AS old, new_data->$3 AS nuevo FROM ingest.change_journal
       WHERE table_name='public.albums' AND op='U' AND (row_pk->>'id')::bigint=$1 AND run_id=$2
         AND new_data->$3 IS DISTINCT FROM old_data->$3 ORDER BY id LIMIT 1`, [albumId, Number(c.run_id), field])).rows[0];
    if (j) {
      // Solo si nadie lo cambió después: el valor actual sigue siendo el que puso la tanda.
      await client.query(`UPDATE public.albums a SET ${field}=r.${field}
        FROM jsonb_populate_record(NULL::public.albums, jsonb_build_object($3::text, $2::jsonb)) r
       WHERE a.id=$1 AND to_jsonb(a.${field}) IS NOT DISTINCT FROM $4::jsonb`, [albumId, JSON.stringify(j.old), field, JSON.stringify(j.nuevo)]);
    }
    await client.query(`UPDATE ingest.claims SET status='superseded', updated_at=now(), notes=concat_ws(' · ', notes, $2::text) WHERE id=$1`,
      [Number(c.id), note]);
    n++;
  }
  return n;
}

const lotes: Disco[][] = [];
for (let i = 0; i < plan.length; i += LOTE) lotes.push(plan.slice(i, i + LOTE));
for (const [n, lote] of lotes.entries()) {
  try {
    await withOperatorRun({
      name: `claude-code:revertir-prefijos lote ${n + 1}/${lotes.length}`, operator: "claude-code (delegado por Brian)", note,
      params: { albums: lote.map((d) => d.albumId) },
    }, async (context) => {
      const client = context.client;
      for (const d of lote) {
        await client.query("SAVEPOINT d");
        try {
          const fila = { albumId: d.albumId, titulo: d.titulo, pistas: 0, anio: 0, portada: 0, generos: 0, candidatas: 0 };
          // pistas
          const tr = (await client.query<{ id: string; title: string; nueva: boolean }>(`
            SELECT t.id::text, t.title, EXISTS (SELECT 1 FROM ingest.change_journal j WHERE j.table_name='public.tracks' AND j.op='I'
                     AND (j.row_pk->>'id')::bigint=t.id AND j.run_id = ANY($2::bigint[])) AS nueva
              FROM public.tracks t WHERE t.album_id=$1 ORDER BY t.disc_number, t.track_number`, [d.albumId, RUNS_PISTAS])).rows;
          const nuevas = tr.filter((t) => t.nueva);
          if (nuevas.length && !d.exactas.some((e) => mismaLista(e.pistas, nuevas.map((t) => t.title)))) {
            for (const t of nuevas) await deleteEntity(context, "track", Number(t.id));
            fila.pistas = nuevas.length;
          }
          // año
          const aniosExactos = new Set(d.exactas.map((e) => e.anio).filter((a) => a !== null));
          fila.anio = await revertirCampo(client, d.albumId, "release_year", RUNS_ANIO, (v) => aniosExactos.has(Number(v)));
          // portada: manda el origen del manifest
          const origen = manifest.entries[`album:${d.albumId}`]?.sourceUrl ?? null;
          const portadasExactas = new Set(d.exactas.map((e) => e.portada));
          const portadasPrefijo = new Set(d.prefijo.map((e) => e.portada).filter((p) => p && !portadasExactas.has(p)));
          if (origen && portadasPrefijo.has(origen)) {
            fila.portada = await revertirCampo(client, d.albumId, "cover_url", RUNS_PORTADA, () => false);
            if (fila.portada) manifestFuera.push(`album:${d.albumId}`);
          }
          // géneros: solo si no hay edición exacta (sin ella, todo lo de RYM vino de otro disco)
          if (!d.exactas.length) {
            const g = await client.query(`
              DELETE FROM ingest.album_genres g WHERE g.album_id=$1 AND g.decided_by='auto:rateyourmusic'
                 AND g.id IN (SELECT (j.row_pk->>'id')::bigint FROM ingest.change_journal j
                               WHERE j.table_name='ingest.album_genres' AND j.op='I' AND j.run_id = ANY($2::bigint[]))`, [d.albumId, RUNS_GENERO]);
            fila.generos = g.rowCount ?? 0;
            if (fila.generos) await syncEntityGenres(client, "album", d.albumId, { runId: context.runId });
          }
          // candidatas de imagen con la portada de la otra edición
          const c = await client.query(`
            UPDATE ingest.image_candidates SET status='rejected', decided_by='claude-code (delegado por Brian)', decided_at=now(), decision_run_id=$3
             WHERE entity_kind='album' AND album_id=$1 AND status='open' AND candidate_url = ANY($2::text[])`,
          [d.albumId, [...portadasPrefijo], context.runId]);
          fila.candidatas = c.rowCount ?? 0;
          await client.query("RELEASE SAVEPOINT d");
          informe.discos++; informe.pistas += fila.pistas; informe.anios += fila.anio; informe.portadas += fila.portada;
          informe.generos += fila.generos; informe.candidatas += fila.candidatas;
          informe.detalle.push({ ...fila, runId: context.runId });
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT d");
          informe.errores.push({ albumId: d.albumId, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        }
      }
      if (!confirm) throw new Error("__ensayo__");
    });
  } catch (error) {
    if (!(error instanceof Error && error.message === "__ensayo__")) throw error;
  }
}
if (confirm && manifestFuera.length) {
  for (const key of manifestFuera) {
    const e = manifest.entries[key];
    if (e?.localPath) { try { unlinkSync(`web/public/${e.localPath}`); } catch { /* ya no estaba */ } }
    delete manifest.entries[key];
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}
writeFileSync(`${DIR}/revertir-prefijos-${confirm ? "aplicado" : "ensayo"}.json`, JSON.stringify(informe, null, 1));
const { detalle, ...resumen } = informe;
console.log(JSON.stringify({ modo: confirm ? "aplicado" : "ensayo (revertido)", ...resumen, errores: informe.errores.length, ejemplos: informe.errores.slice(0, 3) }));
await closeDb();
