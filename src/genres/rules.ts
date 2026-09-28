// CRV · Reglas deterministas de asignación de géneros (PLAN_GENEROS §4
// «Reglas para elegir el principal» y «Prioridad de las decisiones humanas»).
//
// Funciones puras: reciben la evidencia (claims de género de UNA entidad y de
// UN nivel) y la taxonomía, y devuelven las filas `rule` que deberían existir
// y los casos que necesitan a una persona. Mismos datos → mismo resultado:
// nada depende del orden de llegada ni de la captura «más reciente», y el
// rango de la fuente nunca desempata estilos.
import { normalizeGenreText } from "./normalize.js";
import { familyOf, isFamilyOf, resolveGenreValue, type Taxonomy, type ValueResolution } from "./taxonomy.js";

export type GenreEntityKind = "artist" | "album";
export type AssignmentStatus = "suggested" | "confirmed" | "rejected" | "superseded";
export type AssignmentRole = "primary" | "secondary";
export type AssignmentConfidence = "high" | "medium" | "low";
export type SourceKind = "catalog_source" | "editorial" | "external" | "ai";

export type DecisionRule =
  | "explicit_source_alias"
  | "source_list_order"
  | "sources_agree"
  | "partial_source_agreement"
  | "sources_disagree"
  | "family_superseded_by_child";

/** Un claim `genre` de la entidad, con lo que hace falta para citarlo. */
export interface GenreClaimEvidence {
  claimId: number;
  sourceId: number;
  sourceSlug: string;
  sourceKind: SourceKind;
  rawValue: string;
  url?: string | null;
  excerpt?: string | null;
}

export interface EvidenceRef {
  claimId: number;
  sourceSlug: string;
  rawValue: string;
  url?: string | null;
  excerpt?: string | null;
}

export interface DesiredAssignment {
  genreId: number;
  role: AssignmentRole;
  status: AssignmentStatus;
  confidence: AssignmentConfidence;
  sourceKind: SourceKind;
  sourceId: number;
  claimIds: number[];
  rawValue: string;
  evidence: EvidenceRef[];
  decisionRule: DecisionRule;
  /** Solo en `superseded`: el género que lo reemplaza (se traduce a fila al escribir). */
  supersededByGenreId?: number;
}

export type GenreCaseKind =
  | "unknown_value"
  | "compound_value"
  | "source_disagreement"
  | "primary_disagreement"
  | "human_contradiction";

export interface GenreCase {
  genreCase: GenreCaseKind;
  /** Identidad estable del caso: repetir el cálculo no duplica revisiones. */
  fingerprint: string;
  claimIds: number[];
  detail: Record<string, unknown>;
}

export interface RuleOutcome {
  assignments: DesiredAssignment[];
  cases: GenreCase[];
  /** Hay evidencia con géneros resueltos pero ningún principal automático. */
  primaryPending: boolean;
}

/** Una «unidad» de evidencia: una fuente y un valor normalizado (§4 «varias capturas»). */
interface EvidenceUnit {
  key: string;
  sourceId: number;
  sourceSlug: string;
  sourceKind: SourceKind;
  rawValue: string;
  claims: GenreClaimEvidence[];
  resolution: ValueResolution;
  /** Géneros de la unidad en orden, tras ceder cada familia a su hijo. */
  genres: number[];
  /** familia → hijo que la reemplaza dentro de la unidad. */
  supersededInUnit: Map<number, number>;
  /** Principal de la unidad; `pending` si el primer tramo no resolvió. */
  primary: number | "pending";
}

function evidenceRefs(claims: GenreClaimEvidence[]): EvidenceRef[] {
  return claims.map((claim) => ({
    claimId: claim.claimId, sourceSlug: claim.sourceSlug, rawValue: claim.rawValue,
    ...(claim.url ? { url: claim.url } : {}), ...(claim.excerpt ? { excerpt: claim.excerpt } : {}),
  }));
}

/** Primer hijo de `familyId` presente en `genres`, por orden. */
function firstChild(taxonomy: Taxonomy, familyId: number, genres: Iterable<number>): number | undefined {
  for (const genreId of genres) if (isFamilyOf(taxonomy, familyId, genreId)) return genreId;
  return undefined;
}

function buildUnits(taxonomy: Taxonomy, claims: GenreClaimEvidence[]): EvidenceUnit[] {
  const grouped = new Map<string, GenreClaimEvidence[]>();
  // Orden estable: por fuente y por claim, no por llegada a la función.
  const ordered = [...claims].sort((a, b) => a.sourceId - b.sourceId || a.claimId - b.claimId);
  for (const claim of ordered) {
    const key = `${claim.sourceId}:${normalizeGenreText(claim.rawValue)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), claim]);
  }
  const units: EvidenceUnit[] = [];
  for (const [key, members] of grouped) {
    const first = members[0]!;
    const resolution = resolveGenreValue(taxonomy, first.rawValue);
    const listed = resolution.items.flatMap((item) => (item.kind === "genre" ? [item.genreId] : []));
    const supersededInUnit = new Map<number, number>();
    for (const genreId of listed) {
      const child = firstChild(taxonomy, genreId, listed);
      if (child !== undefined) supersededInUnit.set(genreId, child);
    }
    // La familia cede su lugar (también el de principal) al hijo: «Rock,
    // Alternative Rock» describe un disco de rock alternativo.
    const genres: number[] = [];
    for (const genreId of listed) {
      const effective = supersededInUnit.get(genreId) ?? genreId;
      if (!genres.includes(effective)) genres.push(effective);
    }
    const firstItem = resolution.items[0];
    const primary: number | "pending" = firstItem?.kind === "genre"
      ? supersededInUnit.get(firstItem.genreId) ?? firstItem.genreId
      : "pending";
    units.push({
      key, sourceId: first.sourceId, sourceSlug: first.sourceSlug, sourceKind: first.sourceKind,
      rawValue: first.rawValue, claims: members, resolution, genres, supersededInUnit, primary,
    });
  }
  return units;
}

function unresolvedCase(unit: EvidenceUnit, primaryPending: boolean): GenreCase {
  const unresolved = unit.resolution.items.flatMap((item) => (item.kind === "unresolved" ? [item.fragment] : []));
  const compound = unit.resolution.isList || unit.resolution.hyphenCompound;
  return {
    genreCase: compound ? "compound_value" : "unknown_value",
    fingerprint: `${compound ? "compound" : "unknown"}:${unit.key}`,
    claimIds: unit.claims.map((claim) => claim.claimId),
    detail: { sourceSlug: unit.sourceSlug, rawValue: unit.rawValue, unresolved, primaryPending },
  };
}

/**
 * Filas `rule` y casos de revisión para una entidad (reglas 1–7 del §4).
 * No mira decisiones humanas: eso lo hace `reconcileWithHuman`.
 */
export function computeRuleAssignments(taxonomy: Taxonomy, claims: GenreClaimEvidence[]): RuleOutcome {
  const units = buildUnits(taxonomy, claims).filter((unit) => unit.resolution.items.length > 0);
  const cases: GenreCase[] = [];
  const resolvedUnits = units.filter((unit) => unit.genres.length > 0);
  const pendingUnits = units.filter((unit) => unit.primary === "pending");

  if (resolvedUnits.length === 0) {
    for (const unit of units) cases.push(unresolvedCase(unit, true));
    return { assignments: [], cases, primaryPending: false };
  }

  // Entre unidades, una familia también cede ante su hijo (regla 4, par a par).
  const allGenres: number[] = [];
  for (const unit of resolvedUnits) for (const genreId of unit.genres) if (!allGenres.includes(genreId)) allGenres.push(genreId);
  const unitPrimaries = resolvedUnits.flatMap((unit) => (unit.primary === "pending" ? [] : [unit.primary]));
  const crossSuperseded = new Map<number, number>();
  for (const genreId of allGenres) {
    // El hijo que reemplaza es el principal de alguna fuente, si lo hay; si no, el primero.
    const child = firstChild(taxonomy, genreId, unitPrimaries) ?? firstChild(taxonomy, genreId, allGenres);
    if (child !== undefined) crossSuperseded.set(genreId, child);
  }
  const mapped = (genreId: number) => crossSuperseded.get(genreId) ?? genreId;
  const unitSets = resolvedUnits.map((unit) => new Set(unit.genres.map(mapped)));
  const finalGenres = allGenres.filter((genreId) => !crossSuperseded.has(genreId));
  const presence = (genreId: number) => unitSets.filter((set) => set.has(genreId)).length;
  const multiSource = resolvedUnits.length > 1;
  const shared = finalGenres.some((genreId) => presence(genreId) > 1);

  for (const unit of units) {
    if (unit.resolution.items.some((item) => item.kind === "unresolved")) cases.push(unresolvedCase(unit, unit.primary === "pending"));
  }

  // La evidencia de una fila es la de las fuentes que nombran ESE género: una
  // fuente que solo dijo la familia respalda la fila de la familia, no la del hijo.
  const unitsWith = (genreId: number) => resolvedUnits.filter((unit) => unit.genres.includes(genreId));
  const evidenceOf = (selected: EvidenceUnit[]) => {
    const claimsOf = selected.flatMap((unit) => unit.claims);
    const first = selected[0]!;
    return {
      sourceKind: first.sourceKind, sourceId: first.sourceId, rawValue: first.rawValue,
      claimIds: [...new Set(claimsOf.map((claim) => claim.claimId))].sort((a, b) => a - b),
      evidence: evidenceRefs(claimsOf),
    };
  };

  const assignments: DesiredAssignment[] = [];
  let primaryPending = false;

  if (multiSource && !shared) {
    // Regla 6: ninguna coincidencia ni parentesco entre fuentes → todo sugerido.
    for (const genreId of finalGenres) {
      assignments.push({ genreId, role: "secondary", status: "suggested", confidence: "low", decisionRule: "sources_disagree", ...evidenceOf(unitsWith(genreId)) });
    }
    primaryPending = true;
    cases.push({
      genreCase: "source_disagreement",
      fingerprint: `disagreement:${resolvedUnits.map((unit) => unit.key).sort().join("|")}`,
      claimIds: resolvedUnits.flatMap((unit) => unit.claims.map((claim) => claim.claimId)).sort((a, b) => a - b),
      detail: { units: resolvedUnits.map((unit) => ({ sourceSlug: unit.sourceSlug, rawValue: unit.rawValue })) },
    });
  } else {
    // Reglas 1–5 y 7: todo lo resuelto se confirma; el principal solo si las
    // fuentes coinciden y ninguna empieza por un valor sin resolver.
    const primaries = new Set(units.map((unit) => (unit.primary === "pending" ? "pending" : mapped(unit.primary))));
    const primary = pendingUnits.length === 0 && primaries.size === 1 ? [...primaries][0] as number : undefined;
    if (primary === undefined) {
      primaryPending = true;
      if (pendingUnits.length === 0) {
        cases.push({
          genreCase: "primary_disagreement",
          fingerprint: `primary:${resolvedUnits.map((unit) => unit.key).sort().join("|")}`,
          claimIds: resolvedUnits.flatMap((unit) => unit.claims.map((claim) => claim.claimId)).sort((a, b) => a - b),
          detail: {
            units: resolvedUnits.map((unit) => ({ sourceSlug: unit.sourceSlug, rawValue: unit.rawValue, primaryGenreId: unit.primary })),
          },
        });
      }
    }
    for (const genreId of finalGenres) {
      const inAll = presence(genreId) === resolvedUnits.length;
      const single = !multiSource;
      const decisionRule: DecisionRule = single
        ? (resolvedUnits[0]!.resolution.isList ? "source_list_order" : "explicit_source_alias")
        : inAll ? "sources_agree" : "partial_source_agreement";
      assignments.push({
        genreId, role: genreId === primary ? "primary" : "secondary", status: "confirmed",
        confidence: single || inAll ? "high" : "medium", decisionRule, ...evidenceOf(unitsWith(genreId)),
      });
    }
  }

  // La familia desplazada no se pierde: queda `superseded` con su evidencia.
  for (const unit of resolvedUnits) for (const [familyId, childId] of unit.supersededInUnit) crossSuperseded.set(familyId, crossSuperseded.get(familyId) ?? childId);
  for (const [familyId, childId] of crossSuperseded) {
    if (finalGenres.includes(familyId)) continue;
    const target = crossSuperseded.get(childId) ?? childId;
    assignments.push({
      genreId: familyId, role: "secondary", status: "superseded", confidence: "high",
      decisionRule: "family_superseded_by_child", supersededByGenreId: target,
      ...evidenceOf(resolvedUnits.filter((unit) => unit.supersededInUnit.has(familyId) || unit.genres.includes(familyId)
        || unit.resolution.items.some((item) => item.kind === "genre" && item.genreId === familyId))),
    });
  }

  assignments.sort((a, b) => a.genreId - b.genreId);
  cases.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return { assignments, cases, primaryPending };
}

/** Fila humana existente, la única parte que las reglas necesitan leer. */
export interface HumanAssignment {
  id: number;
  genreId: number;
  role: AssignmentRole;
  status: AssignmentStatus;
  decidedBy: string;
}

export interface Reconciled {
  assignments: DesiredAssignment[];
  cases: GenreCase[];
  /** Evidencia nueva que coincide con una decisión humana: se añade, sin aviso. */
  evidenceForHuman: Array<{ humanId: number; claimIds: number[]; evidence: EvidenceRef[] }>;
}

/**
 * Aplica la prioridad humana (§4): ninguna fila `human` cambia. Lo que la
 * contradice se convierte en aviso; lo que coincide, en evidencia adicional.
 */
export function reconcileWithHuman(taxonomy: Taxonomy, outcome: RuleOutcome, human: HumanAssignment[]): Reconciled {
  const evidenceForHuman: Reconciled["evidenceForHuman"] = [];
  if (human.length === 0) return { assignments: outcome.assignments, cases: [...outcome.cases], evidenceForHuman };

  const byGenre = new Map(human.map((row) => [row.genreId, row]));
  const humanPrimary = human.find((row) => row.role === "primary" && row.status === "confirmed");
  // Con un principal decidido por una persona, el desacuerdo entre fuentes ya
  // tiene respuesta (etapa 3): no vuelve a pedir revisión. Si llega evidencia
  // que contradice esa decisión, el aviso sale abajo como `primary_differs`.
  const cases = outcome.cases.filter((item) => !humanPrimary
    || (item.genreCase !== "source_disagreement" && item.genreCase !== "primary_disagreement"));
  const live = (row: HumanAssignment) => row.status === "confirmed" || row.status === "suggested";
  const warn = (kind: string, genreId: number, row: HumanAssignment | undefined, claimIds: number[]) => {
    cases.push({
      genreCase: "human_contradiction",
      fingerprint: `human:${kind}:${genreId}:${row?.id ?? "none"}`,
      claimIds,
      detail: { kind, genreId, humanAssignmentId: row?.id ?? null, decidedBy: row?.decidedBy ?? null },
    });
  };

  const kept: DesiredAssignment[] = [];
  for (const desired of outcome.assignments) {
    const row = byGenre.get(desired.genreId);
    if (row) {
      if (row.status === "rejected" && (desired.status === "confirmed" || desired.status === "suggested")) {
        warn("rejected_genre_has_new_evidence", desired.genreId, row, desired.claimIds);
      } else if (row.status !== "rejected") {
        evidenceForHuman.push({ humanId: row.id, claimIds: desired.claimIds, evidence: desired.evidence });
      }
      continue;
    }
    // Un hijo con evidencia no puede desplazar a una familia que una persona confirmó.
    const humanFamily = human.find((item) => live(item) && isFamilyOf(taxonomy, item.genreId, desired.genreId));
    if (humanFamily && desired.status !== "superseded") {
      warn("more_specific_than_human_family", desired.genreId, humanFamily, desired.claimIds);
      continue;
    }
    kept.push(desired);
  }

  const desiredPrimary = outcome.assignments.find((item) => item.role === "primary");
  if (humanPrimary) {
    for (const item of kept) if (item.role === "primary") item.role = "secondary";
    if (desiredPrimary && desiredPrimary.genreId !== humanPrimary.genreId
      && familyOf(taxonomy, desiredPrimary.genreId)?.id !== humanPrimary.genreId) {
      warn("primary_differs", desiredPrimary.genreId, humanPrimary, desiredPrimary.claimIds);
    }
  }

  // Un `superseded` necesita a quien lo reemplaza entre las filas que quedan.
  const present = new Set([...kept.map((item) => item.genreId), ...human.filter(live).map((row) => row.genreId)]);
  const assignments = kept.filter((item) => item.status !== "superseded" || present.has(item.supersededByGenreId!));
  cases.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return { assignments, cases, evidenceForHuman };
}
