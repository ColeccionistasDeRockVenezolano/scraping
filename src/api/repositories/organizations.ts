// CRV · Consultas de lectura para organizaciones (PHASES §E7A).
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface OrganizationListRow {
  id: number;
  name: string;
  organizationType: string;
  country: string | null;
}

export async function listOrganizations(
  query: PaginationQuery & { q?: string | undefined },
): Promise<{ rows: OrganizationListRow[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const [rows, count] = await Promise.all([
    getPool().query<{ id: string; name: string; organization_type: string; country: string | null }>(
      `SELECT id, name, organization_type, country
         FROM public.organizations
        WHERE $1::text IS NULL OR name ILIKE $1
        ORDER BY name
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.organizations WHERE $1::text IS NULL OR name ILIKE $1`,
      [pattern],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), name: row.name, organizationType: row.organization_type, country: row.country,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface OrganizationDetail {
  id: number;
  name: string;
  organizationType: string;
  biography: string | null;
  pictureUrl: string | null;
  websiteUrl: string | null;
  country: string | null;
  notes: string | null;
  labelAlbums: Array<{ albumId: number; title: string; releaseYear: number | null; artistId: number; artistName: string }>;
  creditedArtists: Array<{ artistId: number; artistName: string }>;
  associatedPersons: Array<{ id: number; personId: number; personName: string; role: string; fromYear: number | null; toYear: number | null }>;
  aliases: Array<{ id: number; alias: string; aliasType: string; isPrimary: boolean }>;
}

export async function getOrganizationDetail(id: number): Promise<OrganizationDetail | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT o.id, o.name, o.organization_type, o.biography, o.picture_url, o.website_url, o.country, o.notes,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'albumId', al.id, 'title', al.title, 'releaseYear', al.release_year,
           'artistId', ar.id, 'artistName', ar.name
         ) ORDER BY al.release_year NULLS LAST, al.title)
         FROM public.albums al JOIN public.artists ar ON ar.id = al.artist_id
         WHERE al.label_id = o.id
       ), '[]'::jsonb) AS label_albums,
       COALESCE((
         SELECT jsonb_agg(DISTINCT jsonb_build_object('artistId', ar2.id, 'artistName', ar2.name))
         FROM public.album_credits ac
         JOIN public.albums al2 ON al2.id = ac.album_id
         JOIN public.artists ar2 ON ar2.id = al2.artist_id
         WHERE ac.organization_id = o.id
       ), '[]'::jsonb) AS credited_artists,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', po.id, 'personId', p.id, 'personName', p.name, 'role', po.role,
           'fromYear', po.from_year, 'toYear', po.to_year
         ) ORDER BY p.name)
         FROM public.person_organizations po JOIN public.persons p ON p.id = po.person_id
         WHERE po.organization_id = o.id
       ), '[]'::jsonb) AS associated_persons,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'alias', x.alias, 'aliasType', x.alias_type, 'isPrimary', x.is_primary))
         FROM ingest.organization_aliases x WHERE x.organization_id = o.id
       ), '[]'::jsonb) AS aliases
     FROM public.organizations o
     WHERE o.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row["id"]),
    name: row["name"] as string,
    organizationType: row["organization_type"] as string,
    biography: row["biography"] as string | null,
    pictureUrl: row["picture_url"] as string | null,
    websiteUrl: row["website_url"] as string | null,
    country: row["country"] as string | null,
    notes: row["notes"] as string | null,
    labelAlbums: row["label_albums"] as OrganizationDetail["labelAlbums"],
    creditedArtists: row["credited_artists"] as OrganizationDetail["creditedArtists"],
    associatedPersons: row["associated_persons"] as OrganizationDetail["associatedPersons"],
    aliases: row["aliases"] as OrganizationDetail["aliases"],
  };
}
