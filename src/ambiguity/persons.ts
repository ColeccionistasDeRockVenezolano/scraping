// E10 · Personas con grafías distintas («José Manuel "Chema" Arria» / «José
// Manuel Arria "Chema"» / «J. M. Arria»).
//
// El parecido del nombre nunca basta. Un par entra a la cola solo si comparte
// contexto (una banda por membresía o crédito) y se fusiona solo si ese
// contexto es fuerte y no hay otro candidato plausible: una inicial que encaja
// con dos personas del catálogo, o un nombre sin apodo que puede ser cualquiera
// de dos apodados distintos, quedan para una persona.
import { FactSheet, question, support, type QuestionOutcome } from "./types.js";
import { nicknameCompatibility, parsePersonName, personRelation, type ParsedPerson, type PersonRelation } from "./text.js";

export interface PersonSide {
  id: number; name: string; nationality: string | null; birthDate: string | null; deathDate: string | null;
  artists: Array<{ id: number; name: string }>;
  albums: Array<{ id: number; title: string; artistName: string; creditTypes: string[] }>;
  /** Acreditado por la descripción de un video del canal. */
  channelCredited: boolean;
  references: number;
}
export interface PriorDecision { reviewId: number; verdict: "same" | "different"; decidedBy: string; }
export interface PersonPairInput {
  reviewId: number; a: PersonSide; b: PersonSide; prior: PriorDecision[];
  competitors: { a: Array<{ id: number; name: string }>; b: Array<{ id: number; name: string }> };
}

const RELATION_TEXT: Readonly<Record<PersonRelation, string>> = {
  nickname_variant: "el mismo nombre; solo cambian el apodo, su posición o las tildes",
  extra_given_name: "el mismo nombre con un segundo nombre de más",
  initials: "un nombre escrito con iniciales del otro",
  surname_typo: "el mismo nombre con una errata en el apellido",
  given_typo: "nombres de pila distintos por pocas letras",
  nickname_surname: "mismo apodo y apellido con nombres de pila distintos",
  fuzzy: "nombres parecidos sin una variación reconocible",
};

const STRONG_NAME: ReadonlySet<PersonRelation> = new Set(["nickname_variant", "extra_given_name"]);

export interface IndexedPerson { id: number; name: string; parsed: ParsedPerson; }
export type PersonIndex = Map<string, IndexedPerson[]>;

export function buildPersonIndex(persons: Array<{ id: number; name: string }>): PersonIndex {
  const index: PersonIndex = new Map();
  for (const person of persons) {
    const parsed = parsePersonName(person.name);
    const last = parsed.tokens.at(-1);
    if (!last) continue;
    index.set(last, [...(index.get(last) ?? []), { ...person, parsed }]);
  }
  return index;
}

/**
 * Otras personas del catálogo que podrían ser `x` en lugar de `y`. Compite
 * quien comparte contexto con `x` bajo una variante fuerte del nombre, y
 * siempre —con o sin contexto— quien hace ambigua una forma con pérdida: una
 * inicial que encaja con otro nombre completo, o un nombre sin apodo que
 * encaja con un apodo que contradice el de `y`.
 */
export function findCompetitors(x: IndexedPerson, y: IndexedPerson, index: PersonIndex, context: Map<number, Set<number>>): IndexedPerson[] {
  const pool = index.get(x.parsed.tokens.at(-1) ?? "") ?? [];
  const xContext = context.get(x.id) ?? new Set<number>();
  const out: IndexedPerson[] = [];
  for (const z of pool) {
    if (z.id === x.id || z.id === y.id || z.parsed.compound) continue;
    const relation = personRelation(x.parsed, z.parsed);
    if (relation !== "nickname_variant" && relation !== "extra_given_name" && relation !== "initials") continue;
    const zAsY = personRelation(z.parsed, y.parsed);
    if ((zAsY === "nickname_variant" || zAsY === "extra_given_name") && nicknameCompatibility(z.parsed, y.parsed) !== "conflict") continue;
    const shares = [...(context.get(z.id) ?? [])].some((artist) => xContext.has(artist));
    const xIsInitials = relation === "initials" && x.parsed.tokens.slice(0, -1).some((token) => token.length === 1);
    const nicknameAmbiguous = !x.parsed.nicknames.length && z.parsed.nicknames.length > 0 && y.parsed.nicknames.length > 0
      && nicknameCompatibility(z.parsed, y.parsed) === "conflict";
    if (shares || xIsInitials || nicknameAmbiguous) out.push(z);
  }
  return out;
}

/** El nombre que queda: el del canal, el completo antes que las iniciales, con apodo, el más usado, el menos cortado. */
export function chooseKeepPerson(a: PersonSide, b: PersonSide): [PersonSide, PersonSide] {
  const score = (person: PersonSide): number[] => {
    const parsed = parsePersonName(person.name);
    return [person.channelCredited ? 1 : 0, parsed.tokens.some((token) => token.length === 1) ? 0 : 1, parsed.nicknames.length ? 1 : 0, parsed.tokens.length, person.references, parsed.tokens.join("").length, -person.id];
  };
  const [sa, sb] = [score(a), score(b)];
  for (let index = 0; index < sa.length; index += 1) {
    if (sa[index] !== sb[index]) return sa[index]! > sb[index]! ? [a, b] : [b, a];
  }
  return [a, b];
}

export function analyzePersonPair(input: PersonPairInput): QuestionOutcome {
  const { a, b } = input;
  const sheet = new FactSheet();
  const describe = (person: PersonSide): string => sheet.add(`person:${person.id}`,
    `«${person.name}» (${person.id}): ${person.references} créditos o membresías; bandas: ${person.artists.slice(0, 8).map((artist) => artist.name).join(", ") || "ninguna"}`
    + `${person.channelCredited ? "; acreditada en el canal" : ""}${person.nationality ? `; nacionalidad ${person.nationality}` : ""}${person.birthDate ? `; nacida ${person.birthDate}` : ""}`);
  const factA = describe(a); const factB = describe(b);
  const [keep, drop] = chooseKeepPerson(a, b);
  const mergeTarget = { action: "merge_persons" as const, keepId: keep.id, dropId: drop.id, keepName: keep.name, dropName: drop.name };
  const base = {
    questionKey: "pair",
    question: `¿«${a.name}» (${a.id}) y «${b.name}» (${b.id}) son la misma persona?`,
    options: [{ key: "same", label: `fusionar ${drop.id} en ${keep.id} («${keep.name}», la otra grafía queda como alias)`, target: mergeTarget }],
  };

  const different = input.prior.filter((item) => item.verdict === "different");
  const same = input.prior.filter((item) => item.verdict === "same");
  if (different.length || same.length) {
    const facts = input.prior.map((item) => sheet.add(`review:${item.reviewId}`, `${item.decidedBy} decidió «${item.verdict}» entre estas dos fichas en la revisión #${item.reviewId}`));
    if (different.length && same.length) {
      return question({ ...base, decision: "CONFLICT", rule: "person.prior_decisions_disagree",
        reasoning: "hay decisiones humanas anteriores en los dos sentidos", facts: sheet.facts, evidence: facts.map((id) => support(id, "conflict")), target: null, aiEligible: false });
    }
    return different.length
      ? question({ ...base, decision: "KEEP_SEPARATE", rule: "person.prior_human_decision", reasoning: "una persona ya decidió que son distintas", facts: sheet.facts, evidence: facts.map((id) => support(id, "separate")), target: null, aiEligible: false })
      : question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule: "person.prior_human_decision", reasoning: "una persona ya decidió que son la misma", facts: sheet.facts, evidence: facts.map((id) => support(id, "match")), target: mergeTarget, aiEligible: false });
  }
  if (a.birthDate && b.birthDate && a.birthDate !== b.birthDate) {
    const dates = sheet.add(`person:${a.id}.birth_date|person:${b.id}.birth_date`, `fechas de nacimiento distintas: ${a.birthDate} / ${b.birthDate}`);
    return question({ ...base, decision: "KEEP_SEPARATE", rule: "person.contradicting_birth_dates", reasoning: "el catálogo guarda fechas de nacimiento distintas", facts: sheet.facts, evidence: [support(dates, "separate")], target: null, aiEligible: false });
  }

  const pa = parsePersonName(a.name); const pb = parsePersonName(b.name);
  if (pa.compound || pb.compound) {
    const compound = sheet.add(`person:${pa.compound ? a.id : b.id}.name`, `«${pa.compound ? a.name : b.name}» parece contener a varias personas o a un estudio`);
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "person.compound_name", reasoning: "un nombre compuesto se corrige antes de compararlo", facts: sheet.facts, evidence: [support(compound, "context")], target: null, aiEligible: false });
  }
  const relation = personRelation(pa, pb);
  const relationFact = sheet.add(`person:${a.id}.name|person:${b.id}.name`, relation ? `${RELATION_TEXT[relation]}: «${a.name}» / «${b.name}»` : `los nombres no se parecen de ninguna forma reconocida: «${a.name}» / «${b.name}»`);
  const artistIds = new Set(b.artists.map((artist) => artist.id));
  const sharedArtists = a.artists.filter((artist) => artistIds.has(artist.id));
  const albumIds = new Set(b.albums.map((album) => album.id));
  const sharedAlbums = a.albums.filter((album) => albumIds.has(album.id));
  const contextFact = sheet.add(`context:person:${a.id}|person:${b.id}`,
    `comparten ${sharedArtists.length} banda(s) (${sharedArtists.slice(0, 6).map((artist) => artist.name).join(", ") || "ninguna"}) y ${sharedAlbums.length} disco(s) donde ambas figuran`
    + `${sharedAlbums.length ? ` (${sharedAlbums.slice(0, 4).map((album) => `«${album.title}» de ${album.artistName}`).join(", ")})` : ""}`);

  if (!relation) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "person.no_name_relation", reasoning: "sin variación nominal reconocible no hay regla que las una", facts: sheet.facts, evidence: [support(relationFact, "context")], target: null, aiEligible: false });
  }
  if (!sharedArtists.length) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "person.no_shared_context", reasoning: "el parecido del nombre no es evidencia de identidad sin una banda en común", facts: sheet.facts, evidence: [support(contextFact, "context")], target: null, aiEligible: false });
  }
  if (nicknameCompatibility(pa, pb) === "conflict") {
    const nicknames = sheet.add(`person:${a.id}.name|person:${b.id}.name`, `apodos distintos: ${pa.nicknames.join(", ")} / ${pb.nicknames.join(", ")}`);
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "person.nickname_conflict", reasoning: "nombre y banda coinciden pero los apodos se contradicen: puede ser una errata o dos personas", facts: sheet.facts, evidence: [support(nicknames, "context"), support(contextFact, "match")], target: null, aiEligible: true });
  }
  const rivals = [...input.competitors.a.map((item) => ({ side: a, item })), ...input.competitors.b.map((item) => ({ side: b, item }))];
  if (rivals.length) {
    const rivalFacts = rivals.slice(0, 6).map(({ side, item }) => sheet.add(`person:${item.id}`, `«${item.name}» (${item.id}) también podría ser «${side.name}»`));
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "person.competing_candidates", reasoning: "hay más de un candidato plausible para la misma grafía", facts: sheet.facts, evidence: rivalFacts.map((id) => support(id, "context")), target: null, aiEligible: false });
  }

  const match = (rule: string, reasoning: string): QuestionOutcome => question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule, reasoning,
    facts: sheet.facts, evidence: [support(relationFact, "match"), support(contextFact, "match"), support(factA, "context"), support(factB, "context")], target: mergeTarget, aiEligible: false });
  const weak = (rule: string, reasoning: string, aiEligible = true): QuestionOutcome => question({ ...base, decision: "NEEDS_HUMAN", rule, reasoning,
    facts: sheet.facts, evidence: [support(relationFact, "context"), support(contextFact, "context")], target: null, aiEligible });
  const strongContext = sharedAlbums.length >= 1 || sharedArtists.length >= 2;

  if (STRONG_NAME.has(relation)) {
    const sameNickname = nicknameCompatibility(pa, pb) === "equal";
    const longName = Math.min(pa.tokens.length, pb.tokens.length) >= 3;
    return sameNickname || strongContext || longName
      ? match("person.name_variant_with_context", `${RELATION_TEXT[relation]}, ${sameNickname ? "con el mismo apodo" : "sin apodos contradictorios"}, y comparten ${sharedAlbums.length ? "discos" : "bandas"}`)
      : weak("person.name_variant_weak_context", "variante clara del nombre pero con una sola banda en común y un nombre corto: puede ser un homónimo");
  }
  if (relation === "initials") {
    const initialsSide = pa.tokens.some((token) => token.length === 1) ? a : b;
    const fullSide = initialsSide === a ? b : a;
    const fullArtists = new Set(fullSide.artists.map((artist) => artist.id));
    return initialsSide.artists.every((artist) => fullArtists.has(artist.id))
      ? match("person.initials_unique", `«${initialsSide.name}» solo encaja con «${fullSide.name}» en el catálogo y todas sus bandas son de esa persona`)
      : weak("person.initials_other_context", "las iniciales aparecen en bandas donde el nombre completo no figura", false);
  }
  if (relation === "surname_typo") {
    // Una letra distinta también separa apellidos reales («Rendón» / «Rondón»):
    // solo se fusiona con la huella de una misma persona copiada por dos
    // fuentes, el mismo tipo de crédito en el mismo disco.
    const sameCredit = sharedAlbums.filter((album) => b.albums.find((other) => other.id === album.id)?.creditTypes.some((type) => album.creditTypes.includes(type)));
    if (!sameCredit.length) return weak("person.surname_typo_weak_context", "errata probable, pero sin el mismo crédito en un mismo disco pueden ser dos apellidos reales");
    const creditFact = sheet.add(`album_credits:album:${sameCredit.map((album) => album.id).join(",")}`,
      `las dos grafías tienen el mismo tipo de crédito en ${sameCredit.slice(0, 4).map((album) => `«${album.title}» de ${album.artistName}`).join(", ")}`);
    return question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule: "person.surname_typo_same_credit",
      reasoning: `${RELATION_TEXT[relation]} y el mismo crédito en el mismo disco: una persona escrita de dos formas por dos fuentes`,
      facts: sheet.facts, evidence: [support(relationFact, "match"), support(creditFact, "match"), support(contextFact, "context")], target: mergeTarget, aiEligible: false });
  }
  return weak(`person.${relation}`, `${RELATION_TEXT[relation]}: ninguna regla determinista distingue una errata de dos personas`);
}
