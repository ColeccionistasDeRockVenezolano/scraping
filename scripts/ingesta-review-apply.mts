// CRV · Aplicador de la revisión de ingesta pendiente (2026-09-23).
//
// Camino auditado, sin SQL directo: usa los mismos módulos que el CLI y la API
// (approveEntity / acceptReview / resolveReview) y deja run, nota firmada y
// diario. Procesa lotes pequeños y homogéneos, verifica cada ítem y anexa el
// resultado a un JSONL reanudable. Sin --confirm solo previsualiza.
//
//   tsx scripts/ingesta-review-apply.mts links  --limit=5              # previsualiza
//   tsx scripts/ingesta-review-apply.mts links  --limit=5 --confirm    # aplica
//   tsx scripts/ingesta-review-apply.mts rejects --limit=50 --confirm
//   tsx scripts/ingesta-review-apply.mts orgs   --limit=5 --confirm
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";
import { classifyPersonName } from "../src/review/person-junk.js";
import { approveEntity, dismissEntity } from "../src/review/approval.js";
import { acceptReview, rejectReview } from "../src/review/operator-review.js";
import { resolveReview } from "../src/review/queue.js";

const OPERATOR = "Hermes";
const PLAN = "tmp-analysis/ingesta-review/plan-links.json";
const RESULTS = "tmp-analysis/ingesta-review/aplicado.jsonl";

interface LinkPlan {
  reviewId: number; claimId: number; entityKind: "person" | "organization";
  identityKey: string; name: string; targetId: number; albumId: number; albumTitle: string;
  role: string; personMatchReviewId: number | null; reason: string;
}

function signed(note: string): string {
  return `[${OPERATOR}] ${note}`;
}

function logResult(row: Record<string, unknown>): void {
  appendFileSync(RESULTS, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

/** Contexto de un claim de persona/organización: disco del video y créditos aceptados. */
async function contextOf(claimId: number) {
  const pool = getPool();
  const claim = (await pool.query<{
    id: string; entity_kind: string; identity_key: string; identity_raw: string | null; field: string;
    url: string | null; excerpt: string | null;
  }>(`
    SELECT c.id::text, c.entity_kind::text, c.identity_key, c.identity_raw, c.field,
           (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS url,
           (SELECT e.excerpt FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS excerpt
      FROM ingest.claims c WHERE c.id=$1`, [claimId])).rows[0];
  if (!claim) throw new Error(`claim ${claimId} inexistente`);
  const videoId = claim.url?.replace("https://www.youtube.com/watch?v=", "").split("&")[0] ?? null;
  const albums = videoId === null ? [] : (await pool.query<{ album_id: string; title: string }>(`
    SELECT va.album_id::text, a.title FROM media.youtube_videos v
      JOIN media.video_albums va ON va.video_id=v.id JOIN public.albums a ON a.id=va.album_id
     WHERE v.video_id=$1`, [videoId])).rows;
  const albumIds = albums.map((row) => Number(row.album_id));
  const credits = albumIds.length === 0 ? [] : (await pool.query<{ person_id: string | null; organization_id: string | null; role: string; credit_type: string; album_id: string }>(`
    SELECT ac.person_id::text, ac.organization_id::text, ac.role, ac.credit_type::text, ac.album_id::text
      FROM public.album_credits ac WHERE ac.album_id = ANY($1::bigint[])
     UNION ALL
    SELECT tc.person_id::text, tc.organization_id::text, tc.role, tc.credit_type::text, t.album_id::text
      FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id WHERE t.album_id = ANY($1::bigint[])`,
    [albumIds])).rows;
  return { claim, videoId, albums, credits };
}

/** Personas cuyo nombre o alias coincide exactamente con la clave del claim. */
async function exactPersons(identityKey: string): Promise<number[]> {
  const { rows } = await getPool().query<{ id: string }>(`
    SELECT p.id::text FROM public.persons p WHERE lower(p.name)=$1
    UNION SELECT a.person_id::text FROM ingest.person_aliases a WHERE a.normalized_alias=$1`, [identityKey]);
  return rows.map((row) => Number(row.id));
}
async function exactOrganizations(identityKey: string): Promise<number[]> {
  const { rows } = await getPool().query<{ id: string }>(`
    SELECT o.id::text FROM public.organizations o WHERE lower(o.name)=$1
    UNION SELECT a.organization_id::text FROM ingest.organization_aliases a WHERE a.normalized_alias=$1`, [identityKey]);
  return rows.map((row) => Number(row.id));
}

/** Rol del claim (texto del excerpt antes de " by ") frente a los roles de los créditos. */
function roleTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-záéíóúñ0-9 ]+/gu, " ").split(/\s+/u).map((t) => t.replace(/s$/u, "")).filter((t) => t.length > 2));
}
function rolesOverlap(claimRole: string, creditRole: string, creditType: string): boolean {
  const a = roleTokens(claimRole);
  for (const b of [...roleTokens(creditRole), ...roleTokens(creditType)]) if (a.has(b) || [...a].some((t) => t.startsWith(b) || b.startsWith(t))) return true;
  return false;
}

/** Plan de enlaces: nombre exacto único + crédito aceptado en el disco del video. */
async function buildLinkPlan(): Promise<LinkPlan[]> {
  const pool = getPool();
  const lows = (await pool.query<{ review_id: string; claim_id: string; entity_kind: string; identity_key: string; identity_raw: string | null }>(`
    SELECT r.id::text AS review_id, c.id::text AS claim_id, c.entity_kind::text, c.identity_key, c.identity_raw
      FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id
     WHERE r.kind='low_confidence' AND r.status='open' AND c.field='name' AND c.entity_kind='person'
     ORDER BY r.id`)).rows;
  const plan: LinkPlan[] = [];
  for (const low of lows) {
    const { claim, albums, credits } = await contextOf(Number(low.claim_id));
    const key = normalizeEntityName(claim.identity_raw ?? claim.identity_key).primaryKey;
    const hits = await exactPersons(key);
    if (hits.length !== 1 || albums.length === 0) continue;
    const target = hits[0]!;
    const role = (claim.excerpt ?? "").split(" by ")[0] ?? "";
    const ctx = credits.filter((row) => row.person_id === String(target) && rolesOverlap(role, row.role, row.credit_type));
    if (ctx.length === 0) continue;
    // Sin resultados pendientes: la persona existe con el mismo nombre y el mismo
    // papel en el mismo disco que afirma el texto de la fuente.
    plan.push({
      reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person",
      identityKey: claim.identity_key, name: claim.identity_raw ?? claim.identity_key, targetId: target,
      albumId: Number(albums[0]!.album_id), albumTitle: albums[0]!.title, role,
      personMatchReviewId: null,
      reason: `Mismo nombre, mismo disco («${albums[0]!.title}») y misma función («${ctx[0]!.role}»): la persona ${target} ya tiene ese crédito aceptado.`,
    });
  }
  return plan;
}

/** Careo abierto del claim cuyo candidato guardado coincide con el destino. */
async function personMatchReview(claimId: number, targetId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ id: string }>(`
    SELECT r.id::text FROM ingest.review_queue r
     WHERE r.claim_a_id=$1 AND r.kind IN ('person_match','organization_match') AND r.status IN ('open','in_progress')
       AND r.payload->>'resolutionDecisionId' ~ '^[1-9][0-9]*$'
       AND (SELECT er.candidates->0->>'candidateId' FROM ingest.entity_resolution_decisions er
             WHERE er.id=(r.payload->>'resolutionDecisionId')::bigint) = $2::text
     ORDER BY r.id DESC LIMIT 1`, [claimId, targetId]);
  return rows[0] ? Number(rows[0].id) : null;
}

async function applyLink(item: LinkPlan, confirm: boolean): Promise<Record<string, unknown>> {
  const note = signed(item.reason);
  const result: Record<string, unknown> = { ...item, kind: "link" };
  if (!confirm) return { ...result, action: "preview" };

  // 1) Reejecuta el ER del claim: crea el careo fresco con el candidato actual.
  try {
    await approveEntity(item.entityKind, item.identityKey, note);
    result["approve"] = "applied";
  } catch (error) {
    result["approve"] = (error as Error).message.slice(0, 200);
  }
  // Si ya quedó enlazado (applied/unchanged), no hay careo que aceptar.
  const claimNow = (await getPool().query<{ status: string; person_id: string | null; organization_id: string | null }>(
    "SELECT status::text, person_id::text, organization_id::text FROM ingest.claims WHERE id=$1", [item.claimId])).rows[0];
  result["claimAfterApprove"] = claimNow;
  if (claimNow && claimNow.status !== "candidate") {
    result["action"] = "linked-direct";
  } else {
    const careo = await personMatchReview(item.claimId, item.targetId);
    if (careo === null) return { ...result, action: "blocked", detail: "sin careo fresco con el destino; queda abierto" };
    const accepted = await acceptReview(careo, { operator: OPERATOR, note: `${item.reason} (careo ${careo})`, targetId: item.targetId });
    result["careo"] = { reviewId: careo, status: accepted.status, runId: accepted.runId, detail: accepted.detail };
    result["action"] = "linked";
  }
  // 2) Cierra el aviso de baja confianza con nota firmada (el claim ya tiene destino coherente).
  const targetColumn = item.entityKind === "person" ? "person_id" : "organization_id";
  const after = (await getPool().query<{ status: string; target_id: string | null }>(
    `SELECT status::text, ${targetColumn}::text AS target_id FROM ingest.claims WHERE id=$1`, [item.claimId])).rows[0];
  if (after?.status === "accepted" && String(after.target_id) === String(item.targetId)) {
    await resolveReview(item.reviewId, "approved", signed(`${item.reason} (claim ${item.claimId} aceptado; careo con ${item.entityKind} ${item.targetId})`));
    result["lowReview"] = "approved";
  } else {
    result["lowReview"] = "left-open";
    result["action"] = "needs_review";
  }
  return result;
}

/** Plan de descartes: nombres que no son personas (demostrable por forma). */
async function buildRejectPlan() {
  const pool = getPool();
  const lows = (await pool.query<{ review_id: string; claim_id: string; identity_key: string; identity_raw: string | null; excerpt: string | null; n: string }>(`
    SELECT r.id::text AS review_id, c.id::text AS claim_id, c.identity_key, c.identity_raw, c.identity_key AS excerpt,
           (SELECT count(*) FROM ingest.review_queue r2 WHERE r2.claim_a_id=c.id AND r2.kind='low_confidence' AND r2.status='open')::text AS n
      FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id
     WHERE r.kind='low_confidence' AND r.status='open' AND c.field='name' AND c.entity_kind='person'
     ORDER BY r.id`)).rows;
  const out: Array<{ reviewId: number; claimId: number; entityKind: string; identityKey: string; name: string; targetId: number; reason: string }> = [];
  for (const low of lows) {
    const name = low.identity_raw ?? low.identity_key;
    const cls = classifyPersonName(name);
    if (cls.kind === "ok") continue;
    if (cls.kind === "fragment" && (name.trim().length >= 3 && !/^(tema|part|track|cara|lado)/iu.test(name.trim()))) continue; // fragment por comillas impares u otro: revisar a mano
    out.push({
      reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person",
      identityKey: low.identity_key, name, targetId: 0,
      reason: `El texto no es un nombre de persona (${cls.kind}: ${cls.reason}); el candidato de persona es falso.`,
    });
  }
  return out;
}

/** Plan de organizaciones: nombre exacto en el catálogo y crédito del disco. */
async function buildOrgPlan() {
  const pool = getPool();
  const lows = (await pool.query<{ review_id: string; claim_id: string; identity_key: string; identity_raw: string | null }>(`
    SELECT r.id::text AS review_id, c.id::text AS claim_id, c.identity_key, c.identity_raw
      FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id
     WHERE r.kind='low_confidence' AND r.status='open' AND c.field='name' AND c.entity_kind='organization'
     ORDER BY r.id`)).rows;
  const out: LinkPlan[] = [];
  for (const low of lows) {
    const { claim, albums, credits } = await contextOf(Number(low.claim_id));
    const key = normalizeEntityName(claim.identity_raw ?? claim.identity_key).primaryKey;
    const hits = await exactOrganizations(key);
    if (hits.length !== 1 || albums.length === 0) continue;
    const target = hits[0]!;
    const role = (claim.excerpt ?? "").split(" by ")[0] ?? "";
    const ctx = credits.filter((row) => row.organization_id === String(target) && rolesOverlap(role, row.role, row.credit_type));
    if (ctx.length === 0) continue;
    out.push({
      reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "organization",
      identityKey: claim.identity_key, name: claim.identity_raw ?? claim.identity_key, targetId: target,
      albumId: Number(albums[0]!.album_id), albumTitle: albums[0]!.title, role, personMatchReviewId: null,
      reason: `Mismo nombre y mismo disco («${albums[0]!.title}»): la organización ${target} ya tiene ese crédito aceptado («${ctx[0]!.role}»). Solo se enlaza el nombre; tipo y país quedan pendientes.`,
    });
  }
  return out;
}

async function applyReject(item: { reviewId: number; claimId: number; entityKind: string; identityKey: string; name: string; reason: string }, confirm: boolean): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...item, kind: "reject" };
  if (!confirm) return { ...result, action: "preview" };
  try {
    const dismissal = await dismissEntity(item.entityKind, item.identityKey, signed(item.reason));
    // Los avisos de tipo/país de la misma identidad (si los hubiera) no se tocan: solo se descarta el nombre de persona.
    await resolveReview(item.reviewId, "dismissed", signed(item.reason));
    return { ...result, action: "rejected", reviewsClosed: dismissal.reviewsClosed };
  } catch (error) {
    return { ...result, action: "error", error: (error as Error).message.slice(0, 200) };
  }
}

/** Índice compacto de todas las personas (caza duplicados que la comparación SQL no ve). */
let allPersonsCompactCache: Map<string, number> | undefined;
async function allPersonsCompactIndex(): Promise<Map<string, number>> {
  if (allPersonsCompactCache === undefined) {
    const { rows } = await getPool().query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons");
    allPersonsCompactCache = new Map(rows.map((row) => [normalizeEntityName(row.name).compactSecondaryKey, Number(row.id)]));
  }
  return allPersonsCompactCache;
}

/** Candidato n.º 1 del ER en el careo abierto más reciente del claim. */
async function topCandidateOf(claimId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ id: string | null }>(`
    SELECT (SELECT er.candidates->0->>'candidateId' FROM ingest.entity_resolution_decisions er
             WHERE er.id = (r.payload->>'resolutionDecisionId')::bigint) AS id
      FROM ingest.review_queue r
     WHERE r.claim_a_id=$1 AND r.kind IN ('person_match','organization_match') AND r.status IN ('open','in_progress')
       AND r.payload->>'resolutionDecisionId' ~ '^[1-9][0-9]*$'
     ORDER BY r.id DESC LIMIT 1`, [claimId]);
  const value = rows[0]?.id;
  return value === null || value === undefined ? null : Number(value);
}

/** Plan de altas: nombres completos sin homónimo exacto (aprobado 2026-09-23). */
async function buildCreatePlan() {
  const pool = getPool();
  const allPersonsCompact = await allPersonsCompactIndex();
  const lows = (await pool.query<{ review_id: string; claim_id: string; identity_key: string; identity_raw: string | null; excerpt: string | null }>(`
    SELECT r.id::text AS review_id, c.id::text AS claim_id, c.identity_key, c.identity_raw,
           (SELECT e.excerpt FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS excerpt
      FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id
     WHERE r.kind='low_confidence' AND r.status='open' AND c.field='name' AND c.entity_kind='person'
     ORDER BY r.id`)).rows;
  const out: Array<{ reviewId: number; claimId: number; entityKind: string; identityKey: string; name: string; targetId: number; reason: string; skip?: string }> = [];
  for (const low of lows) {
    const name = (low.identity_raw ?? "").trim();
    const cls = classifyPersonName(name);
    if (cls.kind !== "ok") { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: `forma no de persona (${cls.kind})` }); continue; }
    const tokens = name.split(/\s+/u).filter(Boolean);
    if (tokens.length < 2) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: "nombre de una sola palabra" }); continue; }
    // Iniciales o abreviaturas: no se expanden ni se crean por intuición.
    if (tokens.some((token) => /^\p{L}\.?$/u.test(token) || /^\p{L}\.$/u.test(token))) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: "trae iniciales o abreviatura" }); continue; }
    const { claim } = await contextOf(Number(low.claim_id));
    const key = normalizeEntityName(name).primaryKey;
    if (/[@:;]|%(?=\s|$)/u.test(name)) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: "el nombre trae artefactos (@, :, %)" }); continue; }
    if ((await exactPersons(key)).length > 0) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: "apareció un homónimo exacto después del plan" }); continue; }
    // Duplicado por puntuación/compacto (la comparación SQL de lower() no ve
    // «100% Poindexther» vs «100 Poindexther» ni «Henry Martinez» vs «Henry Martínez»).
    const compact = normalizeEntityName(name).compactSecondaryKey;
    const quoted = /\s*["“”«»][^"“”«»]*["“”«»]\s*/u;
    const bare = name.replace(quoted, " ").trim();
    const nickOnly = bare.split(/\s+/u).length < 2;
    if (nickOnly) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: "apodo sin nombre completo" }); continue; }
    const bareCompact = normalizeEntityName(bare).compactSecondaryKey;
    const dup = allPersonsCompact.get(compact) ?? allPersonsCompact.get(bareCompact);
    if (dup !== undefined) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: `duplicaría a la persona ${dup} («${name}» vs el nombre ya catalogado)` }); continue; }
    // Subconjunto de tokens del candidato del ER (versión corta/larga de un mismo nombre).
    const topId = await topCandidateOf(Number(low.claim_id));
    if (topId !== null) {
      const topName = (await pool.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [topId])).rows[0]?.name;
      if (topName) {
        const mine = new Set(tokens.map((token) => normalizeEntityName(token).compactSecondaryKey).filter(Boolean));
        const theirs = new Set(topName.split(/\s+/u).map((token) => normalizeEntityName(token).compactSecondaryKey).filter(Boolean));
        const subset = ([small, big]: [Set<string>, Set<string>]) => [...small].every((token) => big.has(token));
        if (subset([mine, theirs]) || subset([theirs, mine])) {
          out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: `es una versión corta/larga de «${topName}» (${topId})` });
          continue;
        }
      }
    }
    // Guarda anti-banda: el nombre del artista del disco y el de cualquier
    // artista del catálogo no se crean como persona.
    const artistNames = new Set<string>();
    if (claim.url) {
      const vid = claim.url.replace("https://www.youtube.com/watch?v=", "").split("&")[0]!;
      for (const row of (await pool.query<{ name: string }>(`
        SELECT ar.name FROM media.youtube_videos v JOIN media.video_albums va ON va.video_id=v.id
          JOIN public.albums a ON a.id=va.album_id JOIN public.artists ar ON ar.id=a.artist_id WHERE v.video_id=$1`, [vid])).rows) artistNames.add(normalizeEntityName(row.name).compactSecondaryKey);
    }
    if (artistNames.has(normalizeEntityName(name).compactSecondaryKey)) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: "es el nombre del artista del disco" }); continue; }
    const artistHit = await pool.query<{ name: string }>("SELECT name FROM public.artists WHERE lower(btrim(name)) = lower(btrim($1)) LIMIT 1", [name]);
    if (artistHit.rows[0]) { out.push({ reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person", identityKey: low.identity_key, name, targetId: 0, reason: "", skip: `coincide con el artista «${artistHit.rows[0].name}»` }); continue; }
    out.push({
      reviewId: Number(low.review_id), claimId: Number(low.claim_id), entityKind: "person",
      identityKey: low.identity_key, name, targetId: 0,
      reason: `Nombre completo de persona acreditada en el texto de la fuente («${low.excerpt ?? ""}») sin ficha en el catálogo: se crea la ficha (aprobado por el propietario 2026-09-23). Sin candidato de identidad exacto en el catálogo.`,
    });
  }
  return out;
}

async function applyCreate(item: { reviewId: number; claimId: number; entityKind: string; identityKey: string; name: string; reason: string }, confirm: boolean): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...item, kind: "create" };
  if (!confirm) return { ...result, action: "preview" };
  const note = signed(item.reason);
  let personId: number | undefined;
  try {
    const approval = await approveEntity("person", item.identityKey, note);
    personId = approval.targetId;
    result["approve"] = { applied: approval.applied, unchanged: approval.unchanged, stillCandidate: approval.stillCandidate, targetId: approval.targetId };
  } catch (error) {
    result["approve"] = (error as Error).message.slice(0, 200);
  }
  const after = (await getPool().query<{ status: string; person_id: string | null; target: string | null }>(
    "SELECT status::text, person_id::text, person_id::text AS target FROM ingest.claims WHERE id=$1", [item.claimId])).rows[0];
  if (after?.status === "accepted" && after.person_id) {
    personId = Number(after.person_id);
    result["action"] = "created";
  } else {
    // El ER no la creó (candidato fuzzy): el careo fresco se rechaza como «no es
    // ninguno de los mostrados» y eso habilita la creación por la vía humana.
    const careo = await freshCareo(item.claimId);
    if (careo === null) return { ...result, action: "blocked", detail: "sin careo fresco; queda abierto" };
    try {
      const rejected = await rejectReview(careo, { operator: OPERATOR, note: `${item.reason} Ninguno de los candidatos mostrados es esta persona (careo ${careo}).` });
      result["careo"] = { reviewId: careo, status: rejected.status, runId: rejected.runId, detail: rejected.detail };
    } catch (error) {
      return { ...result, action: "blocked", detail: (error as Error).message.slice(0, 200) };
    }
    const created = (await getPool().query<{ status: string; person_id: string | null }>(
      "SELECT status::text, person_id::text FROM ingest.claims WHERE id=$1", [item.claimId])).rows[0];
    if (created?.status !== "accepted" || !created.person_id) return { ...result, action: "blocked", detail: `la creación no se aplicó: ${JSON.stringify(created)}` };
    personId = Number(created.person_id);
    result["action"] = "created";
  }
  await resolveReview(item.reviewId, "approved", signed(`${item.reason} Persona ${personId} creada (claim ${item.claimId}).`));
  result["personId"] = personId;
  result["lowReview"] = "approved";
  return result;
}

/** Careo abierto del claim (cualquier candidato), el más reciente. */
async function freshCareo(claimId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ id: string }>(`
    SELECT id::text FROM ingest.review_queue
     WHERE claim_a_id=$1 AND kind IN ('person_match','organization_match') AND status IN ('open','in_progress')
     ORDER BY id DESC LIMIT 1`, [claimId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** Política de organización (aprobada 2026-09-23): tipo solo si el texto lo dice; país literal. */
async function applyOrgFields(confirm: boolean): Promise<number> {
  const pool = getPool();
  const conflicts = (await pool.query<{ id: string; claim_b_id: string; value_a: string; value_b: string; excerpt: string | null; identity_key: string }>(`
    SELECT cf.id::text, cf.claim_b_id::text, cf.value_a::text, cf.value_b::text,
           (SELECT e.excerpt FROM ingest.claim_evidence e WHERE e.claim_id=cf.claim_b_id ORDER BY e.id LIMIT 1) AS excerpt,
           (SELECT c.identity_key FROM ingest.claims c WHERE c.id=cf.claim_b_id) AS identity_key
      FROM ingest.conflicts cf
     WHERE cf.status='open' AND cf.entity_kind='organization' AND cf.field='organization_type'
       AND cf.claim_b_id IN (SELECT r.claim_a_id FROM ingest.review_queue r WHERE r.kind='low_confidence' AND r.status='open')
     ORDER BY cf.id`)).rows;
  let done = 0;
  for (const row of conflicts) {
    const text = row.excerpt ?? "";
    const supported = /recorded at|recording studios?|mixed at|mastered at|grabado en|estudios? /iu.test(text);
    const choice = supported ? "b" : "a";
    const note = signed(`Política de tipo de organización: el texto «${text}» ${supported ? "sí" : "no"} sostiene el estudio de grabación; se conserva ${supported ? "la propuesta" : "el tipo ya afirmado"} (conflicto ${row.id}).`);
    if (!confirm) { console.log(`  ${supported ? "→ estudio" : "→ conserva"} · ${row.identity_key} · «${text}»`); done += 1; continue; }
    try {
      const { resolveOpenConflict } = await import("../src/review/operator-review.js");
      const result = await resolveOpenConflict(Number(row.id), { operator: OPERATOR, note, choice });
      logResult({ reviewId: null, claimId: Number(row.claim_b_id), kind: "org-type", action: `conflict_${choice}`, runId: result.runId, identityKey: row.identity_key, excerpt: text });
      const review = (await pool.query<{ id: string }>(
        "SELECT id::text FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='low_confidence' AND status IN ('open','in_progress') ORDER BY id LIMIT 1", [Number(row.claim_b_id)])).rows[0];
      if (review) await resolveReview(Number(review.id), "approved", signed(`Cotejo de tipo de organización resuelto (conflicto ${row.id}; run ${result.runId}): ${supported ? "la fuente sostiene el estudio de grabación" : "se conserva el tipo ya afirmado"}.`));
      done += 1;
      console.log(`  ✓ ${row.identity_key}: ${choice === "b" ? "recording_studio" : "conserva el tipo"} (run ${result.runId})`);
    } catch (error) {
      console.log(`  ! ${row.identity_key}: ${(error as Error).message.slice(0, 160)}`);
    }
  }
  return done;
}

async function main(): Promise<number> {
  const [mode] = process.argv.slice(2);
  const confirm = process.argv.includes("--confirm");
  const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? "0") || Number.MAX_SAFE_INTEGER;
  if (!existsSync("tmp-analysis/ingesta-review")) { console.error("falta tmp-analysis/ingesta-review"); return 1; }

  if (mode === "plan") {
    const plan = await buildLinkPlan();
    writeFileSync(PLAN, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`plan de enlaces: ${plan.length} ítems → ${PLAN}`);
    console.log(JSON.stringify(plan.slice(0, 3), null, 2));
    await closeDb();
    return 0;
  }
  if (mode === "rejects" || mode === "orgs") {
    const plan = mode === "rejects" ? await buildRejectPlan() : await buildOrgPlan();
    const file = mode === "rejects" ? "tmp-analysis/ingesta-review/plan-rejects.json" : "tmp-analysis/ingesta-review/plan-orgs.json";
    writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`${mode}: ${plan.length} ítems`);
    for (const item of plan.slice(0, 40)) {
      console.log(`  rev ${item.reviewId} · ${item.name} → ${JSON.stringify(item.reason).slice(0, 130)}`);
    }
    if (plan.length > 40) console.log(`  … y ${plan.length - 40} más`);
    if (!confirm) { console.log(`(previsualización) para aplicar: ${mode} --confirm`); await closeDb(); return 0; }
    let ok = 0, bad = 0;
    for (const item of plan) {
      const result = mode === "rejects" ? await applyReject(item as never, true) : await applyLink(item as LinkPlan, true);
      logResult(result);
      if (result["action"] === "rejected" || result["action"] === "linked" || result["action"] === "linked-direct") ok += 1;
      else { bad += 1; console.log(`  ! ${JSON.stringify(result).slice(0, 220)}`); }
    }
    console.log(`resultado ${mode}: ${ok} aplicados, ${bad} bloqueados/errores`);
    await closeDb();
    return 0;
  }
  if (mode === "orgs-fields") {
    const n = await applyOrgFields(confirm);
    console.log(`política de organización: ${n} conflictos de tipo ${confirm ? "resueltos" : "por resolver"}`);
    await closeDb();
    return 0;
  }
  if (mode === "creates") {
    const planAll = await buildCreatePlan();
    const file = "tmp-analysis/ingesta-review/plan-creates.json";
    writeFileSync(file, `${JSON.stringify(planAll, null, 2)}\n`);
    const todo = planAll.filter((item) => item.skip === undefined).slice(0, limit);
    const skipped = planAll.filter((item) => item.skip !== undefined);
    console.log(`altas: ${todo.length} a crear · ${skipped.length} omitidas por guarda`);
    for (const item of todo.slice(0, 20)) console.log(`  + rev ${item.reviewId} · ${item.name} · «${item.reason.slice(0, 60)}…»`);
    if (!confirm) { console.log("(previsualización) para aplicar: creates --confirm"); await closeDb(); return 0; }
    let ok = 0, bad = 0;
    for (const item of todo) {
      try {
        const result = await applyCreate(item, true);
        logResult(result);
        if (result["action"] === "created") ok += 1; else { bad += 1; console.log(`  ! ${JSON.stringify(result).slice(0, 200)}`); }
      } catch (error) {
        bad += 1;
        logResult({ reviewId: item.reviewId, claimId: item.claimId, kind: "create", action: "error", error: (error as Error).message.slice(0, 200) });
      }
    }
    console.log(`resultado creates: ${ok} creadas, ${bad} bloqueadas/errores`);
    await closeDb();
    return 0;
  }
  if (mode === "links") {
    const planAll: LinkPlan[] = JSON.parse(readFileSync(PLAN, "utf8"));
    // Reanudable: solo las revisiones que siguen abiertas.
    const open = new Set((await getPool().query<{ id: string }>(
      "SELECT id::text FROM ingest.review_queue WHERE kind='low_confidence' AND status IN ('open','in_progress')")).rows.map((row) => Number(row.id)));
    const plan = planAll.filter((item) => open.has(item.reviewId)).slice(0, limit);
    console.log(`${confirm ? "APLICANDO" : "previsualizando"} ${plan.length} enlaces`);
    let ok = 0, blocked = 0;
    for (const [index, item] of plan.entries()) {
      try {
        const result = await applyLink(item, confirm);
        logResult(result);
        if (result["action"] === "linked" || result["action"] === "linked-direct") ok += 1; else blocked += 1;
        if ((index + 1) % 25 === 0) console.log(`  … ${index + 1}/${plan.length} (ok=${ok} bloqueados=${blocked})`);
      } catch (error) {
        blocked += 1;
        logResult({ reviewId: item.reviewId, claimId: item.claimId, kind: "link", action: "error", error: (error as Error).message.slice(0, 300) });
        console.log(`  ! review ${item.reviewId}: ${(error as Error).message.slice(0, 160)}`);
      }
    }
    console.log(`resultado: ${ok} aplicados, ${blocked} bloqueados/errores`);
    await closeDb();
    return 0;
  }
  console.error("uso: ingesta-review-apply.mts plan|links [--limit=N] [--confirm]");
  await closeDb();
  return 1;
}

await main();
