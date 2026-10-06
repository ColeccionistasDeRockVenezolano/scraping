// Etapa 4 · remanente de las fuentes web del 2026-10-01 (MusicaVenezuela, Wikipedia) — aplicador.
//
//   --phase=discos     altas de los discos que faltan (altas-discos.jsonl) bajo su artista del
//                      catálogo; ER con la misma guarda de la etapa 1 web (needs_review con score
//                      < 0,66 → alta a sabiendas; si no, a la cola); claim + evidencia por campo.
//   --phase=formacion  año de formación de artistas que no lo tienen (formacion.jsonl, o el que
//                      se pase con --file=, p. ej. el de RYM «nuevos»).
//
// Pistas y años de disco van por scripts/rym-nuevos-aplicar/completar-discos.mts --dir=…;
// géneros por apply-source-genres.ts --ledger=…; fotos y portadas por media:localize --candidates.
// Sin --confirm corre entero en UNA transacción y la deshace (ensayo con los mismos números).
//
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/fuentes-web-aplicar/aplicar-remanente.mts --phase=discos [--confirm]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { OperatorError, createEntity, updateEntity, withOperatorRun, type OperatorContext } from "../../src/merge/operator.js";

const DIR = "reports/fuentes-web-remanente-2026-10-05";
const args = process.argv.slice(2);
const argVal = (n: string) => args.find((v) => v.startsWith(`--${n}=`))?.slice(n.length + 3);
const phase = argVal("phase") ?? "";
const confirm = args.includes("--confirm");
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const jsonl = <T,>(file: string): T[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
class Ensayo extends Error { constructor() { super("ensayo"); } }

interface Alta { artistId: number; artist: string; title: string; year: number | null; album_type: string; source: string; url: string; evidence: string }
interface Formacion { artistId: number; artist: string; year: number; source: string; url: string; note: string }

const TIPOS = new Set(["studio_album", "ep", "single", "compilation", "live_album", "demo", "soundtrack", "remix", "other"]);

async function claimWeb(context: OperatorContext, sourceId: number, kind: "album" | "artist", id: number, field: string,
  value: unknown, url: string, evidence: string, key: string): Promise<void> {
  const col = kind === "album" ? "album_id" : "artist_id";
  const claim = await context.client.query<{ id: string }>(`
    INSERT INTO ingest.claims(source_id,entity_kind,${col},field,raw_value,normalized_value,raw_hash,extractor,
                              extractor_version,confidence,status,created_by,run_id,notes,identity_key)
    VALUES($1,$2,$3,$4,$5::jsonb,$5::jsonb,$6,'captura-web-dirigida','2','medium','accepted','human',$7,$8,$9)
    ON CONFLICT DO NOTHING RETURNING id::text`,
  [sourceId, kind, id, field, JSON.stringify(value), sha([kind, key, field, value, url]), context.runId,
    `${field} según la captura web 2026-10-01 (remanente aplicado 2026-10-05): ${evidence}`.slice(0, 400), key]);
  const claimId = claim.rows[0]?.id;
  if (claimId) {
    await context.client.query(
      "INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING",
      [claimId, url, evidence.slice(0, 500), sha([url, evidence])]);
  }
}

async function main(): Promise<void> {
  if (!["discos", "formacion"].includes(phase)) throw new Error("--phase=discos|formacion");
  const pool = getPool();
  const fuentes = new Map((await pool.query<{ id: string; slug: string }>("SELECT id::text, slug FROM ingest.sources")).rows.map((r) => [r.slug, Number(r.id)]));
  const informe: Record<string, unknown[]> = { creadas: [], cola: [], ya_existe: [], errores: [], aplicadas: [], saltadas: [] };
  let runId: number | null = null;
  try {
    const out = await withOperatorRun({
      name: `claude-code:fuentes-web-remanente (${phase})`, operator: "claude-code (delegado por Brian)",
      note: `Remanente de la captura web 2026-10-01 (${phase}): solo lo que el catálogo aún no tiene; fuente y evidencia por campo. Brian 2026-10-05.`,
    }, async (context) => {
      if (phase === "discos") {
        for (const a of jsonl<Alta>(argVal("file") ?? `${DIR}/altas-discos.jsonl`)) {
          const values: Record<string, unknown> = { title: a.title, album_type: TIPOS.has(a.album_type) ? a.album_type : "other" };
          if (a.year) values["release_year"] = a.year;
          const sourceId = fuentes.get(a.source) ?? fuentes.get("wikipedia")!;
          const key = `web:${a.source}:album:${a.artistId}:${a.title}`;
          await context.client.query("SAVEPOINT alta");
          try {
            let id: number;
            try {
              id = (await createEntity(context, "album", values, { artistId: a.artistId })).id;
            } catch (error) {
              if (!(error instanceof OperatorError) || error.code !== "needs_review") throw error;
              const dec = await context.client.query<{ score: string | null }>(
                "SELECT score::text FROM ingest.entity_resolution_decisions WHERE entity_kind='ALBUM' AND input_name_original=$1 ORDER BY id DESC LIMIT 1", [a.title]);
              const score = Number(dec.rows[0]?.score ?? 1);
              if (score >= 0.66) throw Object.assign(error, { score });
              id = (await createEntity(context, "album", values, { artistId: a.artistId, allowSimilar: true })).id;
            }
            for (const [field, value] of Object.entries(values)) await claimWeb(context, sourceId, "album", id, field, value, a.url, a.evidence, key);
            informe["creadas"]!.push({ id, artistId: a.artistId, title: a.title, source: a.source });
            await context.client.query("RELEASE SAVEPOINT alta");
          } catch (error) {
            await context.client.query("ROLLBACK TO SAVEPOINT alta");
            const code = error instanceof OperatorError ? error.code : "";
            const fila = { artistId: a.artistId, artist: a.artist, title: a.title, source: a.source,
              detalle: error instanceof Error ? error.message.slice(0, 200) : String(error),
              ...(code === "already_exists" ? { existingId: (error as OperatorError).details?.["existingId"] } : {}) };
            informe[code === "needs_review" ? "cola" : code === "already_exists" ? "ya_existe" : "errores"]!.push(fila);
          }
        }
      } else {
        const sinAnio = new Set((await context.client.query<{ id: string }>("SELECT id::text FROM public.artists WHERE formed_year IS NULL")).rows.map((r) => Number(r.id)));
        for (const f of jsonl<Formacion>(argVal("file") ?? `${DIR}/formacion.jsonl`)) {
          if (!sinAnio.has(f.artistId)) { informe["saltadas"]!.push({ artistId: f.artistId, motivo: "ya tiene año" }); continue; }
          await context.client.query("SAVEPOINT f");
          try {
            await updateEntity(context, "artist", f.artistId, { formed_year: f.year });
            const sourceId = fuentes.get(f.source === "rym" ? "rateyourmusic" : f.source) ?? fuentes.get("wikipedia")!;
            await claimWeb(context, sourceId, "artist", f.artistId, "formed_year", f.year, f.url, f.note, `web:${f.source}:formed_year:${f.artistId}`);
            informe["aplicadas"]!.push({ artistId: f.artistId, artist: f.artist, year: f.year });
            await context.client.query("RELEASE SAVEPOINT f");
          } catch (error) {
            await context.client.query("ROLLBACK TO SAVEPOINT f");
            informe["errores"]!.push({ artistId: f.artistId, detalle: error instanceof Error ? error.message.slice(0, 200) : String(error) });
          }
        }
      }
      if (!confirm) throw new Ensayo();
      return true;
    });
    runId = out.runId;
  } catch (error) {
    if (!(error instanceof Ensayo)) throw error;
  }
  const resumen = Object.fromEntries(Object.entries(informe).map(([k, v]) => [k, v.length]));
  writeFileSync(`${DIR}/aplicacion-${phase}-${confirm ? `run${runId}` : "ensayo"}.json`, JSON.stringify({ modo: confirm ? "aplicado" : "ensayo (revertido)", runId, resumen, ...informe }, null, 2));
  console.log(JSON.stringify({ phase, modo: confirm ? `run ${runId}` : "ensayo (revertido)", resumen,
    cola: informe["cola"]!.slice(0, 5), errores: informe["errores"]!.slice(0, 5) }, null, 2));
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
