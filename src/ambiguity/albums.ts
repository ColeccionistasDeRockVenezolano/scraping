// E10 · Pares de discos del mismo artista que comparten pistas en la misma
// posición pero que la fusión estricta (`crv review duplicates`) no toca.
//
// El orden de las reglas importa y va de lo más concreto a lo más blando:
//  1. Separaciones con evidencia: el canal publica los dos, uno marca otra
//     edición, uno es recopilatorio o directo de canciones que el otro trae
//     de estudio, o las listas de pistas divergen más de lo que coinciden.
//  2. ¿Hay evidencia de que es el mismo lanzamiento? Títulos relacionados y
//     cobertura de pistas; sin ella, NEEDS_HUMAN.
//  3. Siendo el mismo lanzamiento, una contradicción (año a un año de
//     distancia, una pista distinta) es CONFLICT: fusionar exige elegir.
//  4. Solo lo que queda limpio es MATCH_HIGH_CONFIDENCE.
import { FactSheet, downgrade, question, support, type QuestionOutcome } from "./types.js";
import { isGenericTitle, titleRelation, trackTitlesEquivalent, wordKey, type TitleRelation } from "./text.js";

export interface AlbumTrack { id: number; disc: number; number: number; title: string; }
export interface AlbumSide {
  id: number; artistId: number; artistName: string; title: string; year: number | null; type: string;
  classifications: string[]; tracks: AlbumTrack[]; primaryVideoId: string | null; sources: string[];
}
export interface AlbumPairInput { reviewId: number; a: AlbumSide; b: AlbumSide; }

const EDITION = /\b(re|reissue|reedicion|re edicion|remaster|remastered|remasterizado|remasterizada|aniversario|anniversary|deluxe|edicion especial|special edition|new edition|expanded|2 0)\b/u;
const COMPILATION = /\b(exitos|lo mejor|grandes|antologia|anthology|recopilatorio|compilado|coleccion|collection|best of|greatest|hits|serie|singles|rarezas|lo maximo)\b/u;
const YEAR_RANGE = /\b(19|20)\d{2}\s*[-–—]\s*((19|20)\d{2}|\d{2})\b/u;
const LIVE = /\b(en vivo|vivo|live|directo|concierto|bootleg|unplugged)\b/u;

const STUDIO_TYPES = new Set(["studio_album", "ep", "single"]);
function typeGroup(type: string): string | null {
  if (STUDIO_TYPES.has(type)) return "studio";
  return type === "other" ? null : type;
}
const hasEdition = (album: AlbumSide): boolean => EDITION.test(wordKey(album.title));
const isCompilation = (album: AlbumSide): boolean =>
  album.type === "compilation" || album.classifications.some((item) => /compilation/iu.test(item)) || COMPILATION.test(wordKey(album.title)) || YEAR_RANGE.test(album.title);
const DEMO = /\b(demo|demos|maqueta|maquetas)\b/u;
const isDemo = (album: AlbumSide): boolean => album.type === "demo" || album.classifications.some((item) => /demo/iu.test(item)) || DEMO.test(wordKey(album.title));
const isLive = (album: AlbumSide): boolean =>
  album.type === "live_album" || album.classifications.some((item) => /live/iu.test(item)) || LIVE.test(wordKey(album.title));

function label(album: AlbumSide): string {
  return `«${album.title}»${album.year ? ` (${album.year})` : " (sin año)"}`;
}

/** El que queda en una fusión: el del canal (la verdad del proyecto), el tipado, el más completo. */
export function chooseKeepAlbum(a: AlbumSide, b: AlbumSide): [AlbumSide, AlbumSide] {
  const titleInformation = (album: AlbumSide): number => wordKey(album.title).replaceAll(" ", "").length;
  const score = (album: AlbumSide): number[] => [
    album.primaryVideoId ? 1 : 0,
    album.type === "other" ? 0 : 1,
    album.tracks.length,
    titleInformation(album),
    -album.id,
  ];
  const [sa, sb] = [score(a), score(b)];
  for (let index = 0; index < sa.length; index += 1) {
    if (sa[index] !== sb[index]) return sa[index]! > sb[index]! ? [a, b] : [b, a];
  }
  return [a, b];
}

export interface TrackComparison { common: number; same: number; different: Array<{ position: string; a: string; b: string }>; }

export function compareTracklists(a: AlbumTrack[], b: AlbumTrack[]): TrackComparison {
  const byPosition = new Map(b.map((track) => [`${track.disc}.${track.number}`, track]));
  const result: TrackComparison = { common: 0, same: 0, different: [] };
  for (const track of a) {
    const other = byPosition.get(`${track.disc}.${track.number}`);
    if (!other) continue;
    result.common += 1;
    if (trackTitlesEquivalent(track.title, other.title)) result.same += 1;
    else result.different.push({ position: `${track.disc}.${track.number}`, a: track.title, b: other.title });
  }
  return result;
}

const RELATION_TEXT: Readonly<Record<TitleRelation, string>> = {
  equal: "los títulos son el mismo (salvo tildes, signos, artículo, números escritos o el nombre del artista delante)",
  contains: "un título contiene al otro",
  fuzzy: "los títulos difieren en una errata",
  generic: "uno de los títulos es genérico (Demo, EP, En Vivo, el nombre del artista) y no identifica el disco",
  unrelated: "los títulos no tienen relación textual",
};

export function analyzeAlbumPair(input: AlbumPairInput): QuestionOutcome {
  const { a, b } = input;
  const sheet = new FactSheet();
  const describe = (album: AlbumSide): string => sheet.add(`album:${album.id}`,
    `${label(album)} de ${album.artistName}: tipo ${album.type}${album.classifications.length ? ` (${album.classifications.join(", ")})` : ""}, `
    + `${album.tracks.length} pistas, fuentes ${album.sources.join(", ") || "ninguna"}, `
    + `${album.primaryVideoId ? `video primario ${album.primaryVideoId} en el canal` : "sin video en el canal"}`);
  const factA = describe(a); const factB = describe(b);
  const [keep, drop] = chooseKeepAlbum(a, b);
  const mergeTarget = { action: "merge_albums" as const, keepId: keep.id, dropId: drop.id, keepTitle: keep.title, dropTitle: drop.title };
  const base = {
    questionKey: "pair",
    question: `¿${label(a)} (${a.id}) y ${label(b)} (${b.id}) son el mismo disco de ${a.artistName}?`,
    options: [{ key: "same", label: `fusionar ${drop.id} en ${keep.id} (${label(keep)})`, target: mergeTarget }],
  };

  const relation = titleRelation(a.title, b.title, a.artistName);
  const tracks = compareTracklists(a.tracks, b.tracks);
  const minSize = Math.min(a.tracks.length, b.tracks.length); const maxSize = Math.max(a.tracks.length, b.tracks.length);
  const titleFact = sheet.add(`album:${a.id}.title|album:${b.id}.title`, `${RELATION_TEXT[relation]}: «${a.title}» / «${b.title}»`);
  const coverageFact = sheet.add(`tracks:album:${a.id}|album:${b.id}`,
    `${tracks.same} de ${tracks.common} posiciones comunes tienen la misma pista (${a.tracks.length} y ${b.tracks.length} pistas)`);
  const differentFacts = tracks.different.slice(0, 6).map((item) =>
    sheet.add(`tracks:album:${a.id}|album:${b.id}@${item.position}`, `posición ${item.position}: «${item.a}» / «${item.b}»`));
  const yearFact = sheet.add(`album:${a.id}.release_year|album:${b.id}.release_year`, `años: ${a.year ?? "sin año"} / ${b.year ?? "sin año"}`);

  // 1 · Separaciones con evidencia.
  if (a.primaryVideoId && b.primaryVideoId && a.primaryVideoId !== b.primaryVideoId) {
    return question({ ...base, decision: "KEEP_SEPARATE", rule: "album.both_on_channel",
      reasoning: "el canal publica los dos como discos distintos, cada uno con su video; el canal es la verdad del proyecto",
      facts: sheet.facts, evidence: [support(factA, "separate"), support(factB, "separate"), support(coverageFact, "context")], target: null, aiEligible: false });
  }
  if (hasEdition(a) !== hasEdition(b)) {
    const edition = hasEdition(a) ? a : b;
    const editionFact = sheet.add(`album:${edition.id}.title`, `«${edition.title}» marca una edición distinta (reedición, remasterización, aniversario, 2.0)`);
    return question({ ...base, decision: "KEEP_SEPARATE", rule: "album.distinct_edition",
      reasoning: "uno de los títulos declara otra edición del disco; el catálogo guarda las ediciones como fichas propias",
      facts: sheet.facts, evidence: [support(editionFact, "separate"), support(titleFact, "context")], target: null, aiEligible: false });
  }
  // Un título genérico tampoco identifica: «1988 – 1996» frente a una demo es un recopilatorio.
  if ((relation === "unrelated" || relation === "generic") && isCompilation(a) !== isCompilation(b)) {
    const compilation = isCompilation(a) ? a : b;
    const compilationFact = sheet.add(`album:${compilation.id}`, `«${compilation.title}» es un recopilatorio (por tipo, clasificación o título) y el otro no`);
    return question({ ...base, decision: "KEEP_SEPARATE", rule: "album.compilation_vs_original",
      reasoning: "un recopilatorio repite pistas de discos anteriores; compartir posiciones no lo convierte en el mismo disco",
      facts: sheet.facts, evidence: [support(compilationFact, "separate"), support(titleFact, "separate")], target: null, aiEligible: false });
  }
  if (relation === "unrelated" && isLive(a) !== isLive(b) && (STUDIO_TYPES.has(a.type) || STUDIO_TYPES.has(b.type))) {
    const live = isLive(a) ? a : b;
    const liveFact = sheet.add(`album:${live.id}`, `«${live.title}» es un directo y el otro un disco de estudio`);
    return question({ ...base, decision: "KEEP_SEPARATE", rule: "album.live_vs_studio",
      reasoning: "un directo repite canciones de un disco de estudio con otra grabación",
      facts: sheet.facts, evidence: [support(liveFact, "separate"), support(titleFact, "separate")], target: null, aiEligible: false });
  }
  if (relation === "unrelated" && tracks.different.length > tracks.same) {
    return question({ ...base, decision: "KEEP_SEPARATE", rule: "album.tracklists_diverge",
      reasoning: `títulos sin relación y ${tracks.different.length} posiciones con pistas distintas frente a ${tracks.same} iguales`,
      facts: sheet.facts, evidence: [support(titleFact, "separate"), support(coverageFact, "separate"), ...differentFacts.slice(0, 2).map((id) => support(id, "separate"))], target: null, aiEligible: false });
  }

  // 2 · ¿Mismo lanzamiento?
  const coverage = minSize ? tracks.same / minSize : 0;
  const sameRelease = relation === "generic"
    ? maxSize > 0 && tracks.same >= 0.8 * maxSize
    : relation !== "unrelated" && coverage >= 0.8;
  if (!sameRelease) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "album.no_same_release_evidence",
      reasoning: relation === "unrelated"
        ? `comparten ${tracks.same} pistas en la misma posición pero los títulos no se relacionan; ninguna regla determinista distingue un disco reeditado con otro nombre de dos lanzamientos distintos`
        : `los títulos se relacionan pero las pistas comunes no bastan (${tracks.same} de ${relation === "generic" ? maxSize : minSize})`,
      facts: sheet.facts, evidence: [support(titleFact, "context"), support(coverageFact, "context")], target: null,
      aiEligible: tracks.same >= 3 });
  }
  if (isDemo(a) !== isDemo(b) && a.tracks.length !== b.tracks.length) {
    const demo = isDemo(a) ? a : b;
    const demoFact = sheet.add(`album:${demo.id}`, `«${demo.title}» es una demo (${demo.tracks.length} pistas) y el otro no (${(demo === a ? b : a).tracks.length} pistas)`);
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "album.demo_vs_release",
      reasoning: "las demos de un disco comparten canciones y orden con él, pero son otra grabación; con distinto número de pistas no se afirma que sean el mismo lanzamiento",
      facts: sheet.facts, evidence: [support(demoFact, "context"), support(coverageFact, "context")], target: null, aiEligible: true });
  }
  const groupA = typeGroup(a.type); const groupB = typeGroup(b.type);
  if (groupA && groupB && groupA !== groupB) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "album.type_mismatch",
      reasoning: `parecen el mismo lanzamiento, pero uno es ${a.type} y el otro ${b.type}`,
      facts: sheet.facts, evidence: [support(factA, "context"), support(factB, "context"), support(coverageFact, "match")], target: null, aiEligible: true });
  }
  const yearGap = a.year !== null && b.year !== null ? Math.abs(a.year - b.year) : null;
  if (yearGap !== null && yearGap >= 2) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "album.years_far_apart",
      reasoning: `mismo título y mismas pistas pero ${yearGap} años de diferencia: puede ser una reedición o un error de año`,
      facts: sheet.facts, evidence: [support(yearFact, "context"), support(coverageFact, "match"), support(titleFact, "match")], target: null, aiEligible: true });
  }

  // 3 · Mismo lanzamiento con contradicciones.
  if (yearGap === 1) {
    return question({ ...base, decision: "CONFLICT", rule: "album.year_conflict",
      reasoning: `todo indica el mismo disco, pero las fuentes dan ${a.year} y ${b.year}: fusionar exige elegir el año`,
      facts: sheet.facts, evidence: [support(yearFact, "conflict"), support(titleFact, "match"), support(coverageFact, "match")], target: null, aiEligible: false });
  }
  if (tracks.different.length > 0) {
    return question({ ...base, decision: "CONFLICT", rule: "album.tracklist_conflict",
      reasoning: `todo indica el mismo disco, pero ${tracks.different.length} posición(es) tienen pistas distintas: fusionar exige elegir cuál es la correcta`,
      facts: sheet.facts, evidence: [...differentFacts.map((id) => support(id, "conflict")), support(titleFact, "match"), support(coverageFact, "match")], target: null, aiEligible: false });
  }

  // 4 · Limpio.
  const genericNote = relation === "generic" && isGenericTitle(a.title, a.artistName) && isGenericTitle(b.title, a.artistName) ? " (los dos títulos son genéricos)" : "";
  return question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule: "album.same_release",
    reasoning: `${RELATION_TEXT[relation]}${genericNote}, ${tracks.same} pistas iguales en la misma posición, ninguna distinta y ${yearGap === 0 ? "el mismo año" : "sin años contradictorios"}`,
    facts: sheet.facts, evidence: [support(titleFact, "match"), support(coverageFact, "match"), support(yearFact, yearGap === 0 ? "match" : "context")],
    target: mergeTarget, aiEligible: false });
}

/**
 * Un disco que es candidato en varios pares no se fusiona solo: si una de sus
 * otras parejas no está descartada, hay más de un candidato plausible.
 */
export function guardAlbumClusters(results: Array<{ input: AlbumPairInput; outcome: QuestionOutcome }>): Array<{ input: AlbumPairInput; outcome: QuestionOutcome }> {
  return results.map((item) => {
    if (item.outcome.decision !== "MATCH_HIGH_CONFIDENCE") return item;
    const ids = [item.input.a.id, item.input.b.id];
    const rival = results.find((other) => other !== item && other.outcome.decision !== "KEEP_SEPARATE"
      && (ids.includes(other.input.a.id) || ids.includes(other.input.b.id)));
    if (!rival) return item;
    return {
      ...item,
      outcome: downgrade(item.outcome, "album.competing_pairs",
        `uno de los discos también es candidato en la revisión #${rival.input.reviewId} (${rival.outcome.decision}); con dos candidatos plausibles decide una persona`,
        { ref: `review:${rival.input.reviewId}`, text: `la revisión #${rival.input.reviewId} empareja «${rival.input.a.title}» (${rival.input.a.id}) con «${rival.input.b.title}» (${rival.input.b.id}) y no está descartada` }),
    };
  });
}
