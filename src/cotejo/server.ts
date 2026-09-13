// CRV · Mesa de Cotejo — servicio de decisiones.
//
// La página es un archivo único y navegable; este servicio le da las dos
// cosas que un archivo estático no puede tener: datos vivos de la cola y una
// memoria compartida de lo que el equipo va decidiendo.
//
// Tres decisiones de diseño que conviene ver explicadas:
//
//  * DECIDIR NO ES RESOLVER. Nada de lo que se guarda aquí toca el core ni
//    cierra una revisión. `ingest.review_decisions` registra la intención
//    humana; aplicarla es un paso posterior y auditado. Por eso deshacer es
//    posible: no hay nada que revertir todavía.
//  * DESHACER NO BORRA. Retirar una decisión la marca `withdrawn` y conserva
//    quién la tomó y cuándo. Un equipo que cambia de opinión deja rastro.
//  * SOLO EN EL TAILNET. Se publica con
//    `tailscale serve --bg --https=9444 http://127.0.0.1:4310`, no bajo
//    /public: esa ruta va por Funnel y sale a internet abierto, y aquí hay
//    nombres de personas sin revisar. Ojo con el puerto: 8443 ya lo ocupa
//    otro servicio de la máquina en todas las interfaces, así que Tailscale
//    no llega a escuchar y el navegador acaba viendo el certificado del otro
//    (ERR_CERT_AUTHORITY_INVALID). Elige un puerto libre y compruébalo con
//    `openssl s_client` antes de repartir el enlace.
//  * EL VISOR AGRUPA POR FORMA. La cola tiene ~100.000 ítems y nadie los mira
//    de uno en uno. Lo útil no es paginarla sino decir en qué se parecen: el
//    endpoint /api/groups clasifica los candidatos por la forma de su nombre,
//    que es donde aparecen los defectos de extracción.
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("cotejo");
const PAGE = path.resolve(process.cwd(), "public/cotejo.html");

function pageVersion(html: string): string {
  return html.match(/<meta name="crv-cotejo-build" content="([a-f0-9]{16})">/)?.[1] ?? "unknown";
}

// Una misma pregunta llega repetida en varias filas de la cola (cuatro fichas
// distintas para el mismo "Melissa"). La página agrupa por lo que se decide,
// así que el cuerpo acepta la lista entera y las resuelve en una transacción.
// Los id de la cola son bigint, y node-postgres los entrega como cadena para no
// perder precisión: el JSON que la página lleva incrustado los conserva así.
// Filtrar por Number.isInteger descartaba "3331" entero y dejaba la lista vacía,
// con lo que cada clic acababa en un 400 y nada se guardaba. Se aceptan las dos
// formas y se normalizan aquí, que es el borde por donde entra el dato.
type ReviewId = number | string;
interface DecisionChoice { reviewIds?: ReviewId[]; reviewId?: ReviewId; verdict?: string; }
interface DecisionBody extends DecisionChoice {
  choices?: DecisionChoice[];
  decidedBy: string;
  note?: string;
  context?: unknown;
}
function idsOf(body: { reviewIds?: ReviewId[]; reviewId?: ReviewId }): number[] {
  const list = body.reviewIds ?? (body.reviewId === undefined ? [] : [body.reviewId]);
  const ids = list.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

interface NormalizedDecisionChoice { reviewIds: number[]; verdict: string; }
function choicesOf(body: DecisionBody): NormalizedDecisionChoice[] {
  const raw = body.choices ?? [body];
  return raw.map((choice) => ({ reviewIds: idsOf(choice), verdict: choice.verdict ?? "" }));
}

const VERDICTS = new Set(["same", "different", "unsure", "canonical", "proposed", "approve", "reject"]);
const MATCH_REVIEW_KINDS = new Set(["album_match", "person_match", "organization_match"]);
function verdictFitsReview(kind: string, verdict: string): boolean {
  if (MATCH_REVIEW_KINDS.has(kind)) return verdict === "same" || verdict === "different" || verdict === "unsure";
  if (kind === "field_conflict") return verdict === "canonical" || verdict === "proposed" || verdict === "unsure";
  return verdict === "approve" || verdict === "reject" || verdict === "unsure";
}

/** Clasificación por forma del nombre: es donde asoman los defectos. */
const GROUP_SQL = `
  WITH cand AS (
    SELECT c.entity_kind::text AS entity_kind, s.slug AS source,
           c.raw_value #>> '{}' AS name, q.id AS review_id, c.identity_key,
           c.confidence::text AS confidence, ev.url AS evidence_url, ev.excerpt AS evidence_excerpt
      FROM ingest.review_queue q
      JOIN ingest.claims c ON c.id = q.claim_a_id
      JOIN ingest.sources s ON s.id = c.source_id
      LEFT JOIN LATERAL (
        SELECT e.url,e.excerpt FROM ingest.claim_evidence e
         WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1
      ) ev ON true
     WHERE q.kind = 'low_confidence' AND q.status = 'open'
       AND c.field = 'name' AND c.entity_kind::text = ANY($1::text[])
       AND ($2::text IS NULL OR s.slug = $2)
  ), shaped AS (
    SELECT *, CASE
      WHEN name ~ '[;]' OR name ~* '\\m(except|salvo)\\M' THEN 'con_salvedad'
      WHEN name ~ '\\(' OR name ~ '\\[' THEN 'con_parentesis'
      WHEN name ~ ',' THEN 'con_coma'
      WHEN name ~ '\\m(1[89]\\d{2}|20\\d{2})\\M' THEN 'con_anio'
      WHEN name ~* '(records|studios?|mastering)\\s*$' THEN 'sello_o_estudio'
      WHEN array_length(regexp_split_to_array(btrim(name), '\\s+'), 1) > 5 THEN 'muy_largo'
      WHEN name ~ '"' THEN 'con_apodo'
      WHEN array_length(regexp_split_to_array(btrim(name), '\\s+'), 1) = 1 THEN 'una_palabra'
      ELSE 'nombre_llano' END AS shape
      FROM cand
  )
  SELECT shape, entity_kind, count(*)::int AS n,
         source,
         (array_agg(jsonb_build_object(
           'name',name,'source',source,'reviewId',review_id,'identityKey',identity_key,
           'confidence',confidence,'evidenceUrl',evidence_url,'evidenceExcerpt',evidence_excerpt
         ) ORDER BY random()))[1:8] AS samples,
         (array_agg(review_id ORDER BY random()))[1:8] AS review_ids
    FROM shaped GROUP BY shape, entity_kind, source ORDER BY n DESC`;

export function buildServer() {
  const app = Fastify({ logger: false });

  // Si la mesa sale por Funnel, sale a internet abierto y aquí hay nombres de
  // personas sin revisar. Que se pueda abrir el enlace es una cosa; que Google
  // archive esos nombres y los siga mostrando después de corregirlos es otra.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    // La mesa muestra decisiones y cola vivas: nunca debe servirse una copia
    // vieja desde el navegador o desde el proxy.
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
  });

  app.get("/", async (_request, reply) => {
    const html = await readFile(PAGE, "utf8");
    reply.header("X-CRV-Cotejo-Version", pageVersion(html));
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get("/health", async () => {
    const html = await readFile(PAGE, "utf8");
    return { ok: true, version: pageVersion(html) };
  });

  app.get("/api/state", async () => {
    const pool = getPool();
    const [core, queues, candidates, decisions, youtube, readiness, audit] = await Promise.all([
      pool.query(`SELECT (SELECT count(*) FROM artists) artists,(SELECT count(*) FROM albums) albums,
                         (SELECT count(*) FROM tracks) tracks,(SELECT count(*) FROM persons) persons,
                         (SELECT count(*) FROM organizations) organizations,
                         (SELECT count(*) FROM album_credits) album_credits,
                         (SELECT count(*) FROM track_credits) track_credits`),
      pool.query(`SELECT kind::text AS kind, count(*)::int AS open FROM ingest.review_queue WHERE status='open' GROUP BY 1 ORDER BY 2 DESC`),
      pool.query(`SELECT s.slug AS source, c.entity_kind, count(*)::int AS claims, count(DISTINCT c.identity_key)::int AS entities
                    FROM ingest.review_queue q JOIN ingest.claims c ON c.id=q.claim_a_id JOIN ingest.sources s ON s.id=c.source_id
                   WHERE q.kind='low_confidence' AND q.status='open' GROUP BY 1,2 ORDER BY 1,3 DESC`),
      pool.query(`SELECT review_id, verdict, decided_by, note, decided_at FROM ingest.review_decisions
                   WHERE status='active' ORDER BY decided_at DESC`),
      pool.query(`SELECT
        (SELECT count(*)::int FROM albums) AS albums_total,
        (SELECT count(DISTINCT album_id)::int FROM media.video_albums) AS albums_linked,
        (SELECT count(*)::int FROM media.video_albums WHERE is_primary_link) AS primary_links,
        (SELECT count(*)::int FROM albums WHERE youtube_url IS NOT NULL) AS legacy_album_urls,
        (SELECT count(*)::int FROM media.youtube_videos) AS videos_total,
        (SELECT count(*)::int FROM media.youtube_videos WHERE last_fetched_at IS NOT NULL) AS videos_hydrated,
        (SELECT count(*)::int FROM media.youtube_videos WHERE last_fetched_at IS NULL) AS videos_pending,
        (SELECT count(*)::int FROM media.youtube_channels) AS channels,
        (SELECT count(*)::int FROM ingest.seed_uploads) AS seed_rows,
        (SELECT count(*)::int FROM ingest.seed_uploads WHERE video_id IS NOT NULL) AS seed_with_video`),
      pool.query(`SELECT
        (SELECT count(*)::int FROM ingest.review_queue WHERE status='open') AS reviews_open,
        (SELECT count(*)::int FROM ingest.review_queue q WHERE q.status='open'
          AND (q.kind='field_conflict' OR
            (q.kind IN ('album_match','person_match','organization_match')
              AND q.payload ? 'resolutionDecisionId'
              AND EXISTS(SELECT 1 FROM ingest.claims c WHERE c.id=q.claim_a_id AND c.status='candidate')))) AS comparisons_open,
        (SELECT count(DISTINCT d.review_id)::int FROM ingest.review_decisions d
          JOIN ingest.review_queue q ON q.id=d.review_id
          WHERE d.status='active' AND q.status='open'
            AND (q.kind='field_conflict' OR
              (q.kind IN ('album_match','person_match','organization_match') AND q.payload ? 'resolutionDecisionId'
                AND EXISTS(SELECT 1 FROM ingest.claims c WHERE c.id=q.claim_a_id AND c.status='candidate')))) AS decisions_marked,
        (SELECT count(*)::int FROM ingest.review_decisions
          WHERE status='active' AND applied_at IS NOT NULL) AS decisions_applied,
        (SELECT count(*)::int FROM ingest.review_decisions
          WHERE status='active' AND applied_at IS NULL AND verdict<>'unsure') AS decisions_pending,
        (SELECT count(*)::int FROM ingest.review_decisions
          WHERE status='active' AND applied_at IS NULL AND verdict='unsure') AS decisions_unsure,
        (SELECT count(*)::int FROM ingest.conflicts WHERE status='open') AS conflicts_open,
        (SELECT count(*)::int FROM ingest.claims WHERE status='candidate') AS claims_candidate,
        (SELECT count(*)::int FROM ingest.claims WHERE status='accepted') AS claims_accepted,
        (SELECT count(DISTINCT source_id)::int FROM ingest.claims) AS sources_with_claims,
        (SELECT count(*)::int FROM ingest.sources WHERE enabled) AS sources_enabled,
        (SELECT count(*)::int FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
          WHERE s.slug='yt-master-seed' AND c.status='candidate') AS seed_claims_pending`),
      pool.query(`SELECT
        (SELECT count(*)::int FROM ingest.merge_audit) AS rows,
        (SELECT count(*)::int FROM ingest.merge_audit ma
          WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit_claims mac WHERE mac.merge_audit_id=ma.id)) AS unlinked,
        (SELECT count(*)::int FROM (
          SELECT a.id FROM artists a WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.artist_id=a.id)
          UNION ALL SELECT p.id FROM persons p WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.person_id=p.id)
          UNION ALL SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.organization_id=o.id)
          UNION ALL SELECT a.id FROM albums a WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.album_id=a.id)
          UNION ALL SELECT t.id FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.track_id=t.id)
          UNION ALL SELECT am.id FROM artist_members am WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.artist_membership_id=am.id)
          UNION ALL SELECT po.id FROM person_organizations po WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.person_organization_id=po.id)
          UNION ALL SELECT ac.id FROM album_credits ac WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.album_credit_id=ac.id)
          UNION ALL SELECT tc.id FROM track_credits tc WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.track_credit_id=tc.id)
          UNION ALL SELECT af.id FROM album_formats af WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.album_format_id=af.id)
          UNION ALL SELECT ml.id FROM media.media_links ml WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.media_link_id=ml.id)
        ) missing) AS unaudited,
        (SELECT status::text FROM ingest.scrape_runs
          WHERE kind='merge_run' AND params->>'action'='apply_review_decisions'
          ORDER BY id DESC LIMIT 1) AS last_apply_status,
        (SELECT finished_at FROM ingest.scrape_runs
          WHERE kind='merge_run' AND params->>'action'='apply_review_decisions'
          ORDER BY id DESC LIMIT 1) AS last_apply_at`),
    ]);
    return {
      snapshot: new Date().toISOString(),
      core: core.rows[0], queues: queues.rows, candidates: candidates.rows,
      decisions: decisions.rows.map((row) => ({
        reviewId: Number(row.review_id), verdict: row.verdict, decidedBy: row.decided_by,
        note: row.note, decidedAt: row.decided_at,
      })),
      youtube: youtube.rows[0], readiness: readiness.rows[0], audit: audit.rows[0],
    };
  });

  app.get("/api/groups", async (request) => {
    const query = request.query as { source?: string; kinds?: string };
    const kinds = (query.kinds ?? "person,organization,artist").split(",").map((k) => k.trim()).filter(Boolean);
    const { rows } = await getPool().query(GROUP_SQL, [kinds, query.source ?? null]);
    return { groups: rows };
  });

  app.get("/api/sample", async (request) => {
    const query = request.query as { source?: string; kind?: string; n?: string };
    const size = Math.min(50, Math.max(1, Number(query.n ?? 20) || 20));
    const { rows } = await getPool().query(`
      SELECT q.id AS review_id, c.entity_kind::text AS entity_kind, s.slug AS source,
             c.raw_value #>> '{}' AS name, c.identity_key, ev.url AS evidence_url,
             ev.excerpt AS evidence_excerpt
        FROM ingest.review_queue q
        JOIN ingest.claims c ON c.id=q.claim_a_id
        JOIN ingest.sources s ON s.id=c.source_id
        LEFT JOIN LATERAL (
          SELECT e.url,e.excerpt FROM ingest.claim_evidence e
           WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1
        ) ev ON true
       WHERE q.kind='low_confidence' AND q.status='open' AND c.field='name'
         AND ($1::text IS NULL OR c.entity_kind::text=$1) AND ($2::text IS NULL OR s.slug=$2)
       ORDER BY random() LIMIT $3`, [query.kind ?? null, query.source ?? null, size]);
    return { sample: rows };
  });

  app.post("/api/decisions", async (request, reply) => {
    const body = request.body as DecisionBody;
    const choices = body ? choicesOf(body) : [];
    const ids = choices.flatMap((choice) => choice.reviewIds);
    const uniqueIds = [...new Set(ids)];
    if (!choices.length || choices.some((choice) => !choice.reviewIds.length || !VERDICTS.has(choice.verdict))
      || uniqueIds.length !== ids.length || !body.decidedBy?.trim()) {
      return reply.code(400).send({ error: "faltan revisiones, hay veredictos inválidos o una revisión aparece dos veces" });
    }
    const who = body.decidedBy.trim().slice(0, 80);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const open = await client.query<{ id: string; kind: string }>(`
        SELECT id::text,kind::text FROM ingest.review_queue
         WHERE id=ANY($1::bigint[]) AND status='open' FOR UPDATE`, [uniqueIds]);
      if (open.rowCount !== uniqueIds.length) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "alguna revisión ya no está abierta; recarga la Mesa" });
      }
      const kindById = new Map(open.rows.map((row) => [Number(row.id), row.kind]));
      if (choices.some((choice) => choice.reviewIds.some((id) => !verdictFitsReview(kindById.get(id) ?? "", choice.verdict)))) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "el veredicto no corresponde al tipo de revisión" });
      }
      // Decidir otra vez sustituye: la anterior se retira, no se acumula.
      await client.query(
        `UPDATE ingest.review_decisions SET status='withdrawn', withdrawn_at=now()
          WHERE review_id = ANY($1::bigint[]) AND decided_by=$2 AND status='active'`, [uniqueIds, who]);
      let saved = 0;
      for (const choice of choices) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ingest.review_decisions(review_id, verdict, decided_by, note, context)
           SELECT unnest($1::bigint[]), $2, $3, $4, $5::jsonb RETURNING id`,
          [choice.reviewIds, choice.verdict, who, body.note ?? null, JSON.stringify(body.context ?? {})]);
        saved += inserted.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { saved, reviewIds: uniqueIds, choices, decidedBy: who };
    } catch (error) {
      await client.query("ROLLBACK");
      log.error({ error: String(error) }, "no se pudo guardar la decisión");
      return reply.code(500).send({ error: "no se pudo guardar" });
    } finally { client.release(); }
  });

  app.post("/api/decisions/undo", async (request, reply) => {
    const body = request.body as { reviewIds?: ReviewId[]; reviewId?: ReviewId; decidedBy: string };
    const ids = body ? idsOf(body) : [];
    if (!ids.length || !body.decidedBy?.trim()) {
      return reply.code(400).send({ error: "faltan reviewIds o decidedBy" });
    }
    const result = await getPool().query(
      `UPDATE ingest.review_decisions SET status='withdrawn', withdrawn_at=now()
        WHERE review_id = ANY($1::bigint[]) AND decided_by=$2 AND status='active' RETURNING id`,
      [ids, body.decidedBy.trim().slice(0, 80)]);
    return { withdrawn: result.rowCount ?? 0 };
  });

  return app;
}

const port = Number(process.env["COTEJO_PORT"] ?? 4310);
const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  buildServer().listen({ port, host: "127.0.0.1" })
    .then(() => { log.info({ port, page: PAGE }, "mesa de cotejo escuchando"); })
    .catch((error) => { log.error({ error: String(error) }, "no arrancó"); process.exit(1); });
}
