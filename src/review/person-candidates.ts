// Detector de candidatos de duplicado de persona (PHASES E11.5; plan P10).
//
// PROPONE, NO DECIDE. Alimenta la cola con pares ordenados —`person_duplicate`,
// con score y features— y deja que una persona elija: fusionar (E11.4) o
// «son distintas» (que el par no vuelva a proponerse). La IA no entra aquí y
// nada de este módulo escribe el core.
//
// POR QUÉ NO ES UN JOIN EN SQL: la base es SQL_ASCII (regla 0.1.11) y no sabe
// comparar sin tildes ni mayúsculas —`lower('ÁNGEL')` es `Ángel`—. Con ~10k
// personas, cargar nombres, alias, bandas, discos y fechas en memoria (5
// consultas planas, nada de N+1) y comparar en TypeScript es más barato y
// exacto que cualquier truco en SQL.
//
// LAS CLAVES DE BLOQUEO ACOTAN EL COSTO. Solo se puntúan pares que comparten
// el nombre completo sin apodo o su primer y último token; las claves con más
// de `maxBlockSize` personas se descartan (un apellido común no es señal).
//
// LAS DECISIONES HUMANAS PERSISTEN. Un par cerrado como `dismissed`
// («son distintas») no se vuelve a proponer, y un par con revisión viva
// tampoco se duplica.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { jaroWinkler } from "../er/scoring.js";
import { normalizeEntityName } from "../normalization/entity-name.js";
import { withOperatorRun } from "../merge/operator.js";
import { looksLikeOrganization, nameWithoutNickname, personBlockingKeys } from "./person-names.js";

// Los helpers de nombre viven en person-names.ts (los comparten la fusión y el
// clasificador); se re-exportan porque son parte de la API del detector.
export { nameWithoutNickname, personBlockingKeys };

/** Datos mínimos de una persona para puntuar un par, cargados sin N+1. */
export interface PersonFacts {
  id: number;
  name: string;
  aliases: string[];
  bandIds: number[];
  albumIds: number[];
  creditTypes: string[];
  birthDate: string | null;
  deathDate: string | null;
}

export interface PairFeature {
  key: string;
  value: number;
  evidence: string;
}

export interface PairScore {
  /** 0..1 */
  score: number;
  features: PairFeature[];
  /** Motivo para no proponer nunca el par (fechas contradictorias, basura). */
  blocked?: string;
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

interface NameShape {
  /** Clave sin apodos, sin tildes ni mayúsculas. */
  base: string;
  /** Tokens con más de un carácter (una inicial no identifica a nadie). */
  tokens: string[];
  /** El nombre original tenía apodo entre comillas o paréntesis. */
  hadNickname: boolean;
}

function shapeOf(name: string): NameShape {
  const base = nameWithoutNickname(name);
  return {
    base,
    tokens: base.split(/\s+/u).filter((token) => token.length > 1),
    hadNickname: base !== normalizeEntityName(name).secondaryKey,
  };
}

function intersection(left: number[], right: number[]): number[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((item) => rightSet.has(item));
}

/** Un nombre (o su versión sin apodo) figura como alias declarado del otro. */
function aliasCrossMatch(a: PersonFacts, b: PersonFacts): string | null {
  const keyOf = (value: string) => normalizeEntityName(value).secondaryKey;
  for (const [side, other] of [[a, b], [b, a]] as const) {
    for (const alias of other.aliases) {
      if (keyOf(alias) === keyOf(side.name) || nameWithoutNickname(alias) === nameWithoutNickname(side.name)) {
        return `«${side.name}» figura como alias «${alias}» de «${other.name}»`;
      }
    }
  }
  return null;
}

/**
 * Puntúa un par de personas (0..1) con sus features explicables.
 *
 * Pesos (tabla del plan E11.5; se ajustan solo si un test lo justifica):
 *   nickname_equal +0,45 · alias_cross +0,45 · first_last_equal +0,25 ·
 *   jaro_winkler +0,15·jw (solo ≥0,92) · shared_band +0,20 ·
 *   shared_album +0,15 · middle_name_clash −0,10.
 * Bloqueos: organización disfrazada de persona y fechas contradictorias.
 */
export function scorePersonPair(a: PersonFacts, b: PersonFacts): PairScore {
  const features: PairFeature[] = [];
  const shapeA = shapeOf(a.name);
  const shapeB = shapeOf(b.name);

  if (looksLikeOrganization(a.name) || looksLikeOrganization(b.name)) {
    return { score: 0, features, blocked: "alguno parece un estudio, sello o productora" };
  }
  for (const [label, left, right] of [
    ["nacimiento", a.birthDate, b.birthDate],
    ["muerte", a.deathDate, b.deathDate],
  ] as const) {
    if (left && right && left !== right) return { score: 0, features, blocked: `fechas de ${label} distintas` };
  }

  let score = 0;
  const add = (key: string, value: number, evidence: string) => {
    features.push({ key, value: round(value), evidence });
    score += value;
  };

  const nicknameEqual = Boolean(shapeA.base) && shapeA.base === shapeB.base && (shapeA.hadNickname || shapeB.hadNickname);
  if (nicknameEqual) add("nickname_equal", 0.45, `sin apodo coinciden: ${shapeA.base}`);

  const cross = aliasCrossMatch(a, b);
  if (cross) add("alias_cross", 0.45, cross);

  if (!nicknameEqual && shapeA.tokens.length >= 2 && shapeB.tokens.length >= 2
    && shapeA.tokens[0] === shapeB.tokens[0] && shapeA.tokens[shapeA.tokens.length - 1] === shapeB.tokens[shapeB.tokens.length - 1]) {
    add("first_last_equal", 0.25, `comparten primer y último token: ${shapeA.tokens[0]} … ${shapeA.tokens[shapeA.tokens.length - 1]}`);
  }

  const jw = jaroWinkler(shapeA.base, shapeB.base);
  if (jw >= 0.92) add("jaro_winkler", 0.15 * jw, `Jaro-Winkler=${jw.toFixed(3)} sobre el nombre sin apodo`);

  const bands = intersection(a.bandIds, b.bandIds);
  if (bands.length) add("shared_band", 0.2, `bandas compartidas: ${bands.join(", ")}`);
  const albums = intersection(a.albumIds, b.albumIds);
  if (albums.length) add("shared_album", 0.15, `discos acreditados compartidos: ${albums.length}`);

  const middleA = shapeA.tokens.slice(1, -1);
  const middleB = shapeB.tokens.slice(1, -1);
  if (shapeA.tokens.length >= 3 && shapeB.tokens.length >= 3
    && middleA.join(" ") !== middleB.join(" ")) {
    // El segundo nombre distinto no invalida el par (hay quien firma con uno y
    // sin él), pero resta: el aviso queda en las features.
    features.push({ key: "middle_name_clash", value: 0.1, evidence: `nombres intermedios distintos: ${middleA.join(" ")} / ${middleB.join(" ")}` });
    score -= 0.1;
  }

  return { score: round(Math.max(0, Math.min(1, score))), features };
}

export interface PersonCandidate {
  a: { id: number; name: string };
  b: { id: number; name: string };
  score: number;
  features: PairFeature[];
  /** 3: score ≥ 0,60; 6: 0,45 ≤ score < 0,60 (escala del plan E11.5). */
  priority: 3 | 6;
}

export interface PersonCandidateScan {
  candidates: PersonCandidate[];
  /** Personas cargadas con nombre utilizable. */
  persons: number;
  /** Pares realmente puntuados (comparten clave de bloqueo). */
  comparedPairs: number;
}

export interface PersonCandidateOptions {
  /** Score mínimo para proponer (por defecto 0,45). */
  minScore?: number;
  /** Tope de candidatos devueltos (por defecto, sin tope). */
  limit?: number;
  /** Una clave de bloqueo con más personas que esto no es señal (por defecto 25). */
  maxBlockSize?: number;
  queryable?: Pick<PoolClient, "query">;
}

/** 0,45: por debajo, el par no se propone (dos señales débiles no bastan). */
export const PERSON_CANDIDATE_MIN_SCORE = 0.45;
export const PERSON_CANDIDATE_STRONG_SCORE = 0.6;

async function loadFacts(queryable: Pick<PoolClient, "query">): Promise<PersonFacts[]> {
  const persons = (await queryable.query<{ id: string; name: string; birth_date: string | null; death_date: string | null }>(
    "SELECT id::text, name, birth_date::text AS birth_date, death_date::text AS death_date FROM public.persons ORDER BY id")).rows;
  const aliases = (await queryable.query<{ person_id: string; alias: string }>(
    "SELECT person_id::text, alias FROM ingest.person_aliases ORDER BY person_id, alias")).rows;
  const bands = (await queryable.query<{ person_id: string; artist_id: string }>(
    "SELECT person_id::text, artist_id::text FROM public.artist_members WHERE person_id IS NOT NULL")).rows;
  // Un solo viaje para discos acreditados y tipos de crédito (de disco y de pista).
  const credits = (await queryable.query<{ person_id: string; album_id: string; credit_type: string }>(`
    SELECT person_id::text, album_id::text, credit_type::text FROM public.album_credits WHERE person_id IS NOT NULL
    UNION
    SELECT tc.person_id::text, t.album_id::text, tc.credit_type::text
      FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id WHERE tc.person_id IS NOT NULL`)).rows;

  const byId = new Map<number, PersonFacts>();
  for (const person of persons) {
    byId.set(Number(person.id), {
      id: Number(person.id), name: person.name, aliases: [], bandIds: [], albumIds: [], creditTypes: [],
      birthDate: person.birth_date, deathDate: person.death_date,
    });
  }
  for (const alias of aliases) byId.get(Number(alias.person_id))?.aliases.push(alias.alias);
  for (const band of bands) byId.get(Number(band.person_id))?.bandIds.push(Number(band.artist_id));
  for (const credit of credits) {
    const facts = byId.get(Number(credit.person_id));
    if (!facts) continue;
    facts.albumIds.push(Number(credit.album_id));
    if (!facts.creditTypes.includes(credit.credit_type)) facts.creditTypes.push(credit.credit_type);
  }
  return [...byId.values()];
}

/** Pares ya careados: con revisión viva o cerrada como «son distintas». */
async function settledPairs(queryable: Pick<PoolClient, "query">): Promise<{ live: Set<string>; dismissed: Set<string> }> {
  // `kind::text` y no `kind='person_duplicate'`: así la lectura funciona
  // también en una base que aún no aplicó 0015 (el valor del enum no existiría
  // y PostgreSQL rechazaría el literal). Escribir sí exige la migración.
  const rows = (await queryable.query<{ a: string; b: string; live: boolean; dismissed: boolean }>(`
    SELECT LEAST(person_a_id, person_b_id)::text AS a,
           GREATEST(person_a_id, person_b_id)::text AS b,
           bool_or(status IN ('open','in_progress')) AS live,
           bool_or(status = 'dismissed') AS dismissed
      FROM ingest.review_queue
     WHERE kind::text IN ('person_duplicate','person_match') AND person_a_id IS NOT NULL AND person_b_id IS NOT NULL
     GROUP BY 1,2`)).rows;
  const live = new Set<string>();
  const dismissed = new Set<string>();
  for (const row of rows) {
    const key = `${row.a}|${row.b}`;
    if (row.live) live.add(key);
    if (row.dismissed) dismissed.add(key);
  }
  return { live, dismissed };
}

const pairKey = (left: number, right: number) => `${Math.min(left, right)}|${Math.max(left, right)}`;

/**
 * Candidatos de duplicado ordenados por score (desc). Un par se puntúa una
 * sola vez (`a.id < b.id`) y solo si comparte alguna clave de bloqueo.
 */
export async function findPersonCandidates(options: PersonCandidateOptions = {}): Promise<PersonCandidateScan> {
  const queryable = options.queryable ?? getPool();
  const minScore = options.minScore ?? PERSON_CANDIDATE_MIN_SCORE;
  const maxBlockSize = options.maxBlockSize ?? 25;
  const facts = await loadFacts(queryable);
  const settled = await settledPairs(queryable);

  const byKey = new Map<string, PersonFacts[]>();
  for (const person of facts) {
    for (const key of personBlockingKeys(person.name)) {
      byKey.set(key, [...(byKey.get(key) ?? []), person]);
    }
  }

  const candidates: PersonCandidate[] = [];
  const seen = new Set<string>();
  let comparedPairs = 0;
  for (const group of byKey.values()) {
    // Una clave que agrupa a medio catálogo (un apellido común) no es señal.
    if (group.length < 2 || group.length > maxBlockSize) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const [left, right] = group[i]!.id < group[j]!.id ? [group[i]!, group[j]!] : [group[j]!, group[i]!];
        const key = pairKey(left.id, right.id);
        if (seen.has(key)) continue;
        seen.add(key);
        comparedPairs += 1;
        if (settled.live.has(key) || settled.dismissed.has(key)) continue;
        const scored = scorePersonPair(left, right);
        if (scored.blocked || scored.score < minScore) continue;
        candidates.push({
          a: { id: left.id, name: left.name },
          b: { id: right.id, name: right.name },
          score: scored.score,
          features: scored.features,
          priority: scored.score >= PERSON_CANDIDATE_STRONG_SCORE ? 3 : 6,
        });
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.a.id - right.a.id || left.b.id - right.b.id);
  return {
    candidates: options.limit === undefined ? candidates : candidates.slice(0, options.limit),
    persons: facts.length,
    comparedPairs,
  };
}

export interface OpenCandidatesResult {
  runId: number;
  opened: number;
  skipped: number;
}

/**
 * Abre una revisión `person_duplicate` por candidato, en un run `manual` con
 * nota. Idempotente por el índice parcial 0016: repetir la corrida no
 * duplica lo que sigue vivo (`ON CONFLICT DO NOTHING`).
 */
export async function openPersonCandidateReviews(
  candidates: PersonCandidate[], note: string, operator: string,
): Promise<OpenCandidatesResult> {
  const { runId, result } = await withOperatorRun({
    name: "cli:review:person-candidates", operator, note,
    params: { detector: "person-candidates", version: 1, proposed: candidates.length },
  }, async (context) => {
    let opened = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const inserted = await context.client.query(`
        INSERT INTO ingest.review_queue(kind,person_a_id,person_b_id,priority,status,payload,notes)
        VALUES('person_duplicate',LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),$3,'open',$4::jsonb,$5)
        ON CONFLICT DO NOTHING`, [
        candidate.a.id, candidate.b.id, candidate.priority,
        JSON.stringify({
          detector: "person-candidates", version: 1, score: candidate.score,
          features: candidate.features, runId: context.runId,
        }),
        `${note} — «${candidate.a.name}» / «${candidate.b.name}» (score ${candidate.score.toFixed(2)})`,
      ]);
      if (inserted.rowCount) opened += 1;
      else skipped += 1;
    }
    return { opened, skipped };
  });
  return { runId, ...result };
}
