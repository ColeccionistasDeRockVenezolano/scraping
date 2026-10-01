// CRV · Consultas de lectura para artistas (PHASES §E7A). SQL parametrizado
// directo (mismo estilo que src/er/repository.ts): agregaciones jsonb para
// devolver la ficha completa en una sola consulta.
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";
import { genreFilterSql, publicGenresFor, type PublicGenre } from "../../genres/public.js";
import type { GenreStatus } from "../../merge/genre-projection.js";
import { artistDeceasedSql, personDeceasedSql } from "./deceased.js";

export interface ArtistListRow {
  id: number;
  name: string;
  artistType: string;
  originCity: string | null;
  originCountry: string;
  formedYear: number | null;
  disbandedYear: number | null;
  pictureUrl: string | null;
  /** Su proyecto es de una persona fallecida (titular o único integrante). */
  isDeceased: boolean;
  /** Género propio del artista (su trayectoria): no se hereda a discos ni pistas. */
  primaryGenre: PublicGenre | null;
  genreStatus: GenreStatus;
}

export async function listArtists(
  query: PaginationQuery & { q?: string | undefined; genre?: string | undefined },
): Promise<{ rows: ArtistListRow[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const genre = query.genre ?? null;
  const [rows, count] = await Promise.all([
    getPool().query<{
      id: string; name: string; artist_type: string; origin_city: string | null;
      origin_country: string; formed_year: number | null; disbanded_year: number | null;
      picture_url: string | null; is_deceased: boolean;
    }>(
      `SELECT id, name, artist_type, origin_city, origin_country, formed_year, disbanded_year, picture_url,
              ${artistDeceasedSql("public.artists.id")} AS is_deceased
         FROM public.artists
        WHERE ($1::text IS NULL OR name ILIKE $1)
          AND ($4::text IS NULL OR ${genreFilterSql("artist", "public.artists.id", "$4")})
        ORDER BY name
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset, genre],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.artists
        WHERE ($1::text IS NULL OR name ILIKE $1)
          AND ($2::text IS NULL OR ${genreFilterSql("artist", "public.artists.id", "$2")})`,
      [pattern, genre],
    ),
  ]);
  const genres = await publicGenresFor("artist", rows.rows.map((row) => Number(row.id)));
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      artistType: row.artist_type,
      originCity: row.origin_city,
      originCountry: row.origin_country,
      formedYear: row.formed_year,
      disbandedYear: row.disbanded_year,
      pictureUrl: row.picture_url,
      isDeceased: row.is_deceased,
      primaryGenre: genres.get(Number(row.id))?.primaryGenre ?? null,
      genreStatus: genres.get(Number(row.id))?.genreStatus ?? "unclassified",
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface ArtistDetail {
  id: number;
  name: string;
  artistType: string;
  biography: string | null;
  pictureUrl: string | null;
  /** Logo de la banda (Metal Archives); null si no hay. */
  logoUrl: string | null;
  originCity: string | null;
  originCountry: string;
  formedYear: number | null;
  disbandedYear: number | null;
  notes: string | null;
  /** Su proyecto es de una persona fallecida (titular o único integrante). */
  isDeceased: boolean;
  members: Array<{ id: number; personId: number; personName: string; personIsDeceased: boolean; role: string; personBirthDate: string | null; personDeathDate: string | null; fromYear: number | null; toYear: number | null; isCurrent: boolean }>;
  discography: Array<{ albumId: number; title: string; releaseYear: number | null; albumType: string; coverUrl: string | null }>;
  aliases: Array<{ id: number; alias: string; aliasType: string; isPrimary: boolean }>;
  /** Géneros confirmados del ARTISTA; los discos tienen los suyos. */
  primaryGenre: PublicGenre | null;
  genres: PublicGenre[];
  genreStatus: GenreStatus;
  /** Sello del disco más reciente que lo declara (derivado; no es un campo propio del artista). */
  lastLabel: { id: number; name: string } | null;
  /** Enlaces públicos de sus discos (YouTube, Instagram, WordPress), uno por disco y plataforma. */
  links: Array<{ platform: "youtube" | "instagram" | "wordpress"; url: string; albumId: number; albumTitle: string }>;
  /**
   * Bandas relacionadas: las de un linaje documentado (`ingest.artist_relations`:
   * sucesor, proyecto de exintegrantes, nombre temporal), primero, y las que
   * comparten dos o más integrantes (membresías de cualquier época).
   */
  related: RelatedArtist[];
  /** Década en que arrancó (formación o, si falta, su primer disco); null si no hay año. */
  similarDecade: number | null;
  /** Mismo género principal y misma década de arranque; sin año, solo el género. */
  similar: Array<{ id: number; name: string; pictureUrl: string | null; originCountry: string; startYear: number | null }>;
}

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

export interface RelatedArtist {
  id: number; name: string; pictureUrl: string | null; originCountry: string;
  sharedMembers: number; sharedMemberNames: string[];
  relations: ArtistRelation[];
}

const RELATED_MIN_SHARED = 2;
const RELATED_LIMIT = 24;
const SIMILAR_LIMIT = 12;

/** Año de arranque: el de formación o, si falta, el de su primer disco. */
const START_YEAR_SQL = (artist: string) =>
  `COALESCE(${artist}.formed_year, (SELECT min(al.release_year) FROM public.albums al WHERE al.artist_id = ${artist}.id))`;

async function relatedArtists(id: number): Promise<RelatedArtist[]> {
  const [shared, explicit] = await Promise.all([
    getPool().query<{ id: string; name: string; picture_url: string | null; origin_country: string; shared: number; shared_names: string[] }>(
      `SELECT o.id::text AS id, o.name, o.picture_url, o.origin_country,
              count(DISTINCT am.person_id)::int AS shared,
              array_agg(DISTINCT p.name ORDER BY p.name) AS shared_names
         FROM public.artist_members am
         JOIN public.artist_members om ON om.person_id = am.person_id AND om.artist_id <> am.artist_id
         JOIN public.artists o ON o.id = om.artist_id
         JOIN public.persons p ON p.id = am.person_id
        WHERE am.artist_id = $1
        GROUP BY o.id, o.name, o.picture_url, o.origin_country
       HAVING count(DISTINCT am.person_id) >= $2
        ORDER BY shared DESC, o.name
        LIMIT $3`,
      [id, RELATED_MIN_SHARED, RELATED_LIMIT],
    ),
    // Las dos direcciones; una relación consigo misma (dos fichas fusionadas) no cuenta.
    getPool().query<{
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
  ]);
  const byId = new Map<number, RelatedArtist>();
  for (const row of explicit.rows) {
    const otherId = Number(row.other_id);
    const item = byId.get(otherId) ?? {
      id: otherId, name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country,
      sharedMembers: 0, sharedMemberNames: [], relations: [],
    };
    item.relations.push({
      type: row.relation_type, direction: row.direction, bridgeMembers: row.bridge_members,
      startYear: row.start_year, endYear: row.end_year, note: row.evidence_note, sources: row.source_urls, confidence: row.confidence,
    });
    byId.set(otherId, item);
  }
  for (const row of shared.rows) {
    const otherId = Number(row.id);
    const item = byId.get(otherId);
    if (item) {
      item.sharedMembers = row.shared;
      item.sharedMemberNames = row.shared_names;
      continue;
    }
    byId.set(otherId, {
      id: otherId, name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country,
      sharedMembers: row.shared, sharedMemberNames: row.shared_names, relations: [],
    });
  }
  // Los linajes documentados primero (en su orden cronológico); después, los calculados.
  return [...byId.values()];
}

async function similarArtists(id: number, primaryGenre: PublicGenre | null): Promise<Pick<ArtistDetail, "similar" | "similarDecade">> {
  const { rows: [self] } = await getPool().query<{ start_year: number | null }>(
    `SELECT ${START_YEAR_SQL("a")} AS start_year FROM public.artists a WHERE a.id = $1`, [id]);
  const similarDecade = self?.start_year == null ? null : Math.floor(self.start_year / 10) * 10;
  if (!primaryGenre) return { similar: [], similarDecade };
  const { rows } = await getPool().query<{ id: string; name: string; picture_url: string | null; origin_country: string; start_year: number | null }>(
    `SELECT c.id::text AS id, c.name, c.picture_url, c.origin_country, c.start_year
       FROM (SELECT a.id, a.name, a.picture_url, a.origin_country, ${START_YEAR_SQL("a")} AS start_year
               FROM public.artists a
              WHERE a.id <> $1 AND ${genreFilterSql("artist", "a.id", "$2")}) c
      WHERE $3::int IS NULL OR (c.start_year >= $3::int AND c.start_year < $3::int + 10)
      ORDER BY (c.picture_url IS NULL), md5(c.id::text || $1::text)
      LIMIT $4`,
    [id, primaryGenre.slug, similarDecade, SIMILAR_LIMIT],
  );
  return {
    similarDecade,
    similar: rows.map((row) => ({
      id: Number(row.id), name: row.name, pictureUrl: row.picture_url, originCountry: row.origin_country, startYear: row.start_year,
    })),
  };
}

export async function getArtistDetail(id: number): Promise<ArtistDetail | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT a.id, a.name, a.artist_type, a.biography, a.picture_url, a.logo_url, a.origin_city,
            a.origin_country, a.formed_year, a.disbanded_year, a.notes,
            ${artistDeceasedSql("a.id")} AS is_deceased,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', am.id, 'personId', p.id, 'personName', p.name, 'personIsDeceased', ${personDeceasedSql("p")}, 'role', am.role,
           'personBirthDate', p.birth_date, 'personDeathDate', p.death_date,
           'fromYear', am.from_year, 'toYear', am.to_year, 'isCurrent', am.is_current
         ) ORDER BY am.from_year NULLS LAST, p.name)
         FROM public.artist_members am JOIN public.persons p ON p.id = am.person_id
         WHERE am.artist_id = a.id
       ), '[]'::jsonb) AS members,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'albumId', al.id, 'title', al.title, 'releaseYear', al.release_year,
           'albumType', al.album_type, 'coverUrl', al.cover_url
         ) ORDER BY al.release_year NULLS LAST, al.title)
         FROM public.albums al WHERE al.artist_id = a.id
       ), '[]'::jsonb) AS discography,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'alias', x.alias, 'aliasType', x.alias_type, 'isPrimary', x.is_primary))
         FROM ingest.artist_aliases x WHERE x.artist_id = a.id
       ), '[]'::jsonb) AS aliases,
       (SELECT jsonb_build_object('id', o.id, 'name', o.name)
          FROM public.albums al JOIN public.organizations o ON o.id = al.label_id
         WHERE al.artist_id = a.id
         ORDER BY al.release_year DESC NULLS LAST, al.id DESC LIMIT 1) AS last_label,
       COALESCE((
         SELECT jsonb_agg(l.link ORDER BY l.year DESC NULLS LAST, l.title, l.platform)
           FROM (
             SELECT al.release_year AS year, al.title, x.platform,
                    jsonb_build_object('platform', x.platform, 'url', x.url, 'albumId', al.id, 'albumTitle', al.title) AS link
               FROM public.albums al
               CROSS JOIN LATERAL (VALUES ('youtube', al.youtube_url), ('instagram', al.instagram_url), ('wordpress', al.wordpress_url)) AS x(platform, url)
              WHERE al.artist_id = a.id AND x.url IS NOT NULL AND x.url <> ''
           ) l
       ), '[]'::jsonb) AS links
     FROM public.artists a
     WHERE a.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const genres = (await publicGenresFor("artist", [id])).get(id)!;
  return {
    ...genres,
    id: Number(row["id"]),
    name: row["name"] as string,
    artistType: row["artist_type"] as string,
    biography: row["biography"] as string | null,
    pictureUrl: row["picture_url"] as string | null,
    logoUrl: row["logo_url"] as string | null,
    originCity: row["origin_city"] as string | null,
    originCountry: row["origin_country"] as string,
    formedYear: row["formed_year"] as number | null,
    disbandedYear: row["disbanded_year"] as number | null,
    notes: row["notes"] as string | null,
    isDeceased: row["is_deceased"] as boolean,
    members: row["members"] as ArtistDetail["members"],
    discography: row["discography"] as ArtistDetail["discography"],
    aliases: row["aliases"] as ArtistDetail["aliases"],
    lastLabel: row["last_label"] as ArtistDetail["lastLabel"],
    links: row["links"] as ArtistDetail["links"],
    related: await relatedArtists(id),
    ...await similarArtists(id, genres.primaryGenre),
  };
}
