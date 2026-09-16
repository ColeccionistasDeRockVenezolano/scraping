// Detector de candidatos de duplicado de organización (PHASES E11.10; plan P10).
//
// Mismo bloqueo y misma puntuación explicable que el detector de personas
// (`person-candidates.ts`), con dos diferencias que pide el catálogo real:
//
//  * La clave de bloqueo quita las palabras que no distinguen («estudio»,
//    «studios», «records», «producciones», «discos», «mastering», «films»):
//    «Estudio Uno» y «Uno» son la misma organización.
//  * No hay apodo ni apellido que valga: lo que suma es la clave igual, un
//    alias cruzado, discos acreditados en común y personas vinculadas a las dos.
//
// PROPONE, NO DECIDE: deja revisiones `organization_match` en la cola (el kind
// ya existía en el enum y sus columnas `organization_a_id`/`organization_b_id`
// también) y la fusión la decide una persona desde la ficha (E11.10) o la mesa
// de cotejo.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { jaroWinkler } from "../er/scoring.js";
import { withOperatorRun } from "../merge/operator.js";
import { organizationKey } from "./person-names.js";

export interface OrganizationFacts {
  id: number;
  name: string;
  aliases: string[];
  /** Discos donde la organización está acreditada (de disco o de pista). */
  albumIds: number[];
}

export interface OrganizationPairScore {
  score: number;
  features: Array<{ key: string; value: number; evidence: string }>;
  /** Si viene, el par no se propone y dice por qué. */
  blocked?: string;
}

/** Claves de bloqueo: la clave completa sin palabras de estudio y su primera palabra. */
export function organizationBlockingKeys(name: string): string[] {
  const key = organizationKey(name);
  if (!key) return [];
  const keys = new Set<string>([`full:${key}`]);
  const head = key.split(/\s+/u)[0];
  if (head && head.length > 2) keys.add(`head:${head}`);
  return [...keys];
}

const W_STRONG = 0.6;
const W_WEAK = 0.45;

/** Puntuación explicable de un par de organizaciones. Nunca lanza. */
export function scoreOrganizationPair(a: OrganizationFacts, b: OrganizationFacts): OrganizationPairScore {
  const features: OrganizationPairScore["features"] = [];
  const keyA = organizationKey(a.name);
  const keyB = organizationKey(b.name);
  if (!keyA || !keyB) return { score: 0, features, blocked: "nombre sin letras comparables" };

  let score = 0;
  const add = (key: string, value: number, evidence: string) => {
    features.push({ key, value, evidence });
    score += value;
  };

  if (keyA === keyB) add("key_equal", 0.6, `misma clave sin palabras de estudio: ${keyA}`);
  const aliasKeys = new Set([...a.aliases.map(organizationKey), ...b.aliases.map(organizationKey)]);
  if (aliasKeys.has(keyB) || aliasKeys.has(keyA)) add("alias_cross", 0.3, "el nombre de una figura como alias de la otra");

  const jw = jaroWinkler(keyA, keyB);
  if (jw >= 0.92 && keyA !== keyB) add("jaro_winkler", Number((0.1 * jw).toFixed(4)), `Jaro-Winkler=${jw.toFixed(3)}`);

  const sharedAlbums = a.albumIds.filter((id) => b.albumIds.includes(id));
  if (sharedAlbums.length) add("shared_album", 0.1, `discos en común: ${sharedAlbums.slice(0, 3).join(", ")}`);

  return { score: Math.max(0, Math.min(1, Number(score.toFixed(4)))), features };
}

export interface OrganizationCandidate {
  a: { id: number; name: string };
  b: { id: number; name: string };
  score: number;
  features: Array<{ key: string; value: number; evidence: string }>;
  priority: number;
}

export interface OrganizationCandidateScan {
  candidates: OrganizationCandidate[];
  organizations: number;
  comparedPairs: number;
}

/** Pares ya careados (revisión viva o descartada): no se vuelven a proponer. */
async function settledPairs(queryable: Pick<PoolClient, "query">): Promise<Set<string>> {
  const { rows } = await queryable.query<{ a: string; b: string; settled: boolean }>(`
    SELECT LEAST(organization_a_id, organization_b_id)::text AS a,
           GREATEST(organization_a_id, organization_b_id)::text AS b,
           bool_or(status IN ('open','in_progress') OR status='dismissed') AS settled
      FROM ingest.review_queue
     WHERE kind::text='organization_match' AND organization_a_id IS NOT NULL AND organization_b_id IS NOT NULL
     GROUP BY 1, 2`);
  return new Set(rows.filter((row) => row.settled).map((row) => `${row.a}:${row.b}`));
}

/**
 * Escanea el catálogo (4 consultas, sin N+1), bloquea por clave y puntúa cada
 * par una sola vez. Devuelve los pares ordenados por score.
 */
export async function findOrganizationCandidates(
  options: { minScore?: number; limit?: number; maxBlockSize?: number; queryable?: Pick<PoolClient, "query"> } = {},
): Promise<OrganizationCandidateScan> {
  const minScore = options.minScore ?? W_WEAK;
  const maxBlockSize = options.maxBlockSize ?? 25;
  const queryable = options.queryable ?? getPool();

  const [organizations, aliases, credits, settled] = await Promise.all([
    queryable.query<{ id: string; name: string }>("SELECT id::text, name FROM public.organizations ORDER BY id"),
    queryable.query<{ owner_id: string; alias: string }>(
      "SELECT organization_id::text AS owner_id, alias FROM ingest.organization_aliases ORDER BY organization_id, alias"),
    queryable.query<{ id: string; album_id: string }>(`
      SELECT organization_id::text AS id, album_id::text FROM (
        SELECT organization_id, album_id FROM public.album_credits WHERE organization_id IS NOT NULL
        UNION
        SELECT tc.organization_id, t.album_id FROM public.track_credits tc
          JOIN public.tracks t ON t.id=tc.track_id
         WHERE tc.organization_id IS NOT NULL
      ) refs`),
    settledPairs(queryable),
  ]);

  const facts = new Map<number, OrganizationFacts>();
  for (const row of organizations.rows) {
    facts.set(Number(row.id), { id: Number(row.id), name: row.name, aliases: [], albumIds: [] });
  }
  for (const row of aliases.rows) facts.get(Number(row.owner_id))?.aliases.push(row.alias);
  for (const row of credits.rows) {
    const entry = facts.get(Number(row.id));
    const albumId = Number(row.album_id);
    if (entry && !entry.albumIds.includes(albumId)) entry.albumIds.push(albumId);
  }

  // Bloqueo: solo se comparan organizaciones que comparten clave.
  const blocks = new Map<string, OrganizationFacts[]>();
  for (const entry of facts.values()) {
    for (const key of organizationBlockingKeys(entry.name)) {
      blocks.set(key, [...(blocks.get(key) ?? []), entry]);
    }
  }

  const seen = new Set<string>();
  const candidates: OrganizationCandidate[] = [];
  let comparedPairs = 0;
  for (const block of blocks.values()) {
    if (block.length < 2 || block.length > maxBlockSize) continue;
    for (let left = 0; left < block.length; left += 1) {
      for (let right = left + 1; right < block.length; right += 1) {
        const a = block[left]!;
        const b = block[right]!;
        const pairId = `${a.id}:${b.id}`;
        if (seen.has(pairId) || settled.has(pairId)) continue;
        seen.add(pairId);
        comparedPairs += 1;
        const { score, features, blocked } = scoreOrganizationPair(a, b);
        if (blocked || score < minScore) continue;
        candidates.push({
          a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name },
          score, features, priority: score >= W_STRONG ? 3 : 6,
        });
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.a.id - right.a.id);
  return {
    candidates: options.limit === undefined ? candidates : candidates.slice(0, options.limit),
    organizations: facts.size,
    comparedPairs,
  };
}

/**
 * Abre las revisiones `organization_match` en un run del operador. Repetir la
 * corrida no duplica nada: el índice único parcial por par vivo (0016) y el
 * `ON CONFLICT DO NOTHING` lo impiden.
 */
export async function openOrganizationCandidateReviews(
  candidates: OrganizationCandidate[], note: string, operator = "cli",
): Promise<{ runId: number; opened: number; skipped: number }> {
  const { runId, result } = await withOperatorRun({
    name: "cli:review:organization-candidates",
    operator,
    note,
    params: { detector: "organization-candidates", version: 1, proposed: candidates.length },
  }, async (context) => {
    let opened = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const inserted = await context.client.query(`
        INSERT INTO ingest.review_queue(kind,organization_a_id,organization_b_id,priority,status,payload,notes)
        VALUES('organization_match',LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),$3,'open',$4::jsonb,$5)
        ON CONFLICT DO NOTHING`, [
        candidate.a.id, candidate.b.id, candidate.priority,
        JSON.stringify({
          detector: "organization-candidates", version: 1, score: candidate.score,
          features: candidate.features, runId: context.runId,
        }),
        note,
      ]);
      if (inserted.rowCount) opened += 1;
      else skipped += 1;
    }
    return { opened, skipped };
  });
  return { runId, opened: result.opened, skipped: result.skipped };
}
