// CRV · Una fila de libro de evidencia → géneros confirmados de su ficha.
// Lo comparten scripts/apply-source-genres.ts (fichas sin principal) y
// scripts/fix-source-genre-order.ts (rehace fichas mal ordenadas): el primer
// género que nombra la fuente es el principal y el resto secundarios.
import { readdirSync, readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { confirmGenre } from "../src/genres/human.js";
import type { GenreEntityKind } from "../src/genres/rules.js";
import { GENRE_COLUMN, GENRE_TABLE } from "../src/genres/store.js";
import { resolveGenreValue, type Taxonomy } from "../src/genres/taxonomy.js";
import { SKIP_SOURCE_ROWS } from "./genre-source-skip.js";

export interface LedgerRow {
  caseId: string; kind: GenreEntityKind; entityId: number; source: string; url: string;
  title?: string; rawGenre?: string; rawGenres?: string[]; genres?: Array<{ label: string }>;
  pages?: Array<{ url: string }>;
  /** Vzla Rockea / categorías de Wikipedia: las etiquetas vienen en orden alfabético. */
  order?: string; genreOrigin?: string;
}

export function readLedger(path: string): LedgerRow[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as LedgerRow);
}

/**
 * Todas las filas de los libros de reports/, por fuente|ficha|texto crudo: el
 * texto que cita la nota de una decisión `auto:<fuente>` identifica la fila que la produjo.
 */
export function ledgerIndex(): Map<string, LedgerRow> {
  const rows = new Map<string, LedgerRow>();
  for (const name of readdirSync("reports").filter((file) => /^genre-laya-evidence-.*\.jsonl$/u.test(file) && !/rejected|inventory/u.test(file))) {
    for (const row of readLedger(`reports/${name}`)) {
      if (!row.kind || !row.entityId || !row.source || SKIP_SOURCE_ROWS.has(`${row.source}|${row.caseId}`)) continue;
      const key = `${row.source}|${row.caseId}|${rawValues(row).join(" | ")}`;
      if (!rows.has(key)) rows.set(key, row);
    }
  }
  return rows;
}

/** La fila que produjo una decisión `auto:<fuente>`, si sigue en los libros. */
export function ledgerRowFor(index: Map<string, LedgerRow>, caseId: string, decidedBy: string, note: string): LedgerRow | undefined {
  const raw = /nombra «(.*)» en /su.exec(note)?.[1];
  return raw === undefined ? undefined : index.get(`${decidedBy.slice("auto:".length)}|${caseId}|${raw}`);
}

export function rawValues(row: LedgerRow): string[] {
  if (row.rawGenre) return [row.rawGenre];
  if (row.rawGenres) return row.rawGenres;
  return (row.genres ?? []).map((genre) => genre.label);
}

/**
 * Fuentes que listan los géneros en orden alfabético aunque la fila no lo
 * marque (Lobotoradio: 77 de 89 listas ordenadas, 2026-09-27; el resto por su
 * propia colación, «pop/rock» antes que «pop latino»).
 */
const ALPHABETICAL_SOURCES = new Set(["lobotoradio"]);

/** En una lista alfabética el primero no es el principal de la fuente. */
export function listedAlphabetically(row: LedgerRow): boolean {
  return ALPHABETICAL_SOURCES.has(row.source) || /alfab/iu.test(`${row.order ?? ""} ${row.genreOrigin ?? ""}`);
}

const sortKey = (value: string): string => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * Lista alfabética aunque la fuente no lo diga: marcada por fuente o fila, o
 * tres o más etiquetas que ya vienen ordenadas (MusicBrainz con votos empatados, Deezer).
 */
export function inAlphabeticalOrder(row: LedgerRow): boolean {
  if (listedAlphabetically(row)) return true;
  const items = rawValues(row).flatMap((value) => value.split(",")).map(sortKey).filter(Boolean);
  return items.length >= 3 && items.every((item, index) => index === 0 || items[index - 1]! <= item);
}

/** Géneros que la fila nombra, en el orden de la fuente, y los fragmentos que la taxonomía no reconoce. */
export function resolvedSlugs(taxonomy: Taxonomy, row: LedgerRow): { slugs: string[]; fragments: string[] } {
  const slugs: string[] = [];
  const fragments: string[] = [];
  const take = (value: string): void => {
    for (const item of resolveGenreValue(taxonomy, value).items) {
      if (item.kind !== "genre") { fragments.push(item.fragment); continue; }
      const slug = taxonomy.genres.get(item.genreId)?.slug;
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
  };
  for (const original of rawValues(row)) {
    // «Pop/Rock» es el pop rock, no una lista de dos géneros.
    const value = original.replace(/\bpop\s*\/\s*rock\b/giu, "pop rock");
    const before = slugs.length;
    const unresolvedBefore = fragments.length;
    take(value);
    // «Pop-Folk-Rock», «Rock: Psychedelic»: la taxonomía no parte por guion
    // (protege «pop-rock»); si el valor entero no resolvió, se lee como lista.
    if (slugs.length === before && /[-:]/u.test(value)) {
      fragments.length = unresolvedBefore;
      for (const piece of value.split(/\s*[-:]\s*/u).filter(Boolean)) take(piece);
    }
  }
  return { slugs, fragments };
}

/** Slugs de la fila en el orden en que se confirman, y los fragmentos que la taxonomía no reconoce. */
export function sourceSlugs(taxonomy: Taxonomy, row: LedgerRow): { slugs: string[]; fragments: string[] } {
  const { slugs, fragments } = resolvedSlugs(taxonomy, row);
  // «Rock, Alternative»: si la fuente nombra la familia y un hijo suyo, el
  // hijo toma el puesto de la familia. Confirmar ambos dejaría la familia
  // `superseded` por el hijo secundario y la ficha sin principal. Si el hijo
  // ya va antes que su familia, la familia solo sobra: el orden de la fuente
  // no se toca («black metal | ambient | metal» sigue con black metal primero).
  const idOf = (slug: string): number => [...taxonomy.genres.values()].find((g) => g.slug === slug)!.id;
  for (let index = 0; index < slugs.length; index += 1) {
    const childIndex = slugs.findIndex((other) => taxonomy.genres.get(idOf(other))?.parentId === idOf(slugs[index]!));
    if (childIndex < 0) continue;
    if (childIndex > index) slugs[index] = slugs[childIndex]!;
    slugs.splice(childIndex > index ? childIndex : index, 1);
    index = -1;
  }
  // Etiquetas en orden alfabético: el primero no es el principal. Van
  // antes los géneros concretos que las familias («Metal» o «Rock» sueltos).
  if (listedAlphabetically(row)) {
    const isFamily = (slug: string) => taxonomy.genres.get(idOf(slug))?.parentId === null;
    slugs.sort((a, b) => Number(isFamily(a)) - Number(isFamily(b)));
  }
  return { slugs, fragments };
}

export type ApplyOutcome =
  | { kind: "accepted"; raw: string[]; primary: string; secondaries: string[] }
  | { kind: "unresolved"; raw: string[]; fragments: string[] }
  | { kind: "moreSpecificExists"; raw: string[] };

/**
 * Confirma los géneros de la fila en su ficha a nombre de `auto:<fuente>`. El
 * que llama decide si la ficha puede recibirlos y envuelve la llamada en un
 * SAVEPOINT: un error deja la ficha a medias. `primary` elige el principal
 * entre los géneros de la fila (lista alfabética: lo decide Laya).
 */
export async function applySourceRow(client: PoolClient, taxonomy: Taxonomy, row: LedgerRow, runId: number, why = "regla: una fuente basta",
  primary?: string): Promise<ApplyOutcome> {
  const raw = rawValues(row);
  const { slugs, fragments } = sourceSlugs(taxonomy, row);
  if (!slugs.length) return { kind: "unresolved", raw, fragments };
  if (primary) {
    if (!slugs.includes(primary)) throw new Error(`${primary} no está entre los géneros de la fila`);
    slugs.splice(slugs.indexOf(primary), 1);
    slugs.unshift(primary);
  }
  // Una familia («Rock») cuyo hijo ya está en la ficha no se confirma: el
  // hijo es más preciso. Se usa el siguiente término de la fuente, si hay.
  const live = (await client.query<{ genre_id: string }>(
    `SELECT genre_id::text FROM ${GENRE_TABLE[row.kind]} WHERE ${GENRE_COLUMN[row.kind]}=$1 AND status IN ('confirmed','suggested')`,
    [row.entityId])).rows.map((r) => Number(r.genre_id));
  const usable = slugs.filter((slug) => {
    const id = [...taxonomy.genres.values()].find((g) => g.slug === slug)!.id;
    return !live.some((other) => other !== id && taxonomy.genres.get(other)?.parentId === id);
  });
  if (!usable.length) return { kind: "moreSpecificExists", raw };
  const actor = `auto:${row.source}`;
  const reason = `${row.source} nombra «${raw.join(" | ")}» en ${row.url ?? row.pages?.[0]?.url} (${why}; run ${runId})`;
  await confirmGenre(client, { kind: row.kind, entityId: row.entityId, genreSlug: usable[0]!, actor, reason, role: "primary", runId });
  const secondaries: string[] = [];
  for (const slug of usable.slice(1)) {
    await client.query("SAVEPOINT secundario");
    try {
      await confirmGenre(client, { kind: row.kind, entityId: row.entityId, genreSlug: slug, actor, reason, role: "secondary", runId });
      secondaries.push(slug);
      await client.query("RELEASE SAVEPOINT secundario");
    } catch {
      // Familia redundante con un hijo ya confirmado: se omite sin perder la ficha.
      await client.query("ROLLBACK TO SAVEPOINT secundario");
    }
  }
  return { kind: "accepted", raw, primary: usable[0]!, secondaries };
}
