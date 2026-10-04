// CRV · Curaduría: elegir portada o foto de artista a ojo (Brian, 2026-10-04).
//
// `ingest.image_candidates` (0038) guarda, por ficha, imágenes candidatas que
// nadie aplicó solo: portadas dudosas de la mejora de portadas y fotos de
// artista alternativas. Aquí se listan agrupadas por ficha y se decide:
// usar una candidata (escribe cover_url/picture_url por el motor, con
// auditoría) o dejar la actual (solo cierra las candidatas). Cada decisión es
// un run de operador que `POST /changes/:run/undo` deshace entero.
//
// Lecturas solo admin (ADMIN_READS cubre `/curation`); escrituras con la
// guarda de sesión admin + CSRF o el token de operador.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPool } from "../../db/client.js";
import { OperatorError, updateEntity, withOperatorRun } from "../../merge/operator.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { paginationQuerySchema } from "../pagination.js";
import { writeErrorResponses } from "../schemas.js";
import { noteSchema } from "./catalog-writes.js";

const KINDS = ["album", "artist"] as const;
type ImageKind = (typeof KINDS)[number];
const FIELD: Record<ImageKind, "cover_url" | "picture_url"> = { album: "cover_url", artist: "picture_url" };
const ID_COLUMN: Record<ImageKind, "album_id" | "artist_id"> = { album: "album_id", artist: "artist_id" };

const candidateSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  source: z.string(),
  pageUrl: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  score: z.number().nullable(),
});

const groupSchema = z.object({
  kind: z.enum(KINDS),
  entityId: z.number().int(),
  name: z.string(),
  subtitle: z.string().nullable(),
  /** La imagen que la ficha muestra hoy. */
  currentUrl: z.string().nullable(),
  /** La ficha cambió de imagen desde que se propusieron las candidatas. */
  stale: z.boolean(),
  candidates: z.array(candidateSchema),
});

const listQuerySchema = paginationQuerySchema.extend({ kind: z.enum(KINDS).default("album") });
const decideParamsSchema = z.object({ kind: z.enum(KINDS), id: z.coerce.number().int().positive() });
const decideBodySchema = z.object({
  candidateId: z.number().int().positive().nullable()
    .describe("Candidata elegida; null = dejar la imagen actual y descartar todas."),
  note: noteSchema.optional(),
}).strict();

interface GroupRow {
  entity_id: string; name: string; subtitle: string | null; current_url: string | null; proposed_url: string | null;
  candidates: Array<{ id: number; url: string; source: string; pageUrl: string | null; width: number | null; height: number | null; score: string | number | null }>;
}

const ENTITY_SQL: Record<ImageKind, { join: string; name: string; subtitle: string; current: string }> = {
  album: {
    join: "JOIN public.albums e ON e.id = c.album_id JOIN public.artists ar ON ar.id = e.artist_id",
    name: "e.title",
    subtitle: "ar.name || COALESCE(' · ' || e.release_year::text, '')",
    current: "e.cover_url",
  },
  artist: { join: "JOIN public.artists e ON e.id = c.artist_id", name: "e.name", subtitle: "NULL::text", current: "e.picture_url" },
};

export async function registerImageCandidateRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/curation/images/summary", {
    schema: {
      tags: ["curation"],
      summary: "Fichas con imágenes candidatas pendientes de elegir, por tipo",
      response: { 200: z.object({ album: z.number().int(), artist: z.number().int() }) },
    },
  }, async () => {
    const { rows } = await getPool().query<{ album: string; artist: string }>(`
      SELECT count(DISTINCT album_id) FILTER (WHERE status = 'open')::text AS album,
             count(DISTINCT artist_id) FILTER (WHERE status = 'open')::text AS artist
        FROM ingest.image_candidates`);
    return { album: Number(rows[0]?.album ?? 0), artist: Number(rows[0]?.artist ?? 0) };
  });

  server.get("/curation/images", {
    schema: {
      tags: ["curation"],
      summary: "Imágenes candidatas pendientes agrupadas por ficha (mejor parecido primero)",
      querystring: listQuerySchema,
      response: {
        200: z.object({
          data: z.array(groupSchema),
          pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
        }),
      },
    },
  }, async (request) => {
    const { kind, limit, offset } = request.query;
    const sql = ENTITY_SQL[kind];
    const column = ID_COLUMN[kind];
    const { rows } = await getPool().query<GroupRow & { total: string }>(`
      SELECT c.${column}::text AS entity_id, ${sql.name} AS name, ${sql.subtitle} AS subtitle,
             ${sql.current} AS current_url, min(c.current_url) AS proposed_url,
             jsonb_agg(jsonb_build_object('id', c.id, 'url', c.candidate_url, 'source', c.source, 'pageUrl', c.page_url,
                                          'width', c.width, 'height', c.height, 'score', c.score)
                       ORDER BY c.score DESC NULLS LAST, c.id) AS candidates,
             count(*) OVER ()::text AS total
        FROM ingest.image_candidates c
        ${sql.join}
       WHERE c.entity_kind = $1 AND c.status = 'open'
       GROUP BY c.${column}, ${sql.name}, ${sql.subtitle}, ${sql.current}
       ORDER BY max(c.score) DESC NULLS LAST, ${sql.name}
       LIMIT $2 OFFSET $3`, [kind, limit, offset]);
    return {
      data: rows.map((row) => ({
        kind,
        entityId: Number(row.entity_id),
        name: row.name,
        subtitle: row.subtitle,
        currentUrl: row.current_url,
        stale: row.proposed_url !== row.current_url,
        candidates: row.candidates.map((candidate) => ({
          ...candidate, score: candidate.score === null ? null : Number(candidate.score),
        })),
      })),
      pagination: { limit, offset, total: Number(rows[0]?.total ?? 0) },
    };
  });

  server.post("/curation/images/:kind/:id/decide", {
    schema: {
      tags: ["curation"],
      summary: "Usa una imagen candidata (o deja la actual) y cierra las candidatas de la ficha; un run que se puede deshacer",
      security: OPERATOR_SECURITY,
      params: decideParamsSchema,
      body: decideBodySchema,
      response: {
        200: z.object({ runId: z.number().int(), kind: z.enum(KINDS), entityId: z.number().int(), chosenUrl: z.string().nullable() }),
        ...writeErrorResponses,
      },
    },
  }, async (request) => {
    const { kind, id } = request.params;
    const { candidateId } = request.body;
    const label = kind === "album" ? "portada" : "foto de artista";
    const note = request.body.note ?? (candidateId === null
      ? `Curaduría: se deja la ${label} actual y se descartan las candidatas`
      : `Curaduría: ${label} elegida a ojo entre las candidatas`);
    const { runId, result } = await withOperatorRun({
      name: "image_choice", operator: request.operator, note, params: { kind, id, candidateId },
    }, async (context) => {
      const column = ID_COLUMN[kind];
      const open = await context.client.query<{ id: string; candidate_url: string; current_url: string | null }>(`
        SELECT id::text, candidate_url, current_url FROM ingest.image_candidates
         WHERE entity_kind = $1 AND ${column} = $2 AND status = 'open' FOR UPDATE`, [kind, id]);
      if (open.rows.length === 0) throw new OperatorError("not_open", "Esta ficha ya no tiene imágenes candidatas pendientes.", { kind, id });
      let chosenUrl: string | null = null;
      if (candidateId !== null) {
        const chosen = open.rows.find((row) => Number(row.id) === candidateId);
        if (!chosen) throw new OperatorError("not_found", "La imagen elegida no es una candidata pendiente de esta ficha.", { kind, id, candidateId });
        const table = kind === "album" ? "public.albums" : "public.artists";
        const live = await context.client.query<{ url: string | null }>(`SELECT ${FIELD[kind]} AS url FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!live.rows[0]) throw new OperatorError("not_found", "La ficha ya no existe.", { kind, id });
        if (live.rows[0].url !== chosen.current_url) {
          throw new OperatorError("stale_preview", `La ${label} de esta ficha cambió desde que se propusieron las candidatas; revísala en su ficha.`, { kind, id });
        }
        await updateEntity(context, kind, id, { [FIELD[kind]]: chosen.candidate_url });
        chosenUrl = chosen.candidate_url;
      }
      await context.client.query(`
        UPDATE ingest.image_candidates
           SET status = CASE WHEN id = $3 THEN 'chosen' ELSE 'rejected' END,
               decided_by = $4, decided_at = now(), decision_run_id = $5
         WHERE entity_kind = $1 AND ${column} = $2 AND status = 'open'`,
      [kind, id, candidateId ?? 0, context.operator, context.runId]);
      return { chosenUrl };
    });
    return { runId, kind, entityId: id, chosenUrl: result.chosenUrl };
  });
}
