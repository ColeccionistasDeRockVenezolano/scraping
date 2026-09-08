import { normalizeEntityName } from "../normalization/entity-name.js";
import {
  DEFAULT_RESOLUTION_THRESHOLDS,
  resolutionThresholdsSchema,
  type CandidateScore,
  type ResolutionAction,
  type ResolutionCandidate,
  type ResolutionDecision,
  type ResolutionInput,
  type ResolutionThresholds,
  type ScoreFeature,
  type YearRange,
} from "./types.js";

function round(value: number): number { return Math.round(value * 100_000) / 100_000; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function feature(
  key: string,
  label: string,
  value: number,
  weight: number,
  evidence: string,
  polarity: ScoreFeature["polarity"] = "for",
): ScoreFeature {
  const magnitude = Math.max(0, Math.min(1, value));
  const contribution = polarity === "against" ? -(magnitude * weight) : polarity === "neutral" ? 0 : magnitude * weight;
  return { key, label, value: round(magnitude), weight, contribution: round(contribution), polarity, evidence };
}

/** Jaro-Winkler se usa solo como senal; jamas habilita merge por si sola. */
export function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatches = new Array<boolean>(left.length).fill(false);
  const rightMatches = new Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, right.length);
    for (let j = start; j < end; j += 1) {
      if (rightMatches[j] || left[i] !== right[j]) continue;
      leftMatches[i] = true; rightMatches[j] = true; matches += 1; break;
    }
  }
  if (!matches) return 0;
  const leftOrdered = [...left].filter((_, index) => leftMatches[index]);
  const rightOrdered = [...right].filter((_, index) => rightMatches[index]);
  let transpositions = 0;
  for (let index = 0; index < leftOrdered.length; index += 1) {
    if (leftOrdered[index] !== rightOrdered[index]) transpositions += 1;
  }
  const m = matches;
  const jaro = (m / left.length + m / right.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && left[prefix] !== undefined && left[prefix] === right[prefix]) prefix += 1;
  return round(jaro + prefix * 0.1 * (1 - jaro));
}

function normalizedValues(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((item) => normalizeEntityName(item).secondaryKey).filter(Boolean));
}

function overlap(left: string[] | undefined, right: string[] | undefined): { score: number; common: string[] } | null {
  if (!left?.length || !right?.length) return null;
  const a = normalizedValues(left); const b = normalizedValues(right);
  const common = [...a].filter((item) => b.has(item));
  const union = new Set([...a, ...b]);
  return { score: union.size ? common.length / union.size : 0, common };
}

function yearOverlap(left: YearRange | undefined, right: YearRange | undefined): number | null {
  if (!left || !right || (left.from === undefined && left.to === undefined) || (right.from === undefined && right.to === undefined)) return null;
  const aFrom = left.from ?? left.to ?? 0; const aTo = left.to ?? left.from ?? 9999;
  const bFrom = right.from ?? right.to ?? 0; const bTo = right.to ?? right.from ?? 9999;
  if (aTo < bFrom || bTo < aFrom) return 0;
  return 1;
}

type NameBasis = CandidateScore["nameBasis"];
interface NameComparison { basis: NameBasis; similarity: number; evidence: string; aliasLowConfidence: boolean; }

function allAliases(candidate: ResolutionCandidate): Array<{ value: string; confidence?: "high" | "medium" | "low" }> {
  const aliases = [...(candidate.aliases ?? [])];
  if (candidate.kind === "PERSON") {
    for (const nickname of candidate.nicknames ?? []) aliases.push({ value: nickname, confidence: "medium" });
  }
  return aliases;
}

function compareName(input: ResolutionInput, candidate: ResolutionCandidate): NameComparison {
  const incoming = normalizeEntityName(input.name);
  const canonical = normalizeEntityName(candidate.canonicalName);
  if (incoming.primaryKey === canonical.primaryKey) {
    return { basis: "canonical_exact", similarity: 1, evidence: `clave primaria exacta: ${incoming.primaryKey}`, aliasLowConfidence: false };
  }
  for (const alias of allAliases(candidate)) {
    const normalized = normalizeEntityName(alias.value);
    if (incoming.primaryKey === normalized.primaryKey) {
      return { basis: "alias_exact", similarity: 1, evidence: `alias ${alias.value} (${alias.confidence ?? "medium"})`, aliasLowConfidence: alias.confidence === "low" };
    }
  }
  for (const alias of input.aliases ?? []) {
    const normalized = normalizeEntityName(alias.value);
    if (normalized.primaryKey === canonical.primaryKey || allAliases(candidate).some((candidateAlias) => normalizeEntityName(candidateAlias.value).primaryKey === normalized.primaryKey)) {
      return { basis: "alias_exact", similarity: 1, evidence: `alias declarado ${alias.value} (${alias.type ?? "other"})`, aliasLowConfidence: alias.confidence === "low" };
    }
  }
  if (incoming.articlelessPrimaryKey && incoming.articlelessPrimaryKey === canonical.articlelessPrimaryKey) {
    return { basis: "article_variant", similarity: 0.92, evidence: `variante previsible de articulo: ${incoming.articlelessPrimaryKey}`, aliasLowConfidence: false };
  }
  if (incoming.compactPrimaryKey && incoming.compactPrimaryKey === canonical.compactPrimaryKey) {
    return { basis: "article_variant", similarity: 0.9, evidence: "diferencia previsible de separadores/puntuacion", aliasLowConfidence: false };
  }
  if (incoming.secondaryKey && incoming.secondaryKey === canonical.secondaryKey) {
    return { basis: "accent_only", similarity: 0.86, evidence: "solo coincide la clave secundaria sin tildes", aliasLowConfidence: false };
  }
  for (const alias of allAliases(candidate)) {
    const normalized = normalizeEntityName(alias.value);
    if (incoming.secondaryKey === normalized.secondaryKey) {
      return { basis: "accent_only", similarity: 0.84, evidence: `coincidencia secundaria sin tildes con alias ${alias.value}`, aliasLowConfidence: alias.confidence === "low" };
    }
  }
  const similarity = jaroWinkler(incoming.secondaryKey, canonical.secondaryKey);
  return similarity >= 0.76
    ? { basis: "fuzzy", similarity, evidence: `Jaro-Winkler=${similarity.toFixed(3)} (senal no decisiva)`, aliasLowConfidence: false }
    : { basis: "none", similarity, evidence: `sin coincidencia nominal suficiente (${similarity.toFixed(3)})`, aliasLowConfidence: false };
}

function nameWeight(kind: ResolutionInput["kind"], basis: NameBasis): number {
  const identity = kind === "ALBUM" ? 0.48 : kind === "TRACK" ? 0.3 : 0.62;
  if (basis === "alias_exact") return identity + 0.04;
  if (basis === "article_variant") return kind === "TRACK" ? 0.28 : 0.58;
  if (basis === "accent_only") return kind === "TRACK" ? 0.3 : 0.6;
  if (basis === "fuzzy") return kind === "TRACK" ? 0.28 : 0.58;
  if (basis === "canonical_exact") return identity;
  return 0;
}

function parentComparison(
  input: { id?: number; name?: string; artistName?: string } | undefined,
  candidate: { id?: number; name?: string; artistName?: string } | undefined,
): { match: number | null; hardConflict?: string; evidence: string } {
  if (!input || !candidate) return { match: null, evidence: "parent desconocido" };
  if (input.id !== undefined && candidate.id !== undefined) {
    return input.id === candidate.id
      ? { match: 1, evidence: `parent_id=${input.id}` }
      : { match: 0, hardConflict: `parent_id distinto (${input.id} != ${candidate.id})`, evidence: "IDs parentales contradictorios" };
  }
  const inputName = input.name ?? input.artistName; const candidateName = candidate.name ?? candidate.artistName;
  if (!inputName || !candidateName) return { match: null, evidence: "nombre parental incompleto" };
  const a = normalizeEntityName(inputName); const b = normalizeEntityName(candidateName);
  if (a.primaryKey === b.primaryKey) return { match: 1, evidence: `parent exacto: ${candidateName}` };
  if (a.secondaryKey === b.secondaryKey) return { match: 0.65, evidence: `parent coincide solo sin tildes: ${candidateName}` };
  return { match: 0, hardConflict: `parent distinto (${inputName} != ${candidateName})`, evidence: "nombres parentales contradictorios" };
}

function addListFeature(features: ScoreFeature[], key: string, label: string, left: string[] | undefined, right: string[] | undefined, weight: number): number {
  const compared = overlap(left, right);
  if (!compared) return 0;
  features.push(feature(key, label, compared.score, weight, compared.common.length ? `coinciden: ${compared.common.join(", ")}` : "sin elementos comunes", compared.score ? "for" : "against"));
  return compared.score * weight;
}

export function scoreCandidate(input: ResolutionInput, candidate: ResolutionCandidate): CandidateScore {
  if (input.kind !== candidate.kind) throw new Error(`tipos incompatibles: ${input.kind}/${candidate.kind}`);
  const features: ScoreFeature[] = [];
  const hardConflicts: string[] = [];
  const comparedName = compareName(input, candidate);
  const nWeight = nameWeight(input.kind, comparedName.basis);
  features.push(feature(`name.${comparedName.basis}`, "identidad nominal", comparedName.similarity, nWeight, comparedName.evidence, comparedName.basis === "none" ? "against" : "for"));
  let contextContribution = 0;
  let contextSignals = 0;

  if (input.kind === "ARTIST" && candidate.kind === "ARTIST") {
    const years = yearOverlap(input.activeYears, candidate.activeYears);
    if (years !== null) {
      features.push(feature("artist.active_years", "anos de actividad", 1, years ? 0.1 : 0.14, years ? "periodos compatibles" : "periodos sin solapamiento", years ? "for" : "against"));
      contextContribution += years ? 0.1 : -0.14; contextSignals += years ? 1 : 0;
    }
    for (const part of ["country", "city"] as const) {
      const left = input.origin?.[part]; const right = candidate.origin?.[part];
      if (!left || !right) continue;
      const same = normalizeEntityName(left).secondaryKey === normalizeEntityName(right).secondaryKey;
      const weight = part === "country" ? 0.12 : 0.07;
      features.push(feature(`artist.origin_${part}`, `origen (${part})`, 1, weight, `${left} / ${right}`, same ? "for" : "against"));
      contextContribution += same ? weight : -weight;
      if (same) contextSignals += 1;
      else if (part === "country") hardConflicts.push(`origen nacional distinto (${left} != ${right})`);
    }
    contextContribution += addListFeature(features, "artist.members", "miembros", input.members, candidate.members, 0.14);
    contextContribution += addListFeature(features, "artist.discography", "discografia", input.discography, candidate.discography, 0.14);
    contextSignals += features.filter((item) => (item.key === "artist.members" || item.key === "artist.discography") && item.contribution > 0).length;
  }

  if (input.kind === "PERSON" && candidate.kind === "PERSON") {
    const bands = addListFeature(features, "person.bands", "bandas", input.bands, candidate.bands, 0.2);
    const instruments = addListFeature(features, "person.instruments", "instrumentos", input.instruments, candidate.instruments, 0.08);
    const roles = addListFeature(features, "person.roles", "roles", input.roles, candidate.roles, 0.08);
    const credits = addListFeature(features, "person.album_credits", "creditos de album", input.albumCredits, candidate.albumCredits, 0.14);
    contextContribution += bands + instruments + roles + credits;
    contextSignals += [bands, instruments, roles, credits].filter((item) => item > 0).length;
    const period = yearOverlap(input.period, candidate.period);
    if (period !== null) {
      features.push(feature("person.period", "periodo", 1, period ? 0.07 : 0.05, period ? "periodos compatibles" : "periodos distintos", period ? "for" : "against"));
      contextContribution += period ? 0.07 : -0.05; contextSignals += period ? 1 : 0;
    }
    if ((comparedName.basis === "canonical_exact" || comparedName.basis === "alias_exact") && contextSignals > 0) {
      features.push(feature("person.composite_identity", "nombre/alias + trayectoria", 1, 0.16, "al menos una banda, funcion, periodo o credito coincide", "for"));
      contextContribution += 0.16;
    } else if ((comparedName.basis === "accent_only" || comparedName.basis === "fuzzy") && contextSignals >= 2) {
      features.push(feature("person.secondary_name_plus_context", "nombre secundario + trayectoria", 1, 0.12, "la senal nominal debil esta corroborada por multiples atributos", "for"));
      contextContribution += 0.12;
    }
  }

  if (input.kind === "ALBUM" && candidate.kind === "ALBUM") {
    const parent = parentComparison(input.artist, candidate.artist);
    if (parent.match !== null) {
      features.push(feature("album.artist", "artista del lanzamiento", parent.match, 0.28, parent.evidence, parent.match ? "for" : "against"));
      contextContribution += parent.match ? parent.match * 0.28 : -0.28;
      if (parent.match > 0.8) contextSignals += 2;
      if (parent.hardConflict) hardConflicts.push(parent.hardConflict);
    }
    if (input.year !== undefined && candidate.year !== undefined) {
      const difference = Math.abs(input.year - candidate.year);
      const same = difference === 0;
      features.push(feature("album.year", "ano", 1, same ? 0.1 : 0.16, `${input.year} / ${candidate.year}`, same ? "for" : "against"));
      contextContribution += same ? 0.1 : -0.16; contextSignals += same ? 1 : 0;
      if (difference > 1) hardConflicts.push(`anos contradictorios (${input.year} != ${candidate.year})`);
    }
    if (input.releaseType && candidate.releaseType) {
      const same = normalizeEntityName(input.releaseType).secondaryKey === normalizeEntityName(candidate.releaseType).secondaryKey;
      features.push(feature("album.release_type", "tipo de lanzamiento", 1, 0.07, `${input.releaseType} / ${candidate.releaseType}`, same ? "for" : "against"));
      contextContribution += same ? 0.07 : -0.07; contextSignals += same ? 1 : 0;
    }
    const tracks = addListFeature(features, "album.tracklist", "tracklist", input.tracklist, candidate.tracklist, 0.12);
    contextContribution += tracks; contextSignals += tracks > 0 ? 1 : 0;
    if ((comparedName.basis === "canonical_exact" || comparedName.basis === "alias_exact") && parent.match === 1) {
      features.push(feature("album.composite_identity", "artista + titulo", 1, 0.2, "clave compuesta determinista", "for"));
      contextContribution += 0.2; contextSignals += 1;
    }
  }

  if (input.kind === "TRACK" && candidate.kind === "TRACK") {
    const parent = parentComparison(input.album, candidate.album);
    if (parent.match !== null) {
      features.push(feature("track.album", "album", parent.match, 0.35, parent.evidence, parent.match ? "for" : "against"));
      contextContribution += parent.match ? parent.match * 0.35 : -0.35;
      if (parent.match > 0.8) contextSignals += 2;
      if (parent.hardConflict) hardConflicts.push(parent.hardConflict);
    }
    for (const [key, left, right, weight] of [
      ["disc", input.disc, candidate.disc, 0.15],
      ["track_number", input.trackNumber, candidate.trackNumber, 0.2],
    ] as const) {
      if (left === undefined || right === undefined) continue;
      const same = left === right;
      features.push(feature(`track.${key}`, key === "disc" ? "disco" : "numero de pista", 1, weight, `${left} / ${right}`, same ? "for" : "against"));
      contextContribution += same ? weight : -weight; contextSignals += same ? 1 : 0;
      if (!same && parent.match === 1) hardConflicts.push(`${key} distinto dentro del mismo album (${left} != ${right})`);
    }
    if (parent.match === 1 && input.disc !== undefined && input.disc === candidate.disc && input.trackNumber !== undefined && input.trackNumber === candidate.trackNumber) {
      features.push(feature("track.composite_position", "album + disco + pista", 1, 0.18, "posicion canonica exacta", "for"));
      contextContribution += 0.18; contextSignals += 2;
    }
  }

  if (input.kind === "ORGANIZATION" && candidate.kind === "ORGANIZATION") {
    if (input.organizationType && candidate.organizationType) {
      const same = normalizeEntityName(input.organizationType).secondaryKey === normalizeEntityName(candidate.organizationType).secondaryKey;
      features.push(feature("organization.type", "tipo", 1, 0.11, `${input.organizationType} / ${candidate.organizationType}`, same ? "for" : "against"));
      contextContribution += same ? 0.11 : -0.11; contextSignals += same ? 1 : 0;
    }
    for (const part of ["country", "city"] as const) {
      const left = input.location?.[part]; const right = candidate.location?.[part];
      if (!left || !right) continue;
      const same = normalizeEntityName(left).secondaryKey === normalizeEntityName(right).secondaryKey;
      const weight = part === "country" ? 0.12 : 0.07;
      features.push(feature(`organization.location_${part}`, `ubicacion (${part})`, 1, weight, `${left} / ${right}`, same ? "for" : "against"));
      contextContribution += same ? weight : -weight; contextSignals += same ? 1 : 0;
    }
    const albums = addListFeature(features, "organization.albums", "albums asociados", input.associatedAlbums, candidate.associatedAlbums, 0.13);
    const people = addListFeature(features, "organization.persons", "personas asociadas", input.associatedPersons, candidate.associatedPersons, 0.13);
    contextContribution += albums + people; contextSignals += [albums, people].filter((item) => item > 0).length;
    if ((comparedName.basis === "canonical_exact" || comparedName.basis === "alias_exact") && contextSignals > 0) {
      features.push(feature("organization.composite_identity", "nombre + contexto", 1, 0.16, "al menos un atributo organizacional coincide", "for"));
      contextContribution += 0.16;
    }
  }

  if (comparedName.basis === "canonical_exact" && (input.kind === "PERSON" || input.kind === "ORGANIZATION") && contextSignals === 0) {
    features.push(feature("identity.homonym_guard", "guarda de homonimos", 1, 0.12, "nombre exacto sin contexto: candidato, no auto-merge", "for"));
    contextContribution += 0.12;
  }
  if (comparedName.aliasLowConfidence) {
    features.push(feature("identity.low_confidence_alias", "alias de baja confianza", 1, 0.18, "un alias low nunca autoriza merge", "against"));
    contextContribution -= 0.18;
  }

  const rawScore = features.reduce((total, item) => total + item.contribution, 0);
  const hasContextSupport = contextContribution > 0.04 && contextSignals > 0;
  let autoEligible = !hardConflicts.length && !comparedName.aliasLowConfidence;
  if (input.kind === "ARTIST") autoEligible &&= comparedName.basis === "canonical_exact" || comparedName.basis === "alias_exact" || hasContextSupport;
  if (input.kind === "PERSON") autoEligible &&= ((comparedName.basis === "canonical_exact" || comparedName.basis === "alias_exact") && contextSignals > 0)
    || ((comparedName.basis === "accent_only" || comparedName.basis === "fuzzy") && contextSignals >= 2);
  if (input.kind === "ALBUM") autoEligible &&= contextSignals >= 3 && comparedName.basis !== "none";
  if (input.kind === "TRACK") autoEligible &&= contextSignals >= 5 && comparedName.basis !== "none";
  if (input.kind === "ORGANIZATION") autoEligible &&= (comparedName.basis === "canonical_exact" || comparedName.basis === "alias_exact") && contextSignals > 0;

  return {
    candidateId: candidate.id,
    canonicalName: candidate.canonicalName,
    score: round(clamp(rawScore)),
    action: "NO_MATCH",
    features,
    hardConflicts,
    nameBasis: comparedName.basis,
    hasContextSupport,
    autoEligible,
  };
}

function category(score: number, thresholds: ResolutionThresholds): ResolutionAction {
  if (score >= thresholds.AUTO_MATCH) return "AUTO_MATCH";
  if (score >= thresholds.POSSIBLE_MATCH) return "POSSIBLE_MATCH";
  if (score >= thresholds.REVIEW) return "REVIEW";
  return "NO_MATCH";
}

function finalizeCandidate(item: CandidateScore, thresholds: ResolutionThresholds): CandidateScore {
  let action = category(item.score, thresholds);
  if (action === "AUTO_MATCH" && !item.autoEligible) action = "POSSIBLE_MATCH";
  if (!item.hasContextSupport && ["fuzzy", "accent_only", "article_variant"].includes(item.nameBasis)) {
    action = item.score >= thresholds.REVIEW ? "REVIEW" : "NO_MATCH";
  }
  if (item.hardConflicts.length) {
    action = item.nameBasis === "canonical_exact" || item.nameBasis === "alias_exact" ? "REVIEW" : "NO_MATCH";
  }
  return { ...item, action };
}

function addUniqueIdentityAnchor(item: CandidateScore, exactCount: number, kind: ResolutionInput["kind"]): CandidateScore {
  if (kind !== "ARTIST" || exactCount !== 1 || (item.nameBasis !== "canonical_exact" && item.nameBasis !== "alias_exact") || item.hardConflicts.length) return item;
  const anchor = feature("artist.unique_exact_identity", "identidad exacta unica", 1, item.nameBasis === "canonical_exact" ? 0.32 : 0.27, "un solo artista coincide exactamente por canonical/alias", "for");
  return { ...item, score: round(clamp(item.score + anchor.contribution)), features: [...item.features, anchor], autoEligible: true };
}

export function resolveEntityDeterministically(
  input: ResolutionInput,
  candidates: ResolutionCandidate[],
  thresholdInput: ResolutionThresholds = DEFAULT_RESOLUTION_THRESHOLDS,
): ResolutionDecision {
  const thresholds = resolutionThresholdsSchema.parse(thresholdInput);
  const sameKind = candidates.filter((candidate) => candidate.kind === input.kind);
  const provisional = sameKind.map((candidate) => scoreCandidate(input, candidate));
  const exactCount = provisional.filter((item) => item.nameBasis === "canonical_exact" || item.nameBasis === "alias_exact").length;
  const scored = provisional
    .map((item) => finalizeCandidate(addUniqueIdentityAnchor(item, exactCount, input.kind), thresholds))
    .sort((left, right) => right.score - left.score || left.candidateId - right.candidateId);
  const top = scored[0]; const second = scored[1];
  if (!top || top.action === "NO_MATCH") {
    const noCandidateFeature = feature(
      "candidate_pool.empty",
      "conjunto de candidatos",
      1,
      0,
      "no existen candidatos del mismo tipo; score determinista 0",
      "neutral",
    );
    return {
      kind: input.kind,
      inputOriginal: input.name,
      inputNormalized: normalizeEntityName(input.name).primaryKey,
      action: "NO_MATCH",
      score: top?.score ?? 0,
      features: top?.features ?? [noCandidateFeature],
      candidates: scored,
      thresholds,
      explanation: top ? "ningun candidato supera las reglas minimas sin contradicciones" : "no existen candidatos del mismo tipo",
      deterministic: true,
    };
  }
  let action = top.action;
  let explanation = `mejor candidato ${top.candidateId}: ${top.nameBasis}, score ${top.score.toFixed(3)}`;
  if (second && second.score >= thresholds.REVIEW && top.score - second.score < thresholds.minimumMargin) {
    action = "REVIEW";
    explanation = `ambiguedad: margen ${(top.score - second.score).toFixed(3)} menor que ${thresholds.minimumMargin.toFixed(3)}`;
  }
  const candidateId = top.candidateId;
  return {
    kind: input.kind,
    inputOriginal: input.name,
    inputNormalized: normalizeEntityName(input.name).primaryKey,
    action,
    score: top.score,
    candidateId,
    features: top.features,
    candidates: scored,
    thresholds,
    explanation,
    deterministic: true,
  };
}
