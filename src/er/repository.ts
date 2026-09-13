import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import type { DeepSeekGateway } from "../ai/gateway.js";
import { resolveEntity, type ResolveOptions } from "./resolver.js";
import type { ResolutionAlias, ResolutionCandidate, ResolutionDecision, ResolutionInput } from "./types.js";

type Queryable = Pick<Pool | PoolClient, "query">;

interface CandidateRow {
  id: string;
  name: string;
  aliases?: unknown;
  [key: string]: unknown;
}

function aliases(value: unknown): ResolutionAlias[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row["value"] !== "string") return [];
    const type = typeof row["type"] === "string" ? row["type"] as ResolutionAlias["type"] : undefined;
    const confidence = row["confidence"] === "high" || row["confidence"] === "medium" || row["confidence"] === "low" ? row["confidence"] : undefined;
    return [{ value: row["value"], ...(type === undefined ? {} : { type }), ...(confidence === undefined ? {} : { confidence }) }];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export async function loadResolutionCandidates(input: ResolutionInput, queryable: Queryable = getPool()): Promise<ResolutionCandidate[]> {
  if (input.kind === "ARTIST") {
    const result = await queryable.query<CandidateRow>(`
      SELECT a.id::text, a.name, a.formed_year, a.disbanded_year, a.origin_city, a.origin_country,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('value',x.alias,'type',x.alias_type,'confidence',x.confidence)) FROM ingest.artist_aliases x WHERE x.artist_id=a.id),'[]'::jsonb) aliases,
        ARRAY(SELECT DISTINCT p.name FROM public.artist_members am JOIN public.persons p ON p.id=am.person_id WHERE am.artist_id=a.id) members,
        ARRAY(SELECT DISTINCT al.title FROM public.albums al WHERE al.artist_id=a.id) discography
      FROM public.artists a ORDER BY a.id`);
    return result.rows.map((row): ResolutionCandidate => {
      const from = numberValue(row["formed_year"]); const to = numberValue(row["disbanded_year"]);
      return {
        kind: "ARTIST", id: Number(row.id), name: row.name, canonicalName: row.name, aliases: aliases(row.aliases),
        activeYears: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
        origin: { ...(typeof row["origin_city"] === "string" ? { city: row["origin_city"] } : {}), ...(typeof row["origin_country"] === "string" ? { country: row["origin_country"] } : {}) },
        members: strings(row["members"]), discography: strings(row["discography"]),
      };
    });
  }
  if (input.kind === "PERSON") {
    const result = await queryable.query<CandidateRow>(`
      SELECT p.id::text,p.name,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('value',x.alias,'type',x.alias_type,'confidence',x.confidence)) FROM ingest.person_aliases x WHERE x.person_id=p.id),'[]'::jsonb) aliases,
        ARRAY(SELECT DISTINCT a.name FROM public.artist_members am JOIN public.artists a ON a.id=am.artist_id WHERE am.person_id=p.id) bands,
        ARRAY(SELECT DISTINCT am.role FROM public.artist_members am WHERE am.person_id=p.id) roles,
        ARRAY(SELECT DISTINCT al.title FROM public.album_credits ac JOIN public.albums al ON al.id=ac.album_id WHERE ac.person_id=p.id) album_credits,
        (SELECT min(am.from_year) FROM public.artist_members am WHERE am.person_id=p.id) period_from,
        (SELECT max(am.to_year) FROM public.artist_members am WHERE am.person_id=p.id) period_to
      FROM public.persons p ORDER BY p.id`);
    return result.rows.map((row): ResolutionCandidate => {
      const from = numberValue(row["period_from"]); const to = numberValue(row["period_to"]);
      return {
        kind: "PERSON", id: Number(row.id), name: row.name, canonicalName: row.name, aliases: aliases(row.aliases),
        bands: strings(row["bands"]), roles: strings(row["roles"]), albumCredits: strings(row["album_credits"]),
        period: { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
      };
    });
  }
  if (input.kind === "ALBUM") {
    const result = await queryable.query<CandidateRow>(`
      SELECT al.id::text,al.title AS name,al.artist_id,ar.name AS artist_name,al.release_year,al.album_type,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('value',x.alias,'type',x.alias_type,'confidence',x.confidence)) FROM ingest.album_aliases x WHERE x.album_id=al.id),'[]'::jsonb) aliases,
        ARRAY(SELECT t.title FROM public.tracks t WHERE t.album_id=al.id ORDER BY t.disc_number,t.track_number) tracklist
      FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id ORDER BY al.id`);
    return result.rows.map((row): ResolutionCandidate => {
      const year = numberValue(row["release_year"]);
      return {
        kind: "ALBUM", id: Number(row.id), name: row.name, canonicalName: row.name, aliases: aliases(row.aliases),
        artist: { id: Number(row["artist_id"]), name: String(row["artist_name"]) },
        ...(year === undefined ? {} : { year }),
        ...(typeof row["album_type"] === "string" ? { releaseType: row["album_type"] } : {}),
        tracklist: strings(row["tracklist"]),
      };
    });
  }
  if (input.kind === "TRACK") {
    const result = await queryable.query<CandidateRow>(`
      SELECT t.id::text,t.title AS name,t.disc_number,t.track_number,al.id AS album_id,al.title AS album_name,ar.name AS artist_name,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('value',x.alias,'type',x.alias_type,'confidence',x.confidence)) FROM ingest.track_aliases x WHERE x.track_id=t.id),'[]'::jsonb) aliases
      FROM public.tracks t JOIN public.albums al ON al.id=t.album_id JOIN public.artists ar ON ar.id=al.artist_id ORDER BY t.id`);
    return result.rows.map((row) => ({
      kind: "TRACK", id: Number(row.id), name: row.name, canonicalName: row.name, aliases: aliases(row.aliases),
      album: { id: Number(row["album_id"]), name: String(row["album_name"]), artistName: String(row["artist_name"]) },
      disc: Number(row["disc_number"]), trackNumber: Number(row["track_number"]),
    }));
  }
  const result = await queryable.query<CandidateRow>(`
    SELECT o.id::text,o.name,o.organization_type,o.country,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value',x.alias,'type',x.alias_type,'confidence',x.confidence)) FROM ingest.organization_aliases x WHERE x.organization_id=o.id),'[]'::jsonb) aliases,
      ARRAY(SELECT DISTINCT al.title FROM public.albums al WHERE al.label_id=o.id
            UNION SELECT DISTINCT al2.title FROM public.album_credits ac JOIN public.albums al2 ON al2.id=ac.album_id WHERE ac.organization_id=o.id) associated_albums,
      ARRAY(SELECT DISTINCT p.name FROM public.person_organizations po JOIN public.persons p ON p.id=po.person_id WHERE po.organization_id=o.id) associated_persons
    FROM public.organizations o ORDER BY o.id`);
  return result.rows.map((row) => ({
    kind: "ORGANIZATION", id: Number(row.id), name: row.name, canonicalName: row.name, aliases: aliases(row.aliases),
    ...(typeof row["organization_type"] === "string" ? { organizationType: row["organization_type"] } : {}),
    location: { ...(typeof row["country"] === "string" ? { country: row["country"] } : {}) },
    associatedAlbums: strings(row["associated_albums"]), associatedPersons: strings(row["associated_persons"]),
  }));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function targetColumns(kind: ResolutionInput["kind"], id: number | undefined): [number | null, number | null, number | null, number | null, number | null] {
  return [kind === "ARTIST" ? id ?? null : null, kind === "PERSON" ? id ?? null : null,
    kind === "ALBUM" ? id ?? null : null, kind === "TRACK" ? id ?? null : null,
    kind === "ORGANIZATION" ? id ?? null : null];
}

export async function persistResolutionDecision(
  decision: ResolutionDecision,
  input: ResolutionInput,
  options: {
    claimId?: number;
    runId?: number;
    queryable?: Queryable;
    decidedBy?: "deterministic" | "deepseek" | "human";
  } = {},
): Promise<number> {
  const queryable = options.queryable ?? getPool();
  const identity = { claimId: options.claimId ?? null, runId: options.runId ?? null, input, decision };
  const decisionHash = createHash("sha256").update(stableJson(identity)).digest("hex");
  const targets = targetColumns(decision.kind, decision.candidateId);
  const saved = await queryable.query<{ id: string }>(`
    INSERT INTO ingest.entity_resolution_decisions(
      decision_hash,run_id,claim_id,ai_run_id,entity_kind,
      artist_id,person_id,album_id,track_id,organization_id,
      input_name_original,input_name_normalized,input_context,score,action,
      features,candidates,thresholds,explanation,decided_by
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20)
    ON CONFLICT(decision_hash) DO UPDATE SET decision_hash=EXCLUDED.decision_hash
    RETURNING id`, [
    decisionHash, options.runId ?? null, options.claimId ?? null, decision.aiRunId ?? null, decision.kind,
    ...targets, decision.inputOriginal, decision.inputNormalized, JSON.stringify(input), decision.score, decision.action,
    JSON.stringify(decision.features), JSON.stringify(decision.candidates), JSON.stringify(decision.thresholds),
    decision.explanation, options.decidedBy ?? (decision.aiProposal ? "deepseek" : "deterministic"),
  ]);
  const id = saved.rows[0]?.id;
  if (!id) throw new Error("no se pudo persistir entity_resolution_decision");
  return Number(id);
}

export interface DatabaseResolutionOptions extends ResolveOptions {
  gateway?: DeepSeekGateway;
  claimId?: number;
  runId?: number;
  queryable?: Queryable;
}

export async function resolveEntityInDatabase(input: ResolutionInput, options: DatabaseResolutionOptions = {}): Promise<{ decision: ResolutionDecision; decisionId: number }> {
  const queryable = options.queryable ?? getPool();
  const candidates = await loadResolutionCandidates(input, queryable);
  const decision = await resolveEntity(input, candidates, options);
  const decisionId = await persistResolutionDecision(decision, input, {
    ...(options.claimId === undefined ? {} : { claimId: options.claimId }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    queryable,
  });
  return { decision, decisionId };
}
