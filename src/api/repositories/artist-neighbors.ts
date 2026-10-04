// CRV · Artistas relacionados y similares de la ficha (reglas aprobadas por
// Brian el 2026-10-04). Solo lectura sobre el core.
//
// Relacionados = vínculo comprobable entre personas o proyectos; similares =
// parecido de estilo, época o escena. Cada lista sigue un orden de reglas: un
// artista sale una sola vez, en la regla más alta que cumpla, y lo que ya es
// relacionado no se repite en similares. Dentro de una regla manda la fuerza
// del vínculo (integrantes, discos, recopilaciones… en común), luego la foto.
//
// Relacionados: R1 linaje documentado (0035) · R2 dos o más integrantes en
// común · R3 proyecto solista de un integrante · R4 un integrante en común ·
// R5 colaboración directa (acreditado como artista en un disco del otro) ·
// R6 integrante invitado en un disco del otro · R7 composición cruzada.
//
// Similares: S1 mismo estilo exacto y década · S2 mismo género principal y
// década · S3 misma recopilación y familia · S4 mismo productor y familia ·
// S5 misma escena (ciudad, familia y década) · S6 mismo género, década vecina
// · S7 mismo sello y familia · S8 mismo género, cualquier época.
//
// Las personas que aparecen en más de HUB_LIMIT artistas (músicos de sesión,
// productores muy activos) no cuentan como puente en R6, R7 ni S4: unirían
// a medio catálogo sin decir nada. «Various Artists» nunca es vecino.
import { getPool } from "../../db/client.js";
import { genreFilterSql, type PublicGenre } from "../../genres/public.js";

export type ArtistRelationType = "successor" | "ex_member_project" | "temporary_name";

/** Relación explícita vista desde la ficha: `earlier` = la otra banda es la de origen; `later` = la posterior. */
export interface ArtistRelation {
  type: ArtistRelationType;
  direction: "earlier" | "later";
  bridgeMembers: string | null;
  startYear: number | null;
  endYear: number | null;
  note: string | null;
  sources: string[];
  confidence: string;
}

/** Reglas de relacionados, en orden de prioridad. */
export const RELATED_RULES = [
  "lineage", "shared_members", "solo_project", "shared_member", "collaboration", "guest_member", "composer",
] as const;
export type RelatedRule = typeof RELATED_RULES[number];

/** Reglas de similares, en orden de prioridad. */
export const SIMILAR_RULES = [
  "same_style", "same_genre_decade", "same_compilation", "same_producer", "same_scene", "near_decade", "same_label", "same_genre",
] as const;
export type SimilarRule = typeof SIMILAR_RULES[number];

/** Quién o qué une a las dos fichas en R5–R7: la persona puente y el disco donde se ve. */
export interface RelatedBridge { person: string | null; album: string | null }

export interface RelatedArtist {
  id: number; name: string; pictureUrl: string | null; originCountry: string;
  /** La regla más alta que cumple; decide el orden. */
  rule: RelatedRule;
  sharedMembers: number; sharedMemberNames: string[];
  relations: ArtistRelation[];
  /** Evidencia de R5–R7 (hasta MAX_EVIDENCE); vacío en las reglas de integrantes y linaje. */
  bridges: RelatedBridge[];
}

export interface SimilarArtist {
  id: number; name: string; pictureUrl: string | null; originCountry: string; startYear: number | null;
  rule: SimilarRule;
  /** Recopilaciones, productores, ciudad o sellos en común (S3, S4, S5, S7); vacío en el resto. */
  evidence: string[];
}

const RELATED_LIMIT = 24;
const SIMILAR_LIMIT = 12;
const HUB_LIMIT = 15;
const MAX_EVIDENCE = 3;
const GUEST_CREDITS = ["musician", "guest"];
const COMPOSER_CREDITS = ["composer", "writer"];

/** Año de arranque: el de formación o, si falta, el de su primer disco. */
export const START_YEAR_SQL = (artist: string) =>
  `COALESCE(${artist}.formed_year, (SELECT min(al.release_year) FROM public.albums al WHERE al.artist_id = ${artist}.id))`;

/** El marcador de recopilatorio no es un artista con el que relacionarse. */
const notVariousSql = (name: string) => `lower(${name}) NOT IN ('various artists', 'varios artistas')`;

const TITULAR_ROLE = "Titular del proyecto";

interface Candidate {
  id: number; name: string; pictureUrl: string | null; originCountry: string;
  rule: RelatedRule; strength: number;
  sharedMembers?: number; sharedMemberNames?: string[];
  relations?: ArtistRelation[];
  bridges?: RelatedBridge[];
}

/**
 * Funde los candidatos de todas las reglas: cada artista queda en su regla más
 * alta, con los datos de integrantes y linaje de cualquier regla que cumpla.
 * Orden: regla, fuerza, con foto primero, nombre.
 */
export function rankRelated(candidates: Candidate[], limit = RELATED_LIMIT): RelatedArtist[] {
  const tier = (rule: RelatedRule) => RELATED_RULES.indexOf(rule);
  const byId = new Map<number, RelatedArtist & { strength: number }>();
  for (const c of candidates) {
    const current = byId.get(c.id);
    const item = current ?? {
      id: c.id, name: c.name, pictureUrl: c.pictureUrl, originCountry: c.originCountry,
      rule: c.rule, strength: c.strength, sharedMembers: 0, sharedMemberNames: [], relations: [], bridges: [],
    };
    if (current && tier(c.rule) < tier(current.rule)) {
      item.rule = c.rule;
      item.strength = c.strength;
      item.bridges = [];
    }
    if (c.sharedMembers) { item.sharedMembers = c.sharedMembers; item.sharedMemberNames = c.sharedMemberNames ?? []; }
    if (c.relations) item.relations.push(...c.relations);
    if (c.bridges && item.rule === c.rule) item.bridges = c.bridges.slice(0, MAX_EVIDENCE);
    byId.set(c.id, item);
  }
  return [...byId.values()]
    .sort((a, b) => tier(a.rule) - tier(b.rule) || b.strength - a.strength
      || Number(a.pictureUrl === null) - Number(b.pictureUrl === null) || a.name.localeCompare(b.name, "es"))
    .slice(0, limit)
    .map(({ strength: _strength, ...item }) => item);
}

export async function relatedArtists(id: number): Promise<RelatedArtist[]> {
  const pool = getPool();
  const { rows: [self] } = await pool.query<{ various: boolean }>(
    `SELECT NOT (${notVariousSql("name")}) AS various FROM public.artists WHERE id = $1`, [id]);
  if (!self || self.various) return [];

  const [explicit, members, collaborations, guests, composers] = await Promise.all([
    // R1 · las dos direcciones; una relación consigo misma (dos fichas fusionadas) no cuenta.
    pool.query<{
      other_id: string; name: string; picture_url: string | null; origin_country: string; relation_type: ArtistRelationType;
      direction: "earlier" | "later"; bridge_members: string | null; start_year: number | null; end_year: number | null;
      evidence_note: string | null; source_urls: string[]; confidence: string;
    }>(
      `SELECT o.id::text AS other_id, o.name, o.picture_url, o.origin_country, r.relation_type,
              CASE WHEN r.to_artist_id = $1 THEN 'earlier' ELSE 'later' END AS direction,
              r.bridge_members, r.start_year, r.end_year, r.evidence_note, r.source_urls, r.confidence
         FROM ingest.artist_relations r
         JOIN public.artists o ON o.id = CASE WHEN r.to_artist_id = $1 THEN r.from_artist_id ELSE r.to_artist_id END
        WHERE (r.from_artist_id = $1 OR r.to_artist_id = $1) AND r.from_artist_id <> r.to_artist_id
        ORDER BY r.start_year NULLS LAST, o.name`,
      [id],
    ),
    // R2–R4 · integrantes en común (membresías de cualquier época). `solo`: el
    // puente es titular de uno de los dos proyectos o su único integrante.
    pool.query<{ id: string; name: string; picture_url: string | null; origin_country: string; shared: number; shared_names: string[]; solo: boolean }>(
      `SELECT o.id::text AS id, o.name, o.picture_url, o.origin_country,
              count(DISTINCT am.person_id)::int AS shared,
              array_agg(DISTINCT p.name ORDER BY p.name) AS shared_names,
              bool_or(am.role = $2 OR om.role = $2 OR s.artist_type = 'solo_artist' OR o.artist_type = 'solo_artist') AS solo
         FROM public.artist_members am
         JOIN public.artists s ON s.id = am.artist_id
         JOIN public.artist_members om ON om.person_id = am.person_id AND om.artist_id <> am.artist_id
         JOIN public.artists o ON o.id = om.artist_id
         JOIN public.persons p ON p.id = am.person_id
        WHERE am.artist_id = $1 AND ${notVariousSql("o.name")}
        GROUP BY o.id, o.name, o.picture_url, o.origin_country`,
      [id, TITULAR_ROLE],
    ),
    // R5 · el otro acreditado como artista en un disco o pista mía, o yo en uno suyo.
    pool.query<{ id: string; name: string; picture_url: string | null; origin_country: string; albums: number; titles: string[] }>(
      `WITH mine AS (SELECT id, title FROM public.albums WHERE artist_id = $1),
            links AS (
              SELECT ac.artist_id AS other_id, m.id AS album_id, m.title
                FROM mine m JOIN public.album_credits ac ON ac.album_id = m.id WHERE ac.artist_id IS NOT NULL
              UNION
              SELECT tc.artist_id, m.id, m.title
                FROM mine m JOIN public.tracks t ON t.album_id = m.id JOIN public.track_credits tc ON tc.track_id = t.id
               WHERE tc.artist_id IS NOT NULL
              UNION
              SELECT al.artist_id, al.id, al.title
                FROM public.album_credits ac JOIN public.albums al ON al.id = ac.album_id WHERE ac.artist_id = $1
              UNION
              SELECT al.artist_id, al.id, al.title
                FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id JOIN public.albums al ON al.id = t.album_id
               WHERE tc.artist_id = $1)
       SELECT o.id::text AS id, o.name, o.picture_url, o.origin_country,
              count(DISTINCT l.album_id)::int AS albums, array_agg(DISTINCT l.title) AS titles
         FROM links l JOIN public.artists o ON o.id = l.other_id
        WHERE l.other_id <> $1 AND ${notVariousSql("o.name")}
        GROUP BY o.id, o.name, o.picture_url, o.origin_country`,
      [id],
    ),
    bridgeQuery(id, GUEST_CREDITS),
    bridgeQuery(id, COMPOSER_CREDITS),
  ]);

  const candidates: Candidate[] = [];
  for (const [index, row] of explicit.rows.entries()) {
    candidates.push({
      id: Number(row.other_id), name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country,
      // La fuerza conserva el orden cronológico de la consulta.
      rule: "lineage", strength: explicit.rows.length - index,
      relations: [{
        type: row.relation_type, direction: row.direction, bridgeMembers: row.bridge_members,
        startYear: row.start_year, endYear: row.end_year, note: row.evidence_note, sources: row.source_urls, confidence: row.confidence,
      }],
    });
  }
  for (const row of members.rows) {
    candidates.push({
      id: Number(row.id), name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country,
      rule: row.shared >= 2 ? "shared_members" : row.solo ? "solo_project" : "shared_member",
      strength: row.shared, sharedMembers: row.shared, sharedMemberNames: row.shared_names,
    });
  }
  for (const row of collaborations.rows) {
    candidates.push({
      id: Number(row.id), name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country,
      rule: "collaboration", strength: row.albums,
      bridges: [...row.titles].sort((a, b) => a.localeCompare(b, "es")).map((album) => ({ person: null, album })),
    });
  }
  for (const [rule, result] of [["guest_member", guests], ["composer", composers]] as const) {
    for (const row of result.rows) {
      candidates.push({
        id: Number(row.id), name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country,
        rule, strength: row.albums, bridges: row.bridges,
      });
    }
  }
  return rankRelated(candidates);
}

/**
 * R6/R7 · integrantes de otra banda acreditados (con los tipos dados) en un
 * disco o pista mía, y mis integrantes en los de otra. El puente no puede ser
 * integrante de las dos (eso ya es R2–R4) ni aparecer en más de HUB_LIMIT artistas.
 */
function bridgeQuery(id: number, creditTypes: string[]) {
  return getPool().query<{ id: string; name: string; picture_url: string | null; origin_country: string; albums: number; bridges: RelatedBridge[] }>(
    `WITH mine AS (SELECT id, title FROM public.albums WHERE artist_id = $1),
          my_members AS (SELECT person_id FROM public.artist_members WHERE artist_id = $1),
          credited AS (
            -- personas acreditadas en mis discos
            SELECT ac.person_id, m.id AS album_id, m.title
              FROM mine m JOIN public.album_credits ac ON ac.album_id = m.id
             WHERE ac.person_id IS NOT NULL AND ac.credit_type::text = ANY($2::text[])
            UNION
            SELECT tc.person_id, m.id, m.title
              FROM mine m JOIN public.tracks t ON t.album_id = m.id JOIN public.track_credits tc ON tc.track_id = t.id
             WHERE tc.person_id IS NOT NULL AND tc.credit_type::text = ANY($2::text[])),
          bridges AS (
            SELECT om.artist_id AS other_id, c.person_id, c.album_id, c.title
              FROM credited c JOIN public.artist_members om ON om.person_id = c.person_id AND om.artist_id <> $1
             WHERE c.person_id NOT IN (SELECT person_id FROM my_members)
            UNION
            -- mis integrantes acreditados en discos de otros
            SELECT al.artist_id, ac.person_id, al.id, al.title
              FROM my_members mm JOIN public.album_credits ac ON ac.person_id = mm.person_id AND ac.credit_type::text = ANY($2::text[])
              JOIN public.albums al ON al.id = ac.album_id AND al.artist_id <> $1
             WHERE NOT EXISTS (SELECT 1 FROM public.artist_members x WHERE x.artist_id = al.artist_id AND x.person_id = mm.person_id)
            UNION
            SELECT al.artist_id, tc.person_id, al.id, al.title
              FROM my_members mm JOIN public.track_credits tc ON tc.person_id = mm.person_id AND tc.credit_type::text = ANY($2::text[])
              JOIN public.tracks t ON t.id = tc.track_id
              JOIN public.albums al ON al.id = t.album_id AND al.artist_id <> $1
             WHERE NOT EXISTS (SELECT 1 FROM public.artist_members x WHERE x.artist_id = al.artist_id AND x.person_id = mm.person_id)),
          reach AS (
            SELECT b.person_id, (
              SELECT count(DISTINCT r.artist_id) FROM (
                SELECT artist_id FROM public.artist_members WHERE person_id = b.person_id
                UNION SELECT al.artist_id FROM public.album_credits ac JOIN public.albums al ON al.id = ac.album_id WHERE ac.person_id = b.person_id
                UNION SELECT al.artist_id FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id
                        JOIN public.albums al ON al.id = t.album_id WHERE tc.person_id = b.person_id) r) AS artists
              FROM (SELECT DISTINCT person_id FROM bridges) b)
     SELECT o.id::text AS id, o.name, o.picture_url, o.origin_country,
            count(DISTINCT b.album_id)::int AS albums,
            (array_agg(jsonb_build_object('person', p.name, 'album', b.title) ORDER BY b.title, p.name))[1:${MAX_EVIDENCE}] AS bridges
       FROM bridges b
       JOIN reach r ON r.person_id = b.person_id AND r.artists <= $3
       JOIN public.persons p ON p.id = b.person_id
       JOIN public.artists o ON o.id = b.other_id
      WHERE ${notVariousSql("o.name")}
      GROUP BY o.id, o.name, o.picture_url, o.origin_country`,
    [id, creditTypes, HUB_LIMIT],
  );
}

interface SimilarSelf {
  id: number; decade: number | null; city: string | null;
  primary: PublicGenre;
  /** La familia del género principal (para S3, S4, S5, S7). */
  family: string;
  /** El principal es un género o subgénero, no una familia entera (S1). */
  specific: boolean;
}

/**
 * Una regla de similares: `where` filtra los candidatos `c` (con `c.start_year`),
 * `strength` y `evidence` son expresiones SQL sobre `c`. Comparten parámetros:
 * $1 artista · $2 excluidos · $3 límite · $4 principal · $5 familia · $6 década · $7 ciudad.
 */
interface SimilarTier { rule: SimilarRule; applies: (self: SimilarSelf) => boolean; with?: string; where: string; strength?: string; evidence?: string }

const sharedGenresSql = `(SELECT count(*) FROM ingest.artist_genres x JOIN ingest.artist_genres y ON y.genre_id = x.genre_id
   WHERE x.artist_id = c.id AND y.artist_id = $1 AND x.status = 'confirmed' AND y.status = 'confirmed')`;
const sameDecadeSql = "c.start_year >= $6::int AND c.start_year < $6::int + 10";

const SIMILAR_TIERS: SimilarTier[] = [
  {
    // S1 · el mismo nodo exacto como principal (no basta con un descendiente).
    rule: "same_style", applies: (s) => s.specific && s.decade !== null,
    where: `${sameDecadeSql} AND EXISTS (SELECT 1 FROM ingest.artist_genres g JOIN ingest.genres n ON n.id = g.genre_id
              WHERE g.artist_id = c.id AND g.status = 'confirmed' AND g.role = 'primary' AND n.slug = $4)`,
    strength: sharedGenresSql,
  },
  {
    // S2 · la regla de siempre: el género principal (o un descendiente) y la década.
    rule: "same_genre_decade", applies: (s) => s.decade !== null,
    where: `${sameDecadeSql} AND ${genreFilterSql("artist", "c.id", "$4")}`, strength: sharedGenresSql,
  },
  {
    // S3 · participan en una misma recopilación (tipo compilation o de Various Artists).
    rule: "same_compilation", applies: () => true,
    with: `comps AS (
             SELECT al.id, al.title FROM public.albums al JOIN public.artists aa ON aa.id = al.artist_id
              WHERE al.album_type::text = 'compilation' OR NOT (${notVariousSql("aa.name")})),
           participants AS (
             SELECT cp.id AS album_id, cp.title, al.artist_id FROM comps cp JOIN public.albums al ON al.id = cp.id
             UNION SELECT cp.id, cp.title, ac.artist_id FROM comps cp JOIN public.album_credits ac ON ac.album_id = cp.id WHERE ac.artist_id IS NOT NULL
             UNION SELECT cp.id, cp.title, tc.artist_id FROM comps cp JOIN public.tracks t ON t.album_id = cp.id
                     JOIN public.track_credits tc ON tc.track_id = t.id WHERE tc.artist_id IS NOT NULL),
           hits AS (
             SELECT o.artist_id, o.album_id, o.title FROM participants me JOIN participants o ON o.album_id = me.album_id
              WHERE me.artist_id = $1 AND o.artist_id <> $1)`,
    where: `c.id IN (SELECT artist_id FROM hits) AND ${genreFilterSql("artist", "c.id", "$5")}`,
    strength: "(SELECT count(DISTINCT h.album_id) FROM hits h WHERE h.artist_id = c.id)",
    evidence: "(SELECT array_agg(DISTINCT h.title) FROM hits h WHERE h.artist_id = c.id)",
  },
  {
    // S4 · el mismo productor (persona) en discos de los dos, salvo los que producen a medio catálogo.
    rule: "same_producer", applies: () => true,
    with: `produced AS (
             SELECT ac.person_id, al.artist_id FROM public.album_credits ac JOIN public.albums al ON al.id = ac.album_id
              WHERE ac.person_id IS NOT NULL AND ac.credit_type::text = 'producer'
             UNION SELECT tc.person_id, al.artist_id FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id
                     JOIN public.albums al ON al.id = t.album_id WHERE tc.person_id IS NOT NULL AND tc.credit_type::text = 'producer'),
           my_producers AS (
             SELECT pr.person_id FROM produced pr WHERE pr.artist_id = $1
                AND (SELECT count(DISTINCT x.artist_id) FROM produced x WHERE x.person_id = pr.person_id) <= ${HUB_LIMIT}),
           hits AS (
             SELECT DISTINCT pr.artist_id, p.name FROM produced pr JOIN my_producers mp ON mp.person_id = pr.person_id
               JOIN public.persons p ON p.id = pr.person_id WHERE pr.artist_id <> $1)`,
    where: `c.id IN (SELECT artist_id FROM hits) AND ${genreFilterSql("artist", "c.id", "$5")}`,
    strength: "(SELECT count(*) FROM hits h WHERE h.artist_id = c.id)",
    evidence: "(SELECT array_agg(DISTINCT h.name) FROM hits h WHERE h.artist_id = c.id)",
  },
  {
    // S5 · misma escena: ciudad de origen, familia y década.
    rule: "same_scene", applies: (s) => s.city !== null && s.decade !== null,
    where: `lower(btrim(c.origin_city)) = $7 AND ${sameDecadeSql} AND ${genreFilterSql("artist", "c.id", "$5")}`,
    strength: sharedGenresSql, evidence: "ARRAY[btrim(c.origin_city)]",
  },
  {
    // S6 · el género principal en la década anterior o la siguiente.
    rule: "near_decade", applies: (s) => s.decade !== null,
    where: `c.start_year >= $6::int - 10 AND c.start_year < $6::int + 20 AND NOT (${sameDecadeSql})
            AND ${genreFilterSql("artist", "c.id", "$4")}`,
    strength: sharedGenresSql,
  },
  {
    // S7 · discos en un mismo sello y la misma familia.
    rule: "same_label", applies: () => true,
    with: `hits AS (
             SELECT DISTINCT o.artist_id, l.name FROM public.albums me
               JOIN public.albums o ON o.label_id = me.label_id AND o.artist_id <> $1
               JOIN public.organizations l ON l.id = me.label_id
              WHERE me.artist_id = $1)`,
    where: `c.id IN (SELECT artist_id FROM hits) AND ${genreFilterSql("artist", "c.id", "$5")}`,
    strength: "(SELECT count(*) FROM hits h WHERE h.artist_id = c.id)",
    evidence: "(SELECT array_agg(DISTINCT h.name) FROM hits h WHERE h.artist_id = c.id)",
  },
  {
    // S8 · último recurso: el género principal, cualquier época (o sin año).
    rule: "same_genre", applies: () => true,
    where: genreFilterSql("artist", "c.id", "$4"), strength: sharedGenresSql,
  },
];

/**
 * Similares por reglas: se recorren en orden y se para al llenar SIMILAR_LIMIT.
 * Sin género principal no hay similares (todas las reglas lo usan).
 */
export async function similarArtists(
  id: number, primaryGenre: PublicGenre | null, exclude: number[] = [],
): Promise<{ similar: SimilarArtist[]; similarDecade: number | null }> {
  const pool = getPool();
  const { rows: [row] } = await pool.query<{ start_year: number | null; city: string | null; various: boolean }>(
    `SELECT ${START_YEAR_SQL("a")} AS start_year, NULLIF(lower(btrim(a.origin_city)), '') AS city,
            NOT (${notVariousSql("a.name")}) AS various
       FROM public.artists a WHERE a.id = $1`, [id]);
  const similarDecade = row?.start_year == null ? null : Math.floor(row.start_year / 10) * 10;
  if (!row || row.various || !primaryGenre) return { similar: [], similarDecade };
  const self: SimilarSelf = {
    id, decade: similarDecade, city: row.city, primary: primaryGenre, family: primaryGenre.family,
    specific: primaryGenre.slug !== primaryGenre.family,
  };

  const similar: SimilarArtist[] = [];
  const taken = new Set<number>([id, ...exclude]);
  for (const tier of SIMILAR_TIERS) {
    if (similar.length >= SIMILAR_LIMIT) break;
    if (!tier.applies(self)) continue;
    const { rows } = await pool.query<{
      id: string; name: string; picture_url: string | null; origin_country: string; start_year: number | null; evidence: string[] | null;
    }>(
      `WITH ${tier.with ? `${tier.with},` : ""}
            -- Los parámetros van tipados aquí: no todas las reglas usan todos.
            cand AS (SELECT a.id, a.name, a.picture_url, a.origin_country, a.origin_city, ${START_YEAR_SQL("a")} AS start_year,
                            $4::text AS p_primary, $5::text AS p_family, $6::int AS p_decade, $7::text AS p_city
                       FROM public.artists a WHERE NOT (a.id = ANY($2::bigint[])) AND ${notVariousSql("a.name")})
       SELECT c.id::text AS id, c.name, c.picture_url, c.origin_country, c.start_year,
              ${tier.evidence ?? "NULL::text[]"} AS evidence
         FROM cand c
        WHERE ${tier.where}
        ORDER BY ${tier.strength ?? "0"} DESC, (c.picture_url IS NULL), md5(c.id::text || $1::text)
        LIMIT $3`,
      [id, [...taken], SIMILAR_LIMIT - similar.length, self.primary.slug, self.family, self.decade, self.city],
    );
    for (const r of rows) {
      taken.add(Number(r.id));
      similar.push({
        id: Number(r.id), name: r.name, pictureUrl: r.picture_url, originCountry: r.origin_country, startYear: r.start_year,
        rule: tier.rule, evidence: (r.evidence ?? []).filter(Boolean).sort((a, b) => a.localeCompare(b, "es")).slice(0, MAX_EVIDENCE),
      });
    }
  }
  return { similar, similarDecade };
}
