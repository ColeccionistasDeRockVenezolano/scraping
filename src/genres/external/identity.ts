// CRV · Resolución de identidad contra una fuente externa (PLAN_GENEROS
// etapa 4, puntos 3 y 4).
//
// Funciones puras: reciben la ficha de CRV y los candidatos que devolvió la
// fuente, y deciden con qué identificador externo se corresponde —o que no hay
// con qué decidirlo—. Nada se escribe aquí.
//
//  * UNA COINCIDENCIA SOLO POR NOMBRE O TÍTULO NO BASTA. Cada señal suma por
//    separado y hace falta más de una, y al menos una que no sea el nombre.
//  * SE GUARDA CÓMO SE DECIDIÓ. `signals` es la explicación auditable de la
//    decisión: qué coincidió y cuánto pesó.
//  * EL EMPATE NO SE DESHACE SOLO. Dos candidatos igual de buenos son
//    `ambiguous` y van a revisión, nunca «el primero».
import { normalizeIdentity, normalizeIdentitySecondary } from "../../normalization/claims.js";

export type ExternalLevel = "artist" | "album";
export type MatchStatus = "matched" | "ambiguous" | "none";

export interface MatchSignal {
  name: string;
  weight: number;
  detail?: string;
}

/** Ficha de CRV que entra en la comparación (artista). */
export interface ArtistIdentityInput {
  name: string;
  /** Alias conocidos del artista en el catálogo. */
  aliases?: string[];
  /** Títulos de sus discos en CRV, para medir la discografía coincidente. */
  albumTitles?: string[];
  /** Personas asociadas (miembros) en CRV. */
  memberNames?: string[];
}

/** Ficha de CRV que entra en la comparación (álbum). */
export interface AlbumIdentityInput {
  title: string;
  year?: number | null;
  trackTitles?: string[];
  labelNames?: string[];
  catalogNumbers?: string[];
  /** Identificador externo del artista ya confirmado (obligatorio). */
  artistExternalId: string;
}

export interface ExternalCandidate {
  externalId: string;
  name: string;
  url?: string | null;
  disambiguation?: string | null;
  /** Artista: código de país ISO («VE») y área declarada. */
  country?: string | null;
  areaName?: string | null;
  beginYear?: number | null;
  /** Artista: títulos de su discografía en la fuente. */
  releaseTitles?: string[];
  memberNames?: string[];
  /** Álbum: identificador externo del artista al que cuelga. */
  artistExternalId?: string | null;
  year?: number | null;
  trackTitles?: string[];
  labelNames?: string[];
  catalogNumbers?: string[];
}

export interface MatchThresholds {
  /** Puntaje mínimo para aceptar la identidad sin intervención humana. */
  match: number;
  /** Por debajo de esto no se guarda nada: no es candidato. */
  ambiguous: number;
  /** Distancia mínima con el segundo candidato para no considerarlo empate. */
  margin: number;
}

// Regla de Brian del 2026-09-26 («una fuente basta»): la identidad se sigue
// exigiendo, pero no un puntaje alto. Basta el nombre más UNA prueba
// independiente (`blocked` lo garantiza: disco, miembro o país) y que ningún
// rival quede a menos de `margin`. Antes 0,85: Discogs no publica país, y el
// nombre exacto con un disco en común (0,6) nunca pasaba.
export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = { match: 0.6, ambiguous: 0.6, margin: 0.08 };

export interface ScoredCandidate {
  candidate: ExternalCandidate;
  score: number;
  signals: MatchSignal[];
  /** Falta alguna condición obligatoria (nombre, artista, señal independiente). */
  blocked: string | null;
}

export interface MatchOutcome {
  status: MatchStatus;
  best: ScoredCandidate | null;
  runnerUp: ScoredCandidate | null;
  reason: string;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Nombres comparables: primaria (exacta) y secundaria (sin tildes). */
function keys(value: string): { primary: string; secondary: string } {
  return { primary: normalizeIdentity(value), secondary: normalizeIdentitySecondary(value) };
}

function overlap(
  left: readonly string[], right: readonly string[], exclude?: string,
): { shared: number; ratio: number; examples: string[] } {
  const rightKeys = new Map(right.map((value) => [normalizeIdentitySecondary(value), value]));
  const examples: string[] = [];
  for (const value of left) {
    const key = normalizeIdentitySecondary(value);
    if (!key || key === exclude || !rightKeys.has(key)) continue;
    if (!examples.includes(value)) examples.push(value);
  }
  const denominator = Math.min(left.length, right.length) || 1;
  return { shared: examples.length, ratio: examples.length / denominator, examples: examples.slice(0, 5) };
}

function total(signals: MatchSignal[]): number {
  return round(Math.min(1, signals.reduce((sum, signal) => sum + signal.weight, 0)));
}

/**
 * Artista: nombre normalizado, origen, miembros y discografía coincidente.
 * Sin coincidencia de nombre no hay candidato; con solo el nombre, tampoco.
 */
export function scoreArtistCandidate(crv: ArtistIdentityInput, candidate: ExternalCandidate): ScoredCandidate {
  const signals: MatchSignal[] = [];
  const own = keys(crv.name);
  const other = keys(candidate.name);
  const aliasHit = (crv.aliases ?? []).find((alias) => normalizeIdentitySecondary(alias) === other.secondary);

  if (own.primary && own.primary === other.primary) {
    signals.push({ name: "name_exact", weight: 0.45, detail: candidate.name });
  } else if (own.secondary && own.secondary === other.secondary) {
    signals.push({ name: "name_normalized", weight: 0.4, detail: candidate.name });
  } else if (aliasHit) {
    signals.push({ name: "name_alias", weight: 0.35, detail: aliasHit });
  } else {
    return { candidate, score: 0, signals, blocked: "el nombre no coincide" };
  }

  if (candidate.country === "VE" || /venezuela/iu.test(candidate.areaName ?? "")) {
    signals.push({ name: "country_ve", weight: 0.25, detail: candidate.areaName ?? candidate.country ?? "VE" });
  }
  // La discografía pesa según cuántos títulos *distintos* coincidan, no según
  // una proporción: con dos discos en el catálogo, un solo acierto daba ratio
  // 0,5 y se cobraba como evidencia fuerte.
  //
  // El disco homónimo no cuenta: que «Almendra» tenga un disco «Almendra» es el
  // nombre otra vez, y el nombre ya se cobró en `name_exact`. Cobrarlo dos
  // veces empataba una coincidencia abrumadora (tres títulos) con otra que solo
  // repite el nombre de la banda, que es justo donde viven los homónimos.
  const discography = overlap(crv.albumTitles ?? [], candidate.releaseTitles ?? [], own.secondary);
  if (discography.shared >= 3) {
    signals.push({ name: "discography_strong", weight: 0.4, detail: `${discography.shared} títulos: ${discography.examples.join(" · ")}` });
  } else if (discography.shared === 2) {
    signals.push({ name: "discography_strong", weight: 0.3, detail: discography.examples.join(" · ") });
  } else if (discography.shared === 1) {
    signals.push({ name: "discography_partial", weight: 0.15, detail: discography.examples.join(" · ") });
  }
  const members = overlap(crv.memberNames ?? [], candidate.memberNames ?? []);
  if (members.shared >= 1) {
    signals.push({ name: "members", weight: members.shared >= 2 ? 0.2 : 0.12, detail: members.examples.join(" · ") });
  }

  const independent = signals.filter((signal) => !signal.name.startsWith("name_"));
  const blocked = independent.length === 0 ? "solo coincide el nombre" : null;
  return { candidate, score: total(signals), signals, blocked };
}

/**
 * Lanzamiento: el artista ya confirmado manda; encima, título, año, pistas y
 * sello o número de catálogo. El título solo nunca alcanza.
 */
export function scoreAlbumCandidate(crv: AlbumIdentityInput, candidate: ExternalCandidate): ScoredCandidate {
  const signals: MatchSignal[] = [];
  if (!candidate.artistExternalId || candidate.artistExternalId !== crv.artistExternalId) {
    return { candidate, score: 0, signals, blocked: "el lanzamiento no cuelga del artista confirmado" };
  }
  signals.push({ name: "artist_confirmed", weight: 0.4, detail: crv.artistExternalId });

  const own = keys(crv.title);
  const other = keys(candidate.name);
  if (own.primary && own.primary === other.primary) {
    signals.push({ name: "title_exact", weight: 0.3, detail: candidate.name });
  } else if (own.secondary && own.secondary === other.secondary) {
    signals.push({ name: "title_normalized", weight: 0.25, detail: candidate.name });
  } else {
    return { candidate, score: 0, signals, blocked: "el título no coincide" };
  }

  const year = crv.year ?? null;
  if (year !== null && candidate.year !== null && candidate.year !== undefined) {
    const distance = Math.abs(candidate.year - year);
    if (distance === 0) signals.push({ name: "year_exact", weight: 0.2, detail: String(candidate.year) });
    else if (distance === 1) signals.push({ name: "year_close", weight: 0.1, detail: String(candidate.year) });
    else signals.push({ name: "year_differs", weight: -0.15, detail: `${year} vs ${candidate.year}` });
  }
  const tracks = overlap(crv.trackTitles ?? [], candidate.trackTitles ?? []);
  if (tracks.ratio >= 0.6 && tracks.shared >= 3) {
    signals.push({ name: "tracklist_strong", weight: 0.25, detail: `${tracks.shared} pistas` });
  } else if (tracks.shared >= 2) {
    signals.push({ name: "tracklist_partial", weight: 0.12, detail: `${tracks.shared} pistas` });
  }
  const labels = overlap(crv.labelNames ?? [], candidate.labelNames ?? []);
  if (labels.shared >= 1) signals.push({ name: "label", weight: 0.1, detail: labels.examples.join(" · ") });
  const catalog = overlap(crv.catalogNumbers ?? [], candidate.catalogNumbers ?? []);
  if (catalog.shared >= 1) signals.push({ name: "catalog_number", weight: 0.12, detail: catalog.examples.join(" · ") });

  // El artista y el título son la misma afirmación «es este disco de esta
  // banda»: hace falta algo más (año, pistas, sello o catálogo).
  const corroboration = signals.filter((signal) => signal.weight > 0
    && !signal.name.startsWith("title_") && signal.name !== "artist_confirmed");
  const blocked = corroboration.length === 0 ? "solo coinciden artista y título" : null;
  return { candidate, score: total(signals), signals, blocked };
}

/** Elige entre los candidatos puntuados; el empate no se deshace solo. */
export function decideMatch(
  scored: ScoredCandidate[], thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS,
): MatchOutcome {
  // Orden estable: puntaje y, a igualdad, identificador externo.
  const viable = [...scored].sort((a, b) => b.score - a.score || a.candidate.externalId.localeCompare(b.candidate.externalId));
  const best = viable[0] ?? null;
  const runnerUp = viable[1] ?? null;
  if (!best || best.score < thresholds.ambiguous) {
    return { status: "none", best: null, runnerUp: null, reason: best ? `ningún candidato llega a ${thresholds.ambiguous}` : "la fuente no devolvió candidatos" };
  }
  if (best.blocked) return { status: "ambiguous", best, runnerUp, reason: best.blocked };
  if (best.score < thresholds.match) {
    return { status: "ambiguous", best, runnerUp, reason: `coincidencia débil (${best.score} < ${thresholds.match})` };
  }
  if (runnerUp && !runnerUp.blocked && best.score - runnerUp.score < thresholds.margin) {
    return { status: "ambiguous", best, runnerUp, reason: `dos candidatos casi iguales (${best.score} y ${runnerUp.score})` };
  }
  return { status: "matched", best, runnerUp, reason: best.signals.map((signal) => signal.name).join(" + ") };
}

export function resolveArtistIdentity(
  crv: ArtistIdentityInput, candidates: ExternalCandidate[], thresholds?: MatchThresholds,
): MatchOutcome {
  return decideMatch(candidates.map((candidate) => scoreArtistCandidate(crv, candidate)), thresholds);
}

export function resolveAlbumIdentity(
  crv: AlbumIdentityInput, candidates: ExternalCandidate[], thresholds?: MatchThresholds,
): MatchOutcome {
  return decideMatch(candidates.map((candidate) => scoreAlbumCandidate(crv, candidate)), thresholds);
}
