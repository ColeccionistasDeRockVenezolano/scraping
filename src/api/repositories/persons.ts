// CRV · Consultas de lectura para personas (PHASES §E7A).
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface PersonListRow {
  id: number;
  name: string;
  nationality: string | null;
  isVenezuelan: boolean;
  pictureUrl: string | null;
}

export async function listPersons(
  query: PaginationQuery & { q?: string | undefined },
): Promise<{ rows: PersonListRow[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const [rows, count] = await Promise.all([
    getPool().query<{ id: string; name: string; nationality: string | null; is_venezuelan: boolean; picture_url: string | null }>(
      `SELECT id, name, nationality, is_venezuelan, picture_url
         FROM public.persons
        WHERE $1::text IS NULL OR name ILIKE $1
        ORDER BY name
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.persons WHERE $1::text IS NULL OR name ILIKE $1`,
      [pattern],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), name: row.name, nationality: row.nationality,
      isVenezuelan: row.is_venezuelan, pictureUrl: row.picture_url,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface PersonDetail {
  id: number;
  name: string;
  biography: string | null;
  pictureUrl: string | null;
  nationality: string | null;
  isVenezuelan: boolean;
  birthDate: string | null;
  deathDate: string | null;
  notes: string | null;
  bands: Array<{ id: number; artistId: number; artistName: string; role: string; fromYear: number | null; toYear: number | null; isCurrent: boolean }>;
  albumCredits: Array<{ id: number; albumId: number; albumTitle: string; artistId: number; artistName: string; creditType: string; role: string }>;
  trackCredits: Array<{ id: number; trackId: number; trackTitle: string; albumId: number; albumTitle: string; creditType: string; role: string }>;
  organizations: Array<{ id: number; organizationId: number; organizationName: string; role: string; fromYear: number | null; toYear: number | null }>;
  aliases: Array<{ id: number; alias: string; aliasType: string; isPrimary: boolean }>;
}

export async function getPersonDetail(id: number): Promise<PersonDetail | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT p.id, p.name, p.biography, p.picture_url, p.nationality, p.is_venezuelan,
            p.birth_date::text AS birth_date, p.death_date::text AS death_date, p.notes,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', am.id, 'artistId', ar.id, 'artistName', ar.name, 'role', am.role,
           'fromYear', am.from_year, 'toYear', am.to_year, 'isCurrent', am.is_current
         ) ORDER BY am.from_year NULLS LAST, ar.name)
         FROM public.artist_members am JOIN public.artists ar ON ar.id = am.artist_id
         WHERE am.person_id = p.id
       ), '[]'::jsonb) AS bands,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', ac.id, 'albumId', al.id, 'albumTitle', al.title, 'artistId', ar2.id, 'artistName', ar2.name,
           'creditType', ac.credit_type, 'role', ac.role
         ) ORDER BY al.title)
         FROM public.album_credits ac
         JOIN public.albums al ON al.id = ac.album_id
         JOIN public.artists ar2 ON ar2.id = al.artist_id
         WHERE ac.person_id = p.id
       ), '[]'::jsonb) AS album_credits,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', tc.id, 'trackId', t.id, 'trackTitle', t.title, 'albumId', al3.id, 'albumTitle', al3.title,
           'creditType', tc.credit_type, 'role', tc.role
         ) ORDER BY al3.title, t.disc_number, t.track_number)
         FROM public.track_credits tc
         JOIN public.tracks t ON t.id = tc.track_id
         JOIN public.albums al3 ON al3.id = t.album_id
         WHERE tc.person_id = p.id
       ), '[]'::jsonb) AS track_credits,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', po.id, 'organizationId', o.id, 'organizationName', o.name, 'role', po.role,
           'fromYear', po.from_year, 'toYear', po.to_year
         ) ORDER BY o.name)
         FROM public.person_organizations po JOIN public.organizations o ON o.id = po.organization_id
         WHERE po.person_id = p.id
       ), '[]'::jsonb) AS organizations,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'alias', x.alias, 'aliasType', x.alias_type, 'isPrimary', x.is_primary))
         FROM ingest.person_aliases x WHERE x.person_id = p.id
       ), '[]'::jsonb) AS aliases
     FROM public.persons p
     WHERE p.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row["id"]),
    name: row["name"] as string,
    biography: row["biography"] as string | null,
    pictureUrl: row["picture_url"] as string | null,
    nationality: row["nationality"] as string | null,
    isVenezuelan: row["is_venezuelan"] as boolean,
    birthDate: row["birth_date"] as string | null,
    deathDate: row["death_date"] as string | null,
    notes: row["notes"] as string | null,
    bands: row["bands"] as PersonDetail["bands"],
    albumCredits: row["album_credits"] as PersonDetail["albumCredits"],
    trackCredits: row["track_credits"] as PersonDetail["trackCredits"],
    organizations: row["organizations"] as PersonDetail["organizations"],
    aliases: row["aliases"] as PersonDetail["aliases"],
  };
}
