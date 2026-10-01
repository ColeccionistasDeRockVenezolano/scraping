// CRV · Fusionar sin perder datos (Brian, 2026-10-01).
//
// Antes, cuando la ficha que desaparece contradecía a la que queda, su valor
// se descartaba: así se perdieron 569 biografías y varias ciudades y años.
// Ahora `mergeInto` lo conserva en la ficha que queda:
//
//   * textos largos (biografía, reseña): se unen al momento y la ficha queda
//     marcada en `ingest.text_rewrites` para que la IA los reescriba en uno;
//   * textos libres secundarios (notas, curiosidades, temas): se unen;
//   * datos cortos (año, ciudad, tipo, foto…): se anotan en las notas.
//
// Lo escrito queda en la auditoría de la fusión (`preserved`) para que
// deshacerla lo devuelva, y la marca enlaza la auditoría para retirarse.
import type { PoolClient } from "pg";

export type PreserveKind = "person" | "artist" | "organization" | "album";

export interface PreserveSpec {
  /** Textos largos: se unen y quedan marcados para reescribirse con IA. */
  rewrite: readonly string[];
  /** Textos libres que se unen sin reescribir. `notes` siempre está. */
  join: readonly string[];
  /** Datos cortos, con su etiqueta: el valor que pierde va a las notas. */
  note: Readonly<Record<string, string>>;
}

export const PRESERVE_SPECS: Readonly<Record<PreserveKind, PreserveSpec>> = {
  person: {
    rewrite: ["biography"],
    join: ["trivia"],
    note: {
      nationality: "Nacionalidad", birth_date: "Nacimiento", death_date: "Fallecimiento", real_name: "Nombre real",
      birth_city: "Ciudad natal", death_cause: "Causa de muerte", gender: "Género", picture_url: "Foto", is_deceased: "Fallecido/a",
    },
  },
  artist: {
    rewrite: ["biography"],
    join: ["themes"],
    note: {
      artist_type: "Tipo", origin_city: "Ciudad", origin_country: "País", formed_year: "Desde", disbanded_year: "Hasta",
      picture_url: "Foto", status: "Estado", years_active: "Años activos", logo_url: "Logo",
    },
  },
  organization: {
    rewrite: ["biography"],
    join: [],
    note: { organization_type: "Tipo", picture_url: "Foto", website_url: "Web", country: "País" },
  },
  album: {
    rewrite: ["description"],
    join: [],
    note: {
      release_year: "Año", album_type: "Tipo", label_id: "Sello (id)", cover_url: "Portada", release_date_text: "Fecha",
      catalog_id: "Catálogo", media_format: "Formato", youtube_url: "YouTube", instagram_url: "Instagram", wordpress_url: "Blog",
    },
  },
};

const TABLE: Record<PreserveKind, string> = { person: "persons", artist: "artists", organization: "organizations", album: "albums" };
const IDENTITY: Record<PreserveKind, string> = { person: "name", artist: "name", organization: "name", album: "title" };
/** «Vacío» que no es NULL: el DEFAULT del core («nadie lo dijo»). */
const EMPTY_VALUE: Readonly<Record<string, unknown>> = { "albums.album_type": "other" };

export function isPreserveKind(kind: string): kind is PreserveKind {
  return kind in PRESERVE_SPECS;
}

export interface TextSource { label: string; text: string }

/** Lo que la fusión escribió en la ficha que queda, para poder devolverlo. */
export interface PreservedChange { column: string; before: unknown; after: unknown }

/** Marca de reescritura que la fusión abre (o amplía) al terminar. */
export interface PendingRewrite { field: string; sources: TextSource[] }

export interface PreserveOptions {
  /** Campos que una persona ya resolvió en la fusión (eligió o combinó): no se tocan. */
  resolved?: readonly string[];
  /** Valores de la ficha que queda que una persona reemplazó por los del duplicado: van a las notas. */
  replaced?: ReadonlyArray<{ field: string; value: unknown }>;
  /** Marcas pedidas por una persona (p. ej. «reescribir con IA después» al combinar a mano). */
  rewrites?: readonly PendingRewrite[];
}

export interface PreserveOutcome {
  changes: PreservedChange[];
  rewrites: PendingRewrite[];
  /** Marcas pendientes del duplicado que se cerraron (sus fuentes pasaron a la que queda). */
  closedRewrites: number[];
}

function present(table: string, column: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && !value.trim()) return false;
  const empty = EMPTY_VALUE[`${table}.${column}`];
  return empty === undefined || value !== empty;
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();

/** `true` si el texto `inner` ya está dentro de `outer` (sin mirar espacios ni mayúsculas). */
export function containsText(outer: string, inner: string): boolean {
  return squash(outer).includes(squash(inner));
}

/** Une dos textos en párrafos; si uno ya contiene al otro, queda el mayor. */
export function joinTexts(keep: string, drop: string): string {
  if (containsText(keep, drop)) return keep;
  if (containsText(drop, keep)) return drop;
  return `${keep.trim()}\n\n${drop.trim()}`;
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value)) return value.slice(0, 10);
  return typeof value === "string" ? `«${value}»` : String(value);
}

/** Línea de notas con lo que quedó fuera: «Al fusionar «X» (#12) quedó fuera — Desde: 1959; Ciudad: «Lara».» */
export function lostValuesLine(dropName: string, dropId: number, items: ReadonlyArray<{ label: string; value: unknown }>, date = new Date()): string {
  const values = items.map((item) => `${item.label}: ${formatValue(item.value)}`).join("; ");
  return `Al fusionar «${dropName}» (#${dropId}, ${date.toISOString().slice(0, 10)}) quedó fuera — ${values}.`;
}

/** Fuentes ya pendientes de la ficha (si una fusión anterior la marcó). */
async function pendingSources(client: PoolClient, kind: PreserveKind, id: number, field: string): Promise<TextSource[] | null> {
  const { rows } = await client.query<{ sources: TextSource[] }>(
    "SELECT sources FROM ingest.text_rewrites WHERE entity_kind=$1 AND entity_id=$2 AND field=$3 AND status='pending'",
    [kind, id, field]);
  return rows[0]?.sources ?? null;
}

/**
 * Conserva en `keep` lo que `drop` aportaba y la fusión habría descartado.
 * `keep` es la fila tal como quedó tras completar los vacíos; `drop`, la fila
 * del duplicado antes de borrarse. Escribe la ficha que queda y devuelve los
 * cambios (para la auditoría) y las marcas de reescritura que hay que abrir.
 */
export async function preserveDiscarded(
  client: PoolClient, kind: PreserveKind, keep: Record<string, unknown>, drop: Record<string, unknown>,
  options: PreserveOptions = {},
): Promise<PreserveOutcome> {
  const spec = PRESERVE_SPECS[kind];
  const table = TABLE[kind];
  const keepId = Number(keep["id"]);
  const dropId = Number(drop["id"]);
  const keepName = String(keep[IDENTITY[kind]]);
  const dropName = String(drop[IDENTITY[kind]]);
  const resolved = new Set(options.resolved ?? []);
  const updates = new Map<string, unknown>();
  const rewrites: PendingRewrite[] = [...(options.rewrites ?? [])];

  for (const field of spec.rewrite) {
    if (resolved.has(field)) continue;
    const keepText = keep[field];
    const dropText = drop[field];
    if (!present(table, field, keepText) || !present(table, field, dropText)) continue;
    if (containsText(String(keepText), String(dropText))) continue;
    updates.set(field, joinTexts(String(keepText), String(dropText)));
    // Si alguna de las dos ya esperaba reescritura, sus textos originales
    // valen más que la unión provisional que hoy tienen en la ficha.
    const keepSources = await pendingSources(client, kind, keepId, field);
    const dropSources = await pendingSources(client, kind, dropId, field);
    rewrites.push({
      field,
      sources: [
        ...(keepSources ?? [{ label: keepName, text: String(keepText) }]),
        ...(dropSources ?? [{ label: dropName, text: String(dropText) }]),
      ],
    });
  }

  for (const field of [...spec.join, "notes"]) {
    if (resolved.has(field)) continue;
    const dropText = drop[field];
    if (!present(table, field, dropText)) continue;
    const keepText = keep[field];
    if (!present(table, field, keepText)) continue; // ya lo completó `fillEmptyColumns`
    if (containsText(String(keepText), String(dropText))) continue;
    updates.set(field, joinTexts(String(keepText), field === "notes" ? `Notas de «${dropName}»: ${String(dropText).trim()}` : String(dropText)));
  }

  const lost: Array<{ label: string; value: unknown }> = [];
  for (const [field, label] of Object.entries(spec.note)) {
    if (resolved.has(field) || !(field in drop)) continue;
    const dropValue = drop[field];
    if (!present(table, field, dropValue) || !present(table, field, keep[field])) continue;
    if (JSON.stringify(keep[field]) === JSON.stringify(dropValue)) continue;
    lost.push({ label, value: dropValue });
  }
  for (const item of options.replaced ?? []) {
    const label = spec.note[item.field];
    if (label && present(table, item.field, item.value)) lost.push({ label, value: item.value });
  }
  if (lost.length) {
    const current = (updates.get("notes") ?? keep["notes"]) as string | null;
    const line = lostValuesLine(dropName, dropId, lost);
    updates.set("notes", current && String(current).trim() ? `${String(current).trim()}\n${line}` : line);
  }

  const changes: PreservedChange[] = [];
  if (updates.size) {
    const columns = [...updates.keys()];
    const assignments = columns.map((column, index) => `${column}=$${index + 2}`);
    if ("updated_at" in keep) assignments.push("updated_at=now()");
    await client.query(`UPDATE public.${table} SET ${assignments.join(", ")} WHERE id=$1`, [keepId, ...columns.map((column) => updates.get(column))]);
    for (const column of columns) changes.push({ column, before: keep[column] ?? null, after: updates.get(column) });
  }

  // Las marcas pendientes del duplicado ya viajan dentro de las fuentes de la
  // ficha que queda (o no hacían falta): se cierran para no dejar huérfanas.
  const closed = await client.query<{ id: string }>(
    "UPDATE ingest.text_rewrites SET status='discarded', resolved_at=now() WHERE entity_kind=$1 AND entity_id=$2 AND status='pending' RETURNING id::text",
    [kind, dropId]);
  return { changes, rewrites, closedRewrites: closed.rows.map((row) => Number(row.id)) };
}

/**
 * Abre (o amplía) las marcas de reescritura de la ficha que queda, enlazadas
 * a la auditoría de la fusión para que deshacerla las retire.
 */
export async function openRewrites(
  client: PoolClient, kind: PreserveKind, keepId: number, rewrites: readonly PendingRewrite[],
  link: { reason: string; runId: number; mergeAuditId?: number },
): Promise<number> {
  let opened = 0;
  for (const rewrite of rewrites) {
    const sources = dedupeSources(rewrite.sources);
    if (sources.length < 2) continue;
    await client.query(`
      INSERT INTO ingest.text_rewrites(entity_kind,entity_id,field,sources,reason,merge_audit_id,run_id)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
      ON CONFLICT (entity_kind,entity_id,field) WHERE status='pending'
      DO UPDATE SET sources=EXCLUDED.sources, reason=EXCLUDED.reason,
                    merge_audit_id=EXCLUDED.merge_audit_id, run_id=EXCLUDED.run_id`,
    [kind, keepId, rewrite.field, JSON.stringify(sources), link.reason, link.mergeAuditId ?? null, link.runId]);
    opened += 1;
  }
  return opened;
}

/** Quita fuentes repetidas o contenidas en otra (sin perder ninguna voz distinta). */
export function dedupeSources(sources: readonly TextSource[]): TextSource[] {
  const out: TextSource[] = [];
  for (const source of sources) {
    if (!source.text?.trim()) continue;
    if (out.some((kept) => containsText(kept.text, source.text))) continue;
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (containsText(source.text, out[index]!.text)) out.splice(index, 1);
    }
    out.push({ label: source.label, text: source.text.trim() });
  }
  return out;
}

/**
 * Al deshacer una fusión: lo que `preserveDiscarded` escribió vuelve a como
 * estaba, salvo que alguien lo haya cambiado después (eso no se pisa), y la
 * marca que abrió se retira. Devuelve las columnas que no pudo devolver.
 */
export async function revertPreserved(
  client: PoolClient, kind: PreserveKind, keepId: number, changes: readonly PreservedChange[], mergeAuditId: number,
  closedRewrites: readonly number[] = [],
): Promise<string[]> {
  const table = TABLE[kind];
  const skipped: string[] = [];
  for (const change of changes) {
    const { rowCount } = await client.query(
      `UPDATE public.${table} SET ${change.column}=$2 WHERE id=$1 AND ${change.column} IS NOT DISTINCT FROM $3`,
      [keepId, change.before, change.after]);
    if (!rowCount) skipped.push(change.column);
  }
  await client.query(
    "DELETE FROM ingest.text_rewrites WHERE merge_audit_id=$1 AND status='pending'", [mergeAuditId]);
  if (closedRewrites.length) {
    await client.query(
      "UPDATE ingest.text_rewrites SET status='pending', resolved_at=NULL WHERE id=ANY($1::bigint[]) AND status='discarded'",
      [closedRewrites]);
  }
  return skipped;
}
