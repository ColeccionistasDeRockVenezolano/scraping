// CRV · Recupera lo que las fusiones anteriores descartaron (Brian, 2026-10-01).
//
// Hasta la 0034, al fusionar dos fichas, el valor del duplicado que contradecía
// al de la ficha que queda se perdía (seguía solo en la auditoría:
// `merge_audit.old_value` guarda la fila entera del duplicado). Este script
// recorre todas las fusiones `merged_duplicate` y aplica la regla de hoy
// (src/merge/preserve.ts) sobre la ficha viva:
//
//   * biografía / reseña perdida → marca en `ingest.text_rewrites` con el texto
//     actual y los perdidos como fuentes; `crv texts rewrite` los une con IA;
//   * notas, curiosidades y temas perdidos → se unen a la ficha;
//   * datos cortos perdidos (año, ciudad, tipo, foto…) → línea en las notas.
//
// Se salta lo que no se perdió: fusiones deshechas (el duplicado existe),
// fichas que ya no están, valores que la ficha ya contiene o ya anotó.
// «Various Artists» no recibe las reseñas de recopilatorios que absorbió.
//
// Uso: tsx scripts/recover-merge-losses.ts [--confirm]   (en seco por defecto)
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";
import {
  containsText, dedupeSources, joinTexts, lostValuesLine, openRewrites, PRESERVE_SPECS, type PreserveKind, type TextSource,
} from "../src/merge/preserve.js";

const confirm = process.argv.includes("--confirm");
const REPORT = `reports/recover-merge-losses-${new Date().toISOString().slice(0, 10)}${confirm ? "" : "-dry-run"}.json`;
const TABLE: Record<PreserveKind, string> = { person: "persons", artist: "artists", organization: "organizations", album: "albums" };
const IDENTITY: Record<PreserveKind, string> = { person: "name", artist: "name", organization: "name", album: "title" };
const COMPILATION_HOLDER = /^(various artists|varios artistas|varios)$/iu;

interface Audit { id: string; run_id: string; entity_kind: PreserveKind; old_value: Record<string, unknown>; new_value: Record<string, unknown> | null }

const present = (kind: PreserveKind, field: string, value: unknown) =>
  value !== null && value !== undefined && !(typeof value === "string" && !value.trim()) && !(kind === "album" && field === "album_type" && value === "other");

/** Fechas de la auditoría (`JSON.stringify` de un Date) y de la fila viva comparadas por día. */
function comparable(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(value)) return new Date(value).toISOString().slice(0, 10);
  return JSON.stringify(value);
}

interface Plan {
  kind: PreserveKind; id: number; name: string; auditId: number;
  rewrite: Map<string, TextSource[]>;
  join: Map<string, string>;
  lost: Array<{ dropName: string; dropId: number; items: Array<{ label: string; value: unknown }> }>;
}

async function main(): Promise<void> {
  const pool = getPool();
  const audits = (await pool.query<Audit>(`
    SELECT id::text, run_id::text, entity_kind::text AS entity_kind, old_value, new_value
      FROM ingest.merge_audit
     WHERE field='merged_duplicate' AND entity_kind::text IN ('person','artist','organization','album')
     ORDER BY id`)).rows;

  const stats = { audits: audits.length, undone: 0, keepGone: 0, compilationHolder: 0 };
  const plans = new Map<string, Plan>();
  const rowCache = new Map<string, Record<string, unknown> | null>();
  const load = async (kind: PreserveKind, id: number) => {
    const key = `${kind}:${id}`;
    if (!rowCache.has(key)) {
      rowCache.set(key, (await pool.query<Record<string, unknown>>(`SELECT * FROM public.${TABLE[kind]} WHERE id=$1`, [id])).rows[0] ?? null);
    }
    return rowCache.get(key)!;
  };

  /** URLs remotas que la ficha tuvo en esa columna antes de localizarse (`/crv/media/...`). */
  const imageOrigins = async (kind: PreserveKind, id: number, field: string) => (await pool.query<{ o: string }>(`
    SELECT old_value #>> '{}' AS o FROM ingest.merge_audit
     WHERE ${kind}_id=$1 AND field=$2 AND jsonb_typeof(old_value)='string'`, [id, field])).rows.map((row) => row.o);

  for (const audit of audits) {
    const kind = audit.entity_kind;
    const drop = audit.old_value;
    const dropId = Number(drop["id"]);
    if (await load(kind, dropId)) { stats.undone += 1; continue; }
    let keepId = Number(audit.new_value?.["keptId"] ?? 0);
    const redirect = (await pool.query<{ to_id: string }>(
      "SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind=$1 AND from_id=$2", [kind, keepId])).rows[0];
    if (redirect) keepId = Number(redirect.to_id);
    const keep = await load(kind, keepId);
    if (!keep) { stats.keepGone += 1; continue; }
    const keepName = String(keep[IDENTITY[kind]]);
    const dropName = String(drop[IDENTITY[kind]]);
    const spec = PRESERVE_SPECS[kind];
    const key = `${kind}:${keepId}`;
    const plan: Plan = plans.get(key) ?? { kind, id: keepId, name: keepName, auditId: Number(audit.id), rewrite: new Map(), join: new Map(), lost: [] };
    plan.auditId = Number(audit.id);
    const notesNow = [keep["notes"], plan.join.get("notes")].filter(Boolean).join("\n");

    for (const field of spec.rewrite) {
      const text = drop[field];
      if (!present(kind, field, text) || !present(kind, field, keep[field])) continue;
      if (containsText(String(keep[field]), String(text))) continue;
      if (kind === "artist" && COMPILATION_HOLDER.test(keepName)) { stats.compilationHolder += 1; continue; }
      const sources = plan.rewrite.get(field) ?? [{ label: keepName, text: String(keep[field]) }];
      sources.push({ label: dropName, text: String(text) });
      plan.rewrite.set(field, sources);
    }
    for (const field of [...spec.join, "notes"]) {
      const text = drop[field];
      if (!present(kind, field, text)) continue;
      const current = plan.join.get(field) ?? (keep[field] as string | null);
      const addition = field === "notes" ? `Notas de «${dropName}»: ${String(text).trim()}` : String(text);
      if (current && (containsText(current, String(text)) || containsText(current, addition))) continue;
      plan.join.set(field, current ? joinTexts(current, addition) : addition);
    }
    const items: Array<{ label: string; value: unknown }> = [];
    for (const [field, label] of Object.entries(spec.note)) {
      if (!(field in drop) || !present(kind, field, drop[field]) || !present(kind, field, keep[field])) continue;
      if (comparable(drop[field]) === comparable(keep[field])) continue;
      const shown = drop[field] instanceof Date || (typeof drop[field] === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(String(drop[field])))
        ? comparable(drop[field]).replace(/"/gu, "") : drop[field];
      if (notesNow.includes(`(#${dropId},`) || notesNow.includes(String(shown))) continue;
      // La copia local de la imagen que quedó se descargó de esa misma URL: no se perdió nada.
      if ((field === "picture_url" || field === "cover_url") && (await imageOrigins(kind, keepId, field)).includes(String(drop[field]))) continue;
      items.push({ label, value: shown });
    }
    if (items.length) plan.lost.push({ dropName, dropId, items });
    if (plan.rewrite.size || plan.join.size || plan.lost.length) plans.set(key, plan);
  }

  const summary = {
    mode: confirm ? "confirm" : "dry-run", ...stats, entities: plans.size,
    rewrites: { person: 0, artist: 0, organization: 0, album: 0 } as Record<PreserveKind, number>,
    joins: 0, notesLines: 0, runId: null as number | null,
  };
  for (const plan of plans.values()) {
    summary.rewrites[plan.kind] += plan.rewrite.size;
    summary.joins += plan.join.size;
    summary.notesLines += plan.lost.length;
  }
  const detail = [...plans.values()].map((plan) => ({
    kind: plan.kind, id: plan.id, name: plan.name,
    rewrite: Object.fromEntries([...plan.rewrite].map(([field, sources]) => [field, dedupeSources(sources).map((source) => source.label)])),
    join: [...plan.join.keys()],
    lost: plan.lost.map((item) => lostValuesLine(item.dropName, item.dropId, item.items)),
  }));

  if (confirm) {
    const { runId } = await withOperatorRun({
      name: "script:recover-merge-losses", operator: "claude (delegado por Brian)",
      note: "Recupera lo que las fusiones anteriores a la 0034 descartaron (Brian, 2026-10-01): textos a la cola de IA, datos cortos a notas.",
      params: { entities: plans.size },
    }, async (context) => {
      for (const plan of plans.values()) {
        const changes: Record<string, unknown> = {};
        for (const [field, text] of plan.join) if (field !== "notes") changes[field] = text;
        let notes = plan.join.get("notes") ?? ((await getPool().query<{ notes: string | null }>(
          `SELECT notes FROM public.${TABLE[plan.kind]} WHERE id=$1`, [plan.id])).rows[0]?.notes ?? null);
        for (const item of plan.lost) {
          const line = lostValuesLine(item.dropName, item.dropId, item.items);
          notes = notes && notes.trim() ? `${notes.trim()}\n${line}` : line;
        }
        if (notes !== null && (plan.join.has("notes") || plan.lost.length)) changes["notes"] = notes;
        if (Object.keys(changes).length) await updateEntity(context, plan.kind, plan.id, changes);
        await openRewrites(context.client, plan.kind, plan.id,
          [...plan.rewrite].map(([field, sources]) => ({ field, sources })),
          { reason: "Recuperación de textos descartados por fusiones anteriores", runId: context.runId, mergeAuditId: plan.auditId });
      }
    });
    summary.runId = runId;
  }

  writeFileSync(REPORT, JSON.stringify({ summary, detail }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`detalle: ${REPORT}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
