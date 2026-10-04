// Etapa 4 «Altas» — Motor de altas EN SECO (dry-run por defecto).
//
// Convierte un plan aprobado (plan-altas.jsonl, generado por plan-altas.py) en fichas
// con evidencia, usando el camino sancionado del operador (createEntity + run reversible).
//
//   * SIN --confirm: NO escribe nada.
//       1) pre-chequeos de solo lectura (existe ya / guardas de persona / duplicados),
//       2) sonda ER: repite las altas DENTRO de una transacción que se revierte al final
//          (patrón probado en tmp-analysis/ma-apply-2026-10-01/probe-er-person.ts):
//          dice exactamente qué crearía, qué ya existe y qué quedaría en cola, con score.
//   * CON --confirm: aplica por lotes en runs reversibles (diario 0028; deshacer por
//     `crv runs undo <id>` o desde Historial), savepoint por entidad, guardas ER
//     (needs_review con score<0.66 → allowSimilar; resto a cola), claim + evidencia
//     por campo (fuente rateyourmusic, snapshot de la captura 2026-10-02/03).
//
// Uso:
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/altas-motor.mts \
//     --plan=reports/etapa4-altas-2026-10-03/plan-altas.jsonl [--confirm] [--batch=200] [--sin-er]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../../src/db/client.js";
import { OperatorError, createEntity, withOperatorRun, type OperatorContext } from "../../src/merge/operator.js";
import { normalizeEntityName } from "../../src/normalization/entity-name.js";
import { classifyPersonName } from "../../src/review/person-junk.js";

const ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano";
const OUT = path.join(ROOT, "reports/etapa4-altas-2026-10-03");

const args = process.argv.slice(2);
const argVal = (n: string) => args.find((v) => v.startsWith(`--${n}=`))?.split("=")[1];
const CONFIRM = args.includes("--confirm");
const SIN_ER = args.includes("--sin-er");
const BATCH = Number(argVal("batch") ?? 200);
const PLAN_PATH = argVal("plan") ?? path.join(OUT, "plan-altas.jsonl");

interface PlanItem {
  tipo: "artist" | "person" | "album";
  clave: string;
  rym_href: string;
  url: string;
  nombre: string;
  values: Record<string, unknown>;
  evidencia: { url: string; excerpt: string; snapshot: string; captura?: string };
  parent?: { rym_href?: string; artist_id?: number; name?: string };
  origen: string;
  motivo?: string;
}

type Resultado = Record<string, { resultado: string; detalle?: string; score?: number; existingId?: number; id?: number; candidatos?: string[] }>;

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const ts = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const COLS: Record<string, string> = { artist: "artist_id", person: "person_id", album: "album_id" };

function cargarPlan(): PlanItem[] {
  const items = readFileSync(PLAN_PATH, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PlanItem);
  const orden = { artist: 0, person: 1, album: 2 } as const;
  items.sort((a, b) => orden[a.tipo] - orden[b.tipo]);
  for (const it of items) {
    if (!it.nombre || !it.values || typeof it.values !== "object") throw new Error(`ítem inválido: ${JSON.stringify(it).slice(0, 120)}`);
    if (it.tipo === "album" && !it.parent) throw new Error(`álbum sin padre: ${it.clave}`);
  }
  return items;
}

/** Claim de evidencia RYM (mismo patrón que la etapa 1: accepted, human, con claim_evidence). */
async function rymClaim(context: OperatorContext, sourceId: number, it: PlanItem, id: number, field: string, value: unknown): Promise<boolean> {
  const key = `${it.clave}:${field}`;
  const claim = await context.client.query<{ id: string }>(`
    INSERT INTO ingest.claims(source_id,entity_kind,${COLS[it.tipo]},field,raw_value,normalized_value,raw_hash,extractor,
                              extractor_version,confidence,status,created_by,run_id,notes,identity_key)
    VALUES($1,$2,$3,$4,$5::jsonb,$5::jsonb,$6,'captura-rym-nuevos','1','medium','accepted','human',$7,$8,$9)
    ON CONFLICT DO NOTHING RETURNING id::text`,
  [sourceId, it.tipo, id, field, JSON.stringify(value), sha([it.tipo, key, field, value, it.evidencia.url]),
    context.runId,
    `${field} según Rate Your Music (captura «nuevos» 2026-10-02/03, snapshot ${it.evidencia.snapshot}): ${it.evidencia.excerpt}`.slice(0, 400),
    key]);
  const claimId = claim.rows[0]?.id;
  if (!claimId) return false;
  await context.client.query(
    "INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING",
    [claimId, it.evidencia.url, it.evidencia.excerpt.slice(0, 500), sha([it.evidencia.url, it.evidencia.excerpt])]);
  return true;
}

/** Pre-chequeos de solo lectura: existencia y guardas. Devuelve avisos por clave. */
async function preChequeos(items: PlanItem[]): Promise<Record<string, string[]>> {
  const pool = getPool();
  const avisos: Record<string, string[]> = {};
  const push = (k: string, msg: string) => { (avisos[k] ??= []).push(msg); };

  const artistKeys = new Map<string, { id: number; name: string }>();
  for (const r of (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.artists")).rows) {
    artistKeys.set(normalizeEntityName(r.name).compactSecondaryKey, { id: Number(r.id), name: r.name });
  }
  for (const r of (await pool.query<{ artist_id: string; alias: string }>("SELECT artist_id::text, alias FROM ingest.artist_aliases")).rows) {
    artistKeys.set(normalizeEntityName(r.alias).compactSecondaryKey, { id: Number(r.artist_id), name: r.alias });
  }
  const personKeys = new Map<string, { id: number; name: string }>();
  for (const r of (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons")).rows) {
    personKeys.set(normalizeEntityName(r.name).compactSecondaryKey, { id: Number(r.id), name: r.name });
  }
  for (const r of (await pool.query<{ person_id: string; alias: string }>("SELECT person_id::text, alias FROM ingest.person_aliases")).rows) {
    personKeys.set(normalizeEntityName(r.alias).compactSecondaryKey, { id: Number(r.person_id), name: r.alias });
  }
  const albumKeys = new Set<string>();
  for (const r of (await pool.query<{ artist_id: string; title: string }>("SELECT artist_id::text, title FROM public.albums")).rows) {
    albumKeys.add(`${Number(r.artist_id)}|${normalizeEntityName(r.title).compactSecondaryKey}`);
  }

  for (const it of items) {
    const key = normalizeEntityName(it.nombre).compactSecondaryKey;
    if (it.tipo === "artist") {
      const hit = artistKeys.get(key);
      if (hit) push(it.clave, `ya existe artista #${hit.id} «${hit.name}» (clave compacta)`);
    } else if (it.tipo === "person") {
      const cls = classifyPersonName(it.nombre);
      if (cls.kind !== "ok") push(it.clave, `nombre sospechoso (${cls.kind}): ${cls.reason}`);
      const hp = personKeys.get(key);
      if (hp) push(it.clave, `ya existe persona #${hp.id} «${hp.name}» (clave compacta)`);
      const ha = artistKeys.get(key);
      if (ha) push(it.clave, `el nombre colisiona con artista/banda #${ha.id} «${ha.name}»`);
    } else if (it.tipo === "album") {
      const pid = it.parent!.artist_id;
      if (pid && albumKeys.has(`${pid}|${key}`)) push(it.clave, `el artista ${pid} ya tiene un disco con ese título (clave compacta)`);
    }
  }
  return avisos;
}

/** Sonda ER (dry-run): repite las altas en una transacción revertida al final. 0 escrituras netas. */
async function sondaEr(items: PlanItem[]): Promise<Resultado> {
  const out: Resultado = {};
  const ids = new Map<string, number>();
  const resolverPadre = async (client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, it: PlanItem): Promise<number | undefined> => {
    if (it.parent?.artist_id) return it.parent.artist_id;
    const k = `href:${it.parent?.rym_href}`;
    if (ids.has(k)) return ids.get(k);
    if (it.parent?.name) {
      const r = await client.query("SELECT id::text FROM public.artists WHERE lower(name)=lower($1) ORDER BY id LIMIT 1", [it.parent.name]);
      const row = r.rows[0];
      if (row) return Number(row["id"]);
    }
    return undefined;
  };
  try {
    await withOperatorRun({
      name: "hermes:altas-er-sonda (revertida)",
      operator: "hermes-curaduria (sonda ER)",
      note: "Sonda ER de las altas de la etapa 4: se revierte al final; no escribe nada.",
    }, async (context) => {
      for (const it of items) {
        await context.client.query("SAVEPOINT p");
        let conservar = false;
        let opts: Record<string, unknown> = {};
        if (it.tipo === "album") {
          const pid = await resolverPadre(context.client, it);
          if (!pid) {
            out[it.clave] = { resultado: "error", detalle: "padre sin resolver (¿artista no creado antes en el plan?)" };
            await context.client.query("ROLLBACK TO SAVEPOINT p");
            await context.client.query("RELEASE SAVEPOINT p");
            continue;
          }
          opts = { artistId: pid };
        }
        try {
          const res = await createEntity(context, it.tipo, it.values, opts);
          ids.set(it.clave, res.id);
          ids.set(`href:${it.rym_href}`, res.id);
          out[it.clave] = { resultado: "crearia", id: res.id };
          conservar = true;
        } catch (error) {
          const rec: Resultado[string] = { resultado: "error" };
          if (error instanceof OperatorError) {
            rec.detalle = error.message.slice(0, 220);
            if (error.code === "needs_review") {
              const dec = await context.client.query<{ score: string | null; candidates: unknown }>(
                "SELECT score::text, candidates FROM ingest.entity_resolution_decisions WHERE entity_kind=$1 AND input_name_original=$2 ORDER BY id DESC LIMIT 1",
                [it.tipo.toUpperCase(), it.values["name"] ?? it.values["title"]]);
              const score = Number(dec.rows[0]?.score ?? 1);
              rec.score = score;
              const cands = (dec.rows[0]?.candidates as Array<{ canonicalName?: string }> | undefined) ?? [];
              rec.candidatos = cands.slice(0, 3).map((c) => c.canonicalName ?? "?");
              if (score < 0.66) {
                await context.client.query("SAVEPOINT p2");
                try {
                  const res2 = await createEntity(context, it.tipo, it.values, { ...opts, allowSimilar: true });
                  rec.resultado = "crearia_con_allowSimilar";
                  rec.id = res2.id;
                  ids.set(it.clave, res2.id);
                  ids.set(`href:${it.rym_href}`, res2.id);
                  conservar = true;
                  await context.client.query("RELEASE SAVEPOINT p2");
                } catch (e2) {
                  rec.resultado = "error_allowSimilar";
                  rec.detalle = (e2 instanceof Error ? e2.message : String(e2)).slice(0, 220);
                  await context.client.query("ROLLBACK TO SAVEPOINT p2");
                  await context.client.query("RELEASE SAVEPOINT p2");
                }
              } else {
                rec.resultado = "quedaria_en_cola_revision";
              }
            } else if (error.code === "already_exists") {
              rec.resultado = "ya_existe";
              const eid = Number((error.details?.["existingId"] as number | undefined) ?? 0);
              if (eid) rec.existingId = eid;
            }
          } else {
            rec.detalle = (error instanceof Error ? error.message : String(error)).slice(0, 220);
          }
          out[it.clave] = rec;
        }
        // Si la ficha quedó creada en la tx (normal o allowSimilar), se conserva para
        // que los ítems dependientes la referencien; si no, se revierte su savepoint.
        if (conservar) {
          await context.client.query("RELEASE SAVEPOINT p");
        } else {
          await context.client.query("ROLLBACK TO SAVEPOINT p");
          await context.client.query("RELEASE SAVEPOINT p");
        }
      }
      throw new Error("probe-rollback-confirmado");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "probe-rollback-confirmado") throw error;
  }
  return out;
}

/** Aplica el plan (con --confirm): runs reversibles por lotes. */
async function aplicar(items: PlanItem[]): Promise<void> {
  const pool = getPool();
  const src = await pool.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='rateyourmusic'");
  const sourceId = Number(src.rows[0]?.id);
  if (!sourceId) throw new Error("fuente rateyourmusic no existe");
  const ids = new Map<string, number>();
  const creadas: unknown[] = []; const review: unknown[] = []; const errors: unknown[] = []; const runs: number[] = [];

  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const { runId, result } = await withOperatorRun({
      name: `hermes:altas-rym-nuevos (${i + 1}-${i + slice.length}/${items.length})`,
      operator: "hermes-curaduria (delegado por Brian)",
      note: "Altas de la etapa 4 desde la captura «nuevos» de Rate Your Music (2026-10-02/03), aprobadas caso a caso por Brian; con evidencia por campo y auditoría.",
    }, async (context) => {
      let hechas = 0;
      for (const it of slice) {
        await context.client.query("SAVEPOINT alt");
        try {
          let opts: Record<string, unknown> = {};
          if (it.tipo === "album") {
            let pid: number | undefined = it.parent?.artist_id;
            if (!pid && it.parent?.rym_href) pid = ids.get(`href:${it.parent.rym_href}`);
            if (!pid && it.parent?.name) {
              const r = await context.client.query<{ id: string }>(
                "SELECT id::text FROM public.artists WHERE lower(name)=lower($1) ORDER BY id LIMIT 1", [it.parent.name]);
              const row = r.rows[0];
              if (row) pid = Number(row.id);
            }
            if (!pid) {
              await context.client.query("ROLLBACK TO SAVEPOINT alt");
              await context.client.query("RELEASE SAVEPOINT alt");
              errors.push({ clave: it.clave, error: "padre sin resolver" });
              continue;
            }
            opts = { artistId: pid };
          }
          let id: number | null = null;
          try {
            id = (await createEntity(context, it.tipo, it.values, opts)).id;
          } catch (error) {
            if (error instanceof OperatorError && error.code === "needs_review") {
              const rdId = error.details?.["resolutionDecisionId"] as number | undefined;
              const dec = await context.client.query<{ score: string | null }>(
                "SELECT score::text FROM ingest.entity_resolution_decisions WHERE entity_kind=$1 AND input_name_original=$2 ORDER BY id DESC LIMIT 1",
                [it.tipo.toUpperCase(), it.values["name"] ?? it.values["title"]]);
              const score = Number(dec.rows[0]?.score ?? 1);
              if (score < 0.66) {
                id = (await createEntity(context, it.tipo, it.values, { ...opts, allowSimilar: true })).id;
                // La primera pasada del ER dejó un aviso abierto (ambigüedad); la ficha se creó
                // como distinta a sabiendas → el aviso se cierra en el mismo run (reversible).
                if (rdId) {
                  await context.client.query(
                    `UPDATE ingest.review_queue
                       SET status='dismissed', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
                     WHERE status IN ('open','in_progress') AND payload->>'resolutionDecisionId' = $1`,
                    [String(rdId),
                     `Alta como ficha distinta con allowSimilar (run ${context.runId}, score ${score.toFixed(3)}); aviso de la primera pasada del ER, sin objeto.`]);
                }
              } else {
                review.push({ clave: it.clave, score, detalle: "ER la marca como posible duplicado; queda en cola" });
              }
            } else if (error instanceof OperatorError && error.code === "already_exists") {
              review.push({ clave: it.clave, existingId: error.details?.["existingId"], detalle: "ya existe (ER)" });
            } else {
              throw error;
            }
          }
          if (id) {
            for (const [field, value] of Object.entries(it.values)) {
              await rymClaim(context, sourceId, it, id, field, value);
            }
            ids.set(it.clave, id);
            ids.set(`href:${it.rym_href}`, id);
            creadas.push({ clave: it.clave, tipo: it.tipo, id, nombre: it.nombre });
            hechas += 1;
          }
          await context.client.query("RELEASE SAVEPOINT alt");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT alt");
          await context.client.query("RELEASE SAVEPOINT alt");
          errors.push({ clave: it.clave, error: (error instanceof Error ? error.message : String(error)).slice(0, 220) });
        }
      }
      return hechas;
    });
    runs.push(runId);
    console.log(`lote ${i + 1}-${i + slice.length}: run ${runId}, ${result} altas`);
  }
  const informe = { generado: new Date().toISOString(), plan: PLAN_PATH, runs, creadas, review, errors };
  writeFileSync(path.join(OUT, `altas-apply-${ts()}.json`), JSON.stringify(informe, null, 1));
  console.log(`TOTAL: ${creadas.length} creadas | ${review.length} a cola | ${errors.length} errores | runs ${runs.join(",")}`);
  for (const x of [...review, ...errors].slice(0, 12)) console.log("  ", JSON.stringify(x).slice(0, 200));
}

async function main(): Promise<void> {
  const items = cargarPlan();
  console.log(`plan: ${PLAN_PATH} (${items.length} ítems)`);
  const avisos = await preChequeos(items);
  const nAvisos = Object.values(avisos).reduce((a, v) => a + v.length, 0);
  console.log(`pre-chequeos: ${Object.keys(avisos).length} ítems con avisos (${nAvisos} avisos)`);

  if (!CONFIRM) {
    console.log("modo EN SECO: no se escribe nada" + (SIN_ER ? " (sonda ER omitida)" : "; corriendo sonda ER revertida…"));
    const er = SIN_ER ? {} : await sondaEr(items);
    const resumen: Record<string, number> = {};
    for (const v of Object.values(er)) resumen[v.resultado] = (resumen[v.resultado] ?? 0) + 1;
    const informe = { generado: new Date().toISOString(), plan: PLAN_PATH, modo: "dry-run",
      items: items.map((it) => ({ clave: it.clave, tipo: it.tipo, nombre: it.nombre, values: it.values,
        avisos: avisos[it.clave] ?? [], sondaER: er[it.clave] ?? null })) };
    writeFileSync(path.join(OUT, `altas-dry-run-${ts()}.json`), JSON.stringify(informe, null, 1));
    console.log(`sonda ER: ${JSON.stringify(resumen)}`);
    for (const it of informe.items) {
      const a = it.avisos.length ? ` | AVISOS: ${it.avisos.join(" ; ")}` : "";
      const e = it.sondaER ? ` | ER: ${it.sondaER.resultado}${it.sondaER.score !== undefined ? ` (score ${it.sondaER.score})` : ""}${it.sondaER.existingId ? ` #${it.sondaER.existingId}` : ""}${it.sondaER.id ? ` (sería #${it.sondaER.id})` : ""}` : "";
      console.log(`  [${it.tipo}] ${it.nombre}${a}${e}`);
    }
    console.log(`informe: ${OUT}/altas-dry-run-${ts()}.json`);
    await closeDb();
    return;
  }

  console.log("modo APLICAR (--confirm)");
  await aplicar(items);
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
