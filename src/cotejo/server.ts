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
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("cotejo");
const PAGE = path.resolve(process.cwd(), "public/cotejo.html");

// Una misma pregunta llega repetida en varias filas de la cola (cuatro fichas
// distintas para el mismo "Melissa"). La página agrupa por lo que se decide,
// así que el cuerpo acepta la lista entera y las resuelve en una transacción.
// Los id de la cola son bigint, y node-postgres los entrega como cadena para no
// perder precisión: el JSON que la página lleva incrustado los conserva así.
// Filtrar por Number.isInteger descartaba "3331" entero y dejaba la lista vacía,
// con lo que cada clic acababa en un 400 y nada se guardaba. Se aceptan las dos
// formas y se normalizan aquí, que es el borde por donde entra el dato.
type ReviewId = number | string;
interface DecisionBody { reviewIds?: ReviewId[]; reviewId?: ReviewId; verdict: string; decidedBy: string; note?: string; context?: unknown; }
function idsOf(body: { reviewIds?: ReviewId[]; reviewId?: ReviewId }): number[] {
  const list = body.reviewIds ?? (body.reviewId === undefined ? [] : [body.reviewId]);
  const ids = list.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

const VERDICTS = new Set(["same", "different", "unsure", "canonical", "proposed", "approve", "reject"]);

/** Clasificación por forma del nombre: es donde asoman los defectos. */
const GROUP_SQL = `
  WITH cand AS (
    SELECT c.entity_kind::text AS entity_kind, s.slug AS source, c.raw_value #>> '{}' AS name, q.id AS review_id
      FROM ingest.review_queue q
      JOIN ingest.claims c ON c.id = q.claim_a_id
      JOIN ingest.sources s ON s.id = c.source_id
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
         (array_agg(name ORDER BY random()))[1:8] AS samples,
         (array_agg(review_id ORDER BY random()))[1:8] AS review_ids
    FROM shaped GROUP BY shape, entity_kind ORDER BY n DESC`;

export function buildServer() {
  const app = Fastify({ logger: false });

  // Si la mesa sale por Funnel, sale a internet abierto y aquí hay nombres de
  // personas sin revisar. Que se pueda abrir el enlace es una cosa; que Google
  // archive esos nombres y los siga mostrando después de corregirlos es otra.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  });

  app.get("/", async (_request, reply) => {
    const html = await readFile(PAGE, "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get("/health", async () => ({ ok: true }));

  app.get("/api/state", async () => {
    const pool = getPool();
    const [core, queues, candidates, decisions] = await Promise.all([
      pool.query(`SELECT (SELECT count(*) FROM artists) artists,(SELECT count(*) FROM albums) albums,
                         (SELECT count(*) FROM tracks) tracks,(SELECT count(*) FROM persons) persons,
                         (SELECT count(*) FROM organizations) organizations,(SELECT count(*) FROM album_credits) album_credits`),
      pool.query(`SELECT kind::text AS kind, count(*)::int AS open FROM ingest.review_queue WHERE status='open' GROUP BY 1 ORDER BY 2 DESC`),
      pool.query(`SELECT s.slug AS source, c.entity_kind, count(*)::int AS claims, count(DISTINCT c.identity_key)::int AS entities
                    FROM ingest.review_queue q JOIN ingest.claims c ON c.id=q.claim_a_id JOIN ingest.sources s ON s.id=c.source_id
                   WHERE q.kind='low_confidence' AND q.status='open' GROUP BY 1,2 ORDER BY 1,3 DESC`),
      pool.query(`SELECT review_id, verdict, decided_by, note, decided_at FROM ingest.review_decisions
                   WHERE status='active' ORDER BY decided_at DESC`),
    ]);
    return {
      snapshot: new Date().toISOString(),
      core: core.rows[0], queues: queues.rows, candidates: candidates.rows,
      decisions: decisions.rows.map((row) => ({
        reviewId: Number(row.review_id), verdict: row.verdict, decidedBy: row.decided_by,
        note: row.note, decidedAt: row.decided_at,
      })),
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
      SELECT q.id AS review_id, c.entity_kind::text AS entity_kind, s.slug AS source, c.raw_value #>> '{}' AS name, c.identity_key
        FROM ingest.review_queue q
        JOIN ingest.claims c ON c.id=q.claim_a_id
        JOIN ingest.sources s ON s.id=c.source_id
       WHERE q.kind='low_confidence' AND q.status='open' AND c.field='name'
         AND ($1::text IS NULL OR c.entity_kind::text=$1) AND ($2::text IS NULL OR s.slug=$2)
       ORDER BY random() LIMIT $3`, [query.kind ?? null, query.source ?? null, size]);
    return { sample: rows };
  });

  app.post("/api/decisions", async (request, reply) => {
    const body = request.body as DecisionBody;
    const ids = body ? idsOf(body) : [];
    if (!ids.length || !VERDICTS.has(body.verdict) || !body.decidedBy?.trim()) {
      return reply.code(400).send({ error: "faltan reviewIds, un verdict válido o decidedBy" });
    }
    const who = body.decidedBy.trim().slice(0, 80);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // Decidir otra vez sustituye: la anterior se retira, no se acumula.
      await client.query(
        `UPDATE ingest.review_decisions SET status='withdrawn', withdrawn_at=now()
          WHERE review_id = ANY($1::bigint[]) AND decided_by=$2 AND status='active'`, [ids, who]);
      const saved = await client.query<{ id: string }>(
        `INSERT INTO ingest.review_decisions(review_id, verdict, decided_by, note, context)
         SELECT unnest($1::bigint[]), $2, $3, $4, $5::jsonb RETURNING id`,
        [ids, body.verdict, who, body.note ?? null, JSON.stringify(body.context ?? {})]);
      await client.query("COMMIT");
      return { saved: saved.rowCount ?? 0, reviewIds: ids, verdict: body.verdict, decidedBy: who };
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
buildServer().listen({ port, host: "127.0.0.1" })
  .then(() => { log.info({ port, page: PAGE }, "mesa de cotejo escuchando"); })
  .catch((error) => { log.error({ error: String(error) }, "no arrancó"); process.exit(1); });
