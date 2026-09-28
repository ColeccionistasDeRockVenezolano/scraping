// CRV · Cotejo de la revisión de ingesta pendiente (2026-09-23). SOLO LECTURA.
//
// Para cada revisión low_confidence abierta (person.name / organization.*)
// reconstruye: el video de YouTube, el/los disco(s) enlazados, los hermanos de
// crédito del mismo video, los candidatos del ER vigentes (deterministas, sin
// DeepSeek) y las coincidencias de nombre en el core (nombre o alias).
// Escribe un JSONL en tmp-analysis/ingesta-review/cotejo.jsonl y un resumen.
//
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/ingesta-review-probe.mts
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../../src/db/client.js";
import { normalizeEntityName } from "../../src/normalization/entity-name.js";
import { resolutionThresholdsFromEnv } from "../../src/er/resolver.js";
import { resolveEntityDeterministically } from "../../src/er/scoring.js";
import type { ResolutionCandidate, ResolutionInput } from "../../src/er/types.js";

const OUT = "tmp-analysis/ingesta-review/cotejo.jsonl";

interface LowRow {
  review_id: string; claim_id: string; entity_kind: string; field: string;
  identity_key: string; identity_raw: string | null; source_slug: string;
  url: string | null; selector: string | null; excerpt: string | null;
  claim_status: string; created_at: string;
}

const pool = getPool();

const lows = (await pool.query<LowRow>(`
  SELECT r.id::text AS review_id, c.id::text AS claim_id, c.entity_kind::text, c.field,
         c.identity_key, c.identity_raw, s.slug AS source_slug,
         e.url, e.selector, e.excerpt, c.status::text AS claim_status, c.created_at::text
    FROM ingest.review_queue r
    JOIN ingest.claims c ON c.id = r.claim_a_id
    JOIN ingest.sources s ON s.id = c.source_id
    LEFT JOIN ingest.claim_evidence e ON e.claim_id = c.id
   WHERE r.kind='low_confidence' AND r.status='open'
   ORDER BY c.entity_kind, c.identity_key, r.id`)).rows;

// --- Índice del core -------------------------------------------------------
const persons = (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons ORDER BY id")).rows;
const personAliases = (await pool.query<{ person_id: string; alias: string }>("SELECT person_id::text, alias FROM ingest.person_aliases")).rows;
const orgs = (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.organizations ORDER BY id")).rows;
const orgAliases = (await pool.query<{ organization_id: string; alias: string }>("SELECT organization_id::text, alias FROM ingest.organization_aliases")).rows;

function indexOf(rows: Array<{ id: string; name: string }>, aliases: Array<Record<string, string>>, key: string): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  const add = (k: string, id: number) => { const s = index.get(k) ?? new Set<number>(); s.add(id); index.set(k, s); };
  for (const row of rows) add(normalizeEntityName(row.name).primaryKey, Number(row.id));
  for (const row of aliases) add(normalizeEntityName(row[key]!).primaryKey, Number((row[key === "person_id" ? "person_id" : "organization_id"])!));
  return index;
}
const personIndex = indexOf(persons, personAliases as never, "person_id");
const orgIndex = indexOf(orgs, orgAliases as never, "organization_id");

// --- Contexto por video ----------------------------------------------------
const urls = [...new Set(lows.map((l) => l.url).filter((u): u is string => Boolean(u)))];
const siblings = (await pool.query<{
  id: string; entity_kind: string; field: string; identity_key: string; status: string; slug: string;
  person_id: string | null; organization_id: string | null; album_id: string | null; url: string; selector: string | null; excerpt: string | null;
}>(`
  SELECT c.id::text, c.entity_kind::text, c.field, c.identity_key, c.status::text, s.slug,
         c.person_id::text, c.organization_id::text, c.album_id::text, e.url, e.selector, left(e.excerpt,200) AS excerpt
    FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
    JOIN ingest.claim_evidence e ON e.claim_id=c.id
   WHERE e.url = ANY($1::text[]) ORDER BY c.id`, [urls])).rows;
const siblingsByUrl = new Map<string, typeof siblings>();
for (const row of siblings) siblingsByUrl.set(row.url, [...(siblingsByUrl.get(row.url) ?? []), row]);

const videoAlbums = (await pool.query<{ video_id: string; album_id: string; album_title: string; artist_name: string; is_primary: boolean }>(`
  SELECT v.video_id, va.album_id::text, a.title AS album_title, ar.name AS artist_name, va.is_primary_link AS is_primary
    FROM media.youtube_videos v JOIN media.video_albums va ON va.video_id=v.id
    JOIN public.albums a ON a.id=va.album_id JOIN public.artists ar ON ar.id=a.artist_id`)).rows;
const albumByVideo = new Map<string, Array<{ id: number; title: string; artist: string; primary: boolean }>>();
const vidOfUrl = (url: string) => url.replace("https://www.youtube.com/watch?v=", "").split("&")[0]!;
for (const row of videoAlbums) albumByVideo.set(row.video_id, [...(albumByVideo.get(row.video_id) ?? []), { id: Number(row.album_id), title: row.album_title, artist: row.artist_name, primary: row.is_primary }]);

// Créditos aceptados en el core por disco (todas las fuentes) para contexto.
const creditsByAlbum = (await pool.query<{ album_id: string; person_id: string; person_name: string; credit_type: string; role: string; origin: string }>(`
  WITH ac AS (
    SELECT al.id AS album_id, p.id AS person_id, p.name AS person_name, ac.credit_type::text, ac.role, coalesce(ac.notes,'') AS origin
      FROM public.album_credits ac JOIN public.persons p ON p.id=ac.person_id JOIN public.albums al ON al.id=ac.album_id
    UNION ALL
    SELECT al.id, p.id, p.name, tc.credit_type::text, tc.role, coalesce(tc.notes,'')
      FROM public.track_credits tc JOIN public.persons p ON p.id=tc.person_id JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
  ) SELECT album_id::text, person_id::text, person_name, credit_type, role, origin FROM ac`)).rows;
const creditsIdx = new Map<number, Array<{ personId: number; name: string; type: string; role: string }>>();
for (const row of creditsByAlbum) {
  const list = creditsIdx.get(Number(row.album_id)) ?? [];
  list.push({ personId: Number(row.person_id), name: row.person_name, type: row.credit_type, role: row.role });
  creditsIdx.set(Number(row.album_id), list);
}

// Claims candidatos/accepted de la MISMA identidad en TODAS las fuentes (para saber si el nombre ya resolvió).
const sameIdentity = (await pool.query<{ id: string; entity_kind: string; identity_key: string; status: string; slug: string; person_id: string | null; organization_id: string | null; album_id: string | null; url: string | null; excerpt: string | null }>(`
  SELECT c.id::text, c.entity_kind::text, c.identity_key, c.status::text, s.slug, c.person_id::text, c.organization_id::text, c.album_id::text,
         (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS url,
         (SELECT left(e.excerpt,200) FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS excerpt
    FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
   WHERE c.identity_key = ANY($1::text[])`, [lows.map((l) => l.identity_key)])).rows;
const identityIdx = new Map<string, typeof sameIdentity>();
for (const row of sameIdentity) identityIdx.set(row.identity_key, [...(identityIdx.get(row.identity_key) ?? []), row]);

// Decisiones de resolución ER vivas registradas en la revisión (para no re-inventar).
const erReviews = (await pool.query<{ claim_a_id: string; kind: string; status: string; payload: Record<string, unknown>; person_a_id: string | null; organization_a_id: string | null }>(`
  SELECT r.claim_a_id::text, r.kind::text, r.status::text, r.payload, r.person_a_id::text, r.organization_a_id::text
    FROM ingest.review_queue r
   WHERE r.claim_a_id = ANY($1::bigint[]) AND r.kind IN ('person_match','organization_match','ambiguous_alias','manual_review')`, [lows.map((l) => Number(l.claim_id))])).rows;
const erByClaim = new Map<string, typeof erReviews>();
for (const row of erReviews) erByClaim.set(row.claim_a_id, [...(erByClaim.get(row.claim_a_id) ?? []), row]);

// --- Candidatos ER actuales (deterministas) --------------------------------
const personCandidates: ResolutionCandidate[] = persons.map((p) => ({ kind: "PERSON", id: Number(p.id), name: p.name, canonicalName: p.name, aliases: [], bands: [], roles: [], albumCredits: [], period: {} }));
const orgCandidates: ResolutionCandidate[] = orgs.map((o) => ({ kind: "ORGANIZATION", id: Number(o.id), name: o.name, canonicalName: o.name, aliases: [], location: {}, associatedAlbums: [], associatedPersons: [] }));

const out: string[] = [];
const summary = { total: lows.length, person: 0, organization: 0, actions: {} as Record<string, number> };

for (const low of lows) {
  const key = normalizeEntityName(low.identity_raw ?? low.identity_key).primaryKey;
  const isPerson = low.entity_kind === "person";
  const input: ResolutionInput = isPerson ? { kind: "PERSON", name: low.identity_raw ?? low.identity_key } : { kind: "ORGANIZATION", name: low.identity_raw ?? low.identity_key };
  const candidates = isPerson ? personCandidates : orgCandidates;
  const decision = resolveEntityDeterministically(input, candidates, resolutionThresholdsFromEnv());

  const nameHits = [...(isPerson ? personIndex : orgIndex).get(key) ?? []];
  const videoId = low.url ? vidOfUrl(low.url) : null;
  const albums = videoId ? (albumByVideo.get(videoId) ?? []) : [];
  const albumContext = albums.map((a) => ({
    albumId: a.id, title: a.title, artist: a.artist,
    credits: (creditsIdx.get(a.id) ?? []).filter((c) => nameHits.includes(c.personId)),
    allCreditsCount: creditsIdx.get(a.id)?.length ?? 0,
  }));
  const sameVideoClaims = (low.url ? siblingsByUrl.get(low.url) ?? [] : []).map((s) => `${s.entity_kind}:${s.identity_key}:${s.status}:${s.slug}`);
  const sameNameElsewhere = (identityIdx.get(low.identity_key) ?? []).map((s) => `${s.entity_kind}:${s.status}:${s.slug}:${s.album_id ?? "-"}:${(s.excerpt ?? "").slice(0, 60)}`);
  const erReview = (erByClaim.get(low.claim_id) ?? []).map((e) => ({ kind: e.kind, status: e.status, action: e.payload?.["action"], score: e.payload?.["score"], person_a: e.person_a_id, organization_a: e.organization_a_id }));

  const top = decision.candidates.slice(0, 5).map((c) => ({ id: c.candidateId, name: c.canonicalName, score: c.score, action: c.action, basis: c.nameBasis, contextSupport: c.hasContextSupport, hardConflicts: c.hardConflicts }));
  const record = {
    reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: low.entity_kind, field: low.field,
    identityKey: low.identity_key, identityRaw: low.identity_raw, excerpt: low.excerpt, selector: low.selector, url: low.url,
    videoId, albums: albumContext, decision: { action: decision.action, score: decision.score, explanation: decision.explanation, top },
    nameHits, sameVideoClaims, sameNameElsewhere, erReview,
  };
  out.push(JSON.stringify(record));
  if (isPerson) summary.person += 1; else summary.organization += 1;
  summary.actions[`${low.entity_kind}:${decision.action}`] = (summary.actions[`${low.entity_kind}:${decision.action}`] ?? 0) + 1;
}

writeFileSync(OUT, out.join("\n") + "\n");
console.log(JSON.stringify(summary, null, 2));
await closeDb();
