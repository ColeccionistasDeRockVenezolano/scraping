// Piloto local de Laya: prepara opciones respaldadas por evidencia del mismo
// nivel. No escribe asignaciones ni convierte una probabilidad en confirmación.
import { normalizeGenreText } from "./normalize.js";
import type { TagPolicy, ExternalTagKind } from "./external/mapping.js";
import { resolveGenreValue, type GenreNode, type Taxonomy } from "./taxonomy.js";
import type { GenreEntityKind } from "./rules.js";

export const LAYA_PILOT_SCHEMA = "crv-genre-laya-pilot.v1";
export const LAYA_ABSTAIN = "evidencia_insuficiente";

export interface PilotEvidence {
  ref: string;
  kind: "genre_claim" | "genre_source_snapshot" | "external_suggestion" | "biography_claim";
  source: string;
  text: string;
  url: string | null;
}

export interface PilotCandidate {
  slug: string;
  name: string;
  level: "family" | "genre";
  family: string | null;
  evidenceRefs: string[];
}

export interface PilotCase {
  schemaVersion: typeof LAYA_PILOT_SCHEMA;
  caseId: string;
  kind: GenreEntityKind;
  entityId: number;
  title: string;
  categories: string[];
  evidence: PilotEvidence[];
  candidates: PilotCandidate[];
}

export interface PilotSource {
  claimId: number;
  /** Evidencia extraída y cotejada de un snapshot; no finge ser un claim de DB. */
  ref?: string;
  level: GenreEntityKind;
  status: string;
  rawValue: string;
  sourceSlug: string;
  evidence: Array<{ url?: string | null; excerpt?: string | null }>;
}

export interface PilotAssignment {
  id: number;
  genre: { slug: string; active: boolean } | null;
  role: "primary" | "secondary";
  status: string;
  sourceKind: string;
  rawValue: string | null;
  evidence: Array<{ url?: string | null; sourceSlug?: string | null; externalId?: string | null;
    tagKind?: ExternalTagKind; tagCount?: number | null }>;
}

export interface PilotExternalIdentity {
  sourceSlug: string;
  externalId: string;
  status: string;
}

export interface PilotBiography {
  claimId: number;
  sourceSlug: string;
  text: string;
  url: string | null;
}

function trigrams(text: string): Set<string> {
  const padded = `  ${normalizeGenreText(text)} `;
  const values = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) values.add(padded.slice(i, i + 3));
  return values;
}

function similarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return a.size + b.size ? (2 * common) / (a.size + b.size) : 0;
}

function fuzzyGenres(taxonomy: Taxonomy, fragment: string): GenreNode[] {
  const key = normalizeGenreText(fragment);
  if (key.length < 4 || key.length > 80) return [];
  const best = new Map<number, number>();
  for (const [alias, target] of taxonomy.aliases) {
    if (target.kind !== "genre") continue;
    const node = taxonomy.genres.get(target.genreId);
    if (!node?.active) continue;
    const score = similarity(key, alias);
    if (score >= 0.72 && score > (best.get(node.id) ?? 0)) best.set(node.id, score);
  }
  return [...best].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 3).map(([id]) => taxonomy.genres.get(id)!);
}

function mentionsGenre(taxonomy: Taxonomy, text: string, allowParts = false): GenreNode[] {
  const folded = ` ${normalizeGenreText(text)} `;
  const words = new Set(folded.match(/[\p{L}\p{N}]+/gu) ?? []);
  const found = new Map<number, GenreNode>();
  for (const [alias, target] of taxonomy.aliases) {
    if (target.kind !== "genre" || alias.length < (allowParts ? 3 : 4)) continue;
    const node = taxonomy.genres.get(target.genreId);
    const aliasWords = alias.split(" ");
    const appears = folded.includes(` ${alias} `)
      || (allowParts && aliasWords.length > 1 && aliasWords.every((word) => words.has(word)));
    if (node?.active && appears) found.set(node.id, node);
  }
  return [...found.values()];
}

export function buildLayaPilotCase(input: {
  kind: GenreEntityKind;
  entityId: number;
  title: string;
  categories: string[];
  sources: PilotSource[];
  assignments: PilotAssignment[];
  biographies?: PilotBiography[];
  externalIdentities?: PilotExternalIdentity[];
  externalPolicies?: ReadonlyMap<string, TagPolicy>;
  allowConfirmedForEvaluation?: boolean;
  taxonomy: Taxonomy;
}): PilotCase | null {
  const { kind, entityId, title, categories, sources, assignments, biographies = [],
    externalIdentities = [], externalPolicies, allowConfirmedForEvaluation = false, taxonomy } = input;
  if (kind === "artist" && ["various artists", "varios artistas"].includes(normalizeGenreText(title))) return null;
  if (!allowConfirmedForEvaluation && assignments.some((row) => row.status === "confirmed" && row.role === "primary" && row.genre)) return null;
  const evidence = new Map<string, PilotEvidence>();
  const candidates = new Map<string, PilotCandidate>();
  const add = (node: GenreNode, ref: string) => {
    if (!node.active) return;
    const family = node.level === "family" ? node : node.parentId === null ? undefined : taxonomy.genres.get(node.parentId);
    const candidate = candidates.get(node.slug) ?? {
      slug: node.slug, name: node.name, level: node.level, family: family?.slug ?? null, evidenceRefs: [],
    };
    if (!candidate.evidenceRefs.includes(ref)) candidate.evidenceRefs.push(ref);
    candidates.set(node.slug, candidate);
  };

  for (const source of sources) {
    if (source.level !== kind || !["accepted", "conflict"].includes(source.status) || !source.rawValue.trim()) continue;
    const resolution = resolveGenreValue(taxonomy, source.rawValue);
    const resolved = resolution.items.filter((item) => item.kind === "genre");
    const unresolved = resolution.items.filter((item) => item.kind === "unresolved");
    if (!resolved.length && !unresolved.length) continue; // no-género aprobado
    const ref = source.ref ?? `claim:${source.claimId}`;
    evidence.set(ref, {
      ref, kind: source.ref ? "genre_source_snapshot" : "genre_claim",
      source: source.sourceSlug, text: source.rawValue.slice(0, 1200),
      url: source.evidence[0]?.url ?? null,
    });
    for (const item of resolved) {
      const node = taxonomy.genres.get(item.genreId);
      if (node) add(node, ref);
    }
    for (const item of unresolved) for (const node of fuzzyGenres(taxonomy, item.fragment)) add(node, ref);
    // Un compuesto se mantiene íntegro en las reglas; aquí sus palabras solo
    // amplían las opciones que una persona podrá comparar en el piloto.
    for (const node of mentionsGenre(taxonomy, source.rawValue, true)) add(node, ref);
  }

  for (const row of assignments) {
    if (row.status !== "suggested" || row.sourceKind !== "external" || !row.genre?.active) continue;
    const sourceSlug = row.evidence[0]?.sourceSlug ?? "";
    const policy = externalPolicies?.get(sourceSlug);
    if (externalPolicies && !policy) continue;
    if (externalPolicies && !externalIdentities.some((identity) => identity.sourceSlug === sourceSlug
      && identity.externalId === row.evidence[0]?.externalId && identity.status === "matched")) continue;
    const raw = normalizeGenreText(row.rawValue ?? "");
    if (policy && (policy.ignore.includes(raw) || policy.buckets[raw])) continue;
    const tagKind = row.evidence[0]?.tagKind;
    if (policy && (!tagKind || !policy.acceptKinds.includes(tagKind))) continue;
    if (policy && tagKind === "community_tag" && (row.evidence[0]?.tagCount ?? 0) < policy.minTagCount) continue;
    const node = taxonomy.bySlug.get(row.genre.slug);
    if (!node?.active || !row.rawValue?.trim()) continue;
    const ref = `assignment:${row.id}`;
    evidence.set(ref, {
      ref, kind: "external_suggestion", source: sourceSlug,
      text: row.rawValue.slice(0, 1200), url: row.evidence[0]?.url ?? null,
    });
    add(node, ref);
  }

  if (kind === "artist") for (const biography of biographies) {
    if (!biography.text.trim()) continue;
    const nodes = mentionsGenre(taxonomy, biography.text);
    if (!nodes.length) continue;
    const ref = `claim:${biography.claimId}`;
    evidence.set(ref, {
      ref, kind: "biography_claim", source: biography.sourceSlug,
      text: biography.text.slice(0, 1800), url: biography.url,
    });
    for (const node of nodes) add(node, ref);
  };

  const ranked = [...candidates.values()].sort((a, b) =>
    b.evidenceRefs.length - a.evidenceRefs.length || Number(b.level === "genre") - Number(a.level === "genre")
    || a.slug.localeCompare(b.slug));
  if (!ranked.length) return null;
  const selected = ranked.slice(0, 8);
  const usedRefs = new Set(selected.flatMap((item) => item.evidenceRefs));
  return {
    schemaVersion: LAYA_PILOT_SCHEMA, caseId: `${kind}:${entityId}`, kind, entityId, title,
    categories: [...new Set(categories)].sort(),
    evidence: [...evidence.values()].filter((item) => usedRefs.has(item.ref)),
    candidates: selected,
  };
}
