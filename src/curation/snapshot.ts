// CRV · Foto del catálogo para el detector de conflictos.
//
// Consultas planas, nada de N+1: la base es SQL_ASCII y no sabe comparar sin
// tildes (regla 0.1.11), así que toda comparación de texto se hace en
// TypeScript sobre esta foto. ~50k filas caben de sobra en memoria.
//
// UNA SOLA FOTO. Las 13 consultas van en una transacción REPEATABLE READ de
// solo lectura sobre un mismo cliente: todas ven el mismo instante. Repartidas
// por el pool, cada una veía uno distinto y, durante una ingesta, pistas y
// discos podían no corresponderse: hallazgos fantasma que aparecían y se
// resolvían solos, y encadenamientos falsos. En un cliente las consultas van
// una tras otra de todos modos: secuenciales no cuesta tiempo.
import type { PoolClient } from "pg";
import type { CatalogSnapshot, SnapshotReview } from "./types.js";

/** Un cliente, no el pool: la transacción solo existe dentro de una conexión. */
type SnapshotClient = Pick<PoolClient, "query" | "release">;

const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

function pairKey(prefix: string, a: number, b: number): string {
  return `${prefix}:${Math.min(a, b)}-${Math.max(a, b)}`;
}

function countMap(rows: Array<{ id: string; n: string }>): Map<number, number> {
  return new Map(rows.map((row) => [Number(row.id), Number(row.n)]));
}

export async function loadCatalogSnapshot(db: SnapshotClient): Promise<CatalogSnapshot> {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let results;
  try {
    results = await readCatalog(db);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return buildSnapshot(results);
}

/** Una consulta detrás de otra: `pg` ya no admite encolarlas en un cliente ocupado (obsoleto en pg 8, fuera en pg 9). */
async function readCatalog(db: SnapshotClient) {
  const artists = await db.query<{ id: string; name: string; origin_city: string | null; formed_year: number | null; disbanded_year: number | null }>(
    "SELECT id::text, name, origin_city, formed_year, disbanded_year FROM public.artists ORDER BY id");
  const persons = await db.query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons ORDER BY id");
  const organizations = await db.query<{ id: string; name: string; organization_type: string }>(
    "SELECT id::text, name, organization_type::text FROM public.organizations ORDER BY id");
  const albums = await db.query<{ id: string; artist_id: string; title: string; release_year: number | null; album_type: string }>(
    "SELECT id::text, artist_id::text, title, release_year, album_type::text FROM public.albums ORDER BY id");
  const tracks = await db.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string; duration_seconds: number | null }>(
    "SELECT id::text, album_id::text, disc_number, track_number, title, duration_seconds FROM public.tracks ORDER BY album_id, disc_number, track_number");
  const roles = await db.query<{ role: string; credit_type: string; uses: string }>(`
    SELECT role, credit_type::text, count(*)::text AS uses FROM (
      SELECT role, credit_type FROM public.album_credits UNION ALL SELECT role, credit_type FROM public.track_credits
    ) credits GROUP BY 1, 2`);
  const personArtists = await db.query<{ person_id: string; artist_id: string }>(`
    SELECT person_id::text, artist_id::text FROM public.artist_members
    UNION SELECT c.person_id::text, a.artist_id::text FROM public.album_credits c JOIN public.albums a ON a.id=c.album_id WHERE c.person_id IS NOT NULL
    UNION SELECT c.person_id::text, a.artist_id::text FROM public.track_credits c JOIN public.tracks t ON t.id=c.track_id JOIN public.albums a ON a.id=t.album_id WHERE c.person_id IS NOT NULL`);
  const personLinks = await db.query<{ id: string; n: string }>(`
    SELECT id::text, count(*)::text AS n FROM (
      SELECT person_id AS id FROM public.artist_members
      UNION ALL SELECT person_id FROM public.album_credits WHERE person_id IS NOT NULL
      UNION ALL SELECT person_id FROM public.track_credits WHERE person_id IS NOT NULL
      UNION ALL SELECT person_id FROM public.person_organizations
    ) links GROUP BY id`);
  const organizationLinks = await db.query<{ id: string; n: string }>(`
    SELECT id::text, count(*)::text AS n FROM (
      SELECT label_id AS id FROM public.albums WHERE label_id IS NOT NULL
      UNION ALL SELECT organization_id FROM public.album_credits WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM public.track_credits WHERE organization_id IS NOT NULL
      UNION ALL SELECT organization_id FROM public.person_organizations
    ) links GROUP BY id`);
  const artistLinks = await db.query<{ id: string; n: string }>(`
    SELECT id::text, count(*)::text AS n FROM (
      SELECT artist_id AS id FROM public.albums
      UNION ALL SELECT artist_id FROM public.album_credits WHERE artist_id IS NOT NULL
      UNION ALL SELECT artist_id FROM public.track_credits WHERE artist_id IS NOT NULL
      UNION ALL SELECT artist_id FROM public.artist_members
    ) links GROUP BY id`);
  const reviews = await db.query<{
    id: string; kind: string; status: string; priority: number; notes: string | null; payload: unknown; created_at: Date;
    artist_a_id: string | null; artist_b_id: string | null; person_a_id: string | null; person_b_id: string | null;
    organization_a_id: string | null; organization_b_id: string | null; album_id: string | null; track_id: string | null; conflict_id: string | null;
  }>(`
    SELECT id::text, kind::text, status::text, priority, notes, payload, created_at,
           artist_a_id::text, artist_b_id::text, person_a_id::text, person_b_id::text,
           organization_a_id::text, organization_b_id::text, album_id::text, track_id::text, conflict_id::text
      FROM ingest.review_queue WHERE status IN ('open','in_progress') ORDER BY id`);
  const conflicts = await db.query<{ id: string; entity_kind: string; field: string; value_a: unknown; value_b: unknown; target_id: string | null; live_review: boolean }>(`
    SELECT c.id::text, c.entity_kind::text, c.field, c.value_a, c.value_b,
           COALESCE(a.artist_id, a.person_id, a.organization_id, a.album_id, a.track_id)::text AS target_id,
           EXISTS (SELECT 1 FROM ingest.review_queue r WHERE r.conflict_id=c.id AND r.status IN ('open','in_progress')) AS live_review
      FROM ingest.conflicts c JOIN ingest.claims a ON a.id=c.claim_a_id
     WHERE c.status='open' ORDER BY c.id`);
  const handled = await db.query<{ kind: string; person_a_id: string | null; person_b_id: string | null; pair_key: string | null }>(`
    SELECT kind::text, person_a_id::text, person_b_id::text, payload->>'pairKey' AS pair_key
      FROM ingest.review_queue WHERE kind IN ('person_duplicate','possible_duplicate')`);
  return { artists, persons, organizations, albums, tracks, roles,
    personArtists, personLinks, organizationLinks, artistLinks, reviews, conflicts, handled };
}

function buildSnapshot({
  artists, persons, organizations, albums, tracks, roles,
  personArtists, personLinks, organizationLinks, artistLinks,
  reviews, conflicts, handled,
}: Awaited<ReturnType<typeof readCatalog>>): CatalogSnapshot {
  const personArtistMap = new Map<number, Set<number>>();
  for (const row of personArtists.rows) {
    const id = Number(row.person_id);
    personArtistMap.set(id, (personArtistMap.get(id) ?? new Set<number>()).add(Number(row.artist_id)));
  }

  const handledPairs = new Set<string>();
  for (const row of handled.rows) {
    if (row.pair_key) handledPairs.add(row.pair_key);
    if (row.person_a_id && row.person_b_id) handledPairs.add(pairKey("person", Number(row.person_a_id), Number(row.person_b_id)));
  }

  const reviewRows: SnapshotReview[] = reviews.rows.map((row) => {
    const refs: SnapshotReview["refs"] = {};
    const put = (key: keyof SnapshotReview["refs"], value: string | null) => { if (value !== null) refs[key] = Number(value); };
    put("artistA", row.artist_a_id); put("artistB", row.artist_b_id);
    put("personA", row.person_a_id); put("personB", row.person_b_id);
    put("organizationA", row.organization_a_id); put("organizationB", row.organization_b_id);
    put("album", row.album_id); put("track", row.track_id); put("conflict", row.conflict_id);
    return {
      id: Number(row.id), kind: row.kind, status: row.status, priority: row.priority, notes: row.notes,
      payload: row.payload, createdAt: new Date(row.created_at).toISOString(), refs,
    };
  });

  return {
    takenAt: new Date(),
    artists: artists.rows.map((row) => ({ id: Number(row.id), name: row.name, originCity: row.origin_city, formedYear: row.formed_year, disbandedYear: row.disbanded_year })),
    persons: persons.rows.map((row) => ({ id: Number(row.id), name: row.name })),
    organizations: organizations.rows.map((row) => ({ id: Number(row.id), name: row.name, type: row.organization_type })),
    albums: albums.rows.map((row) => ({ id: Number(row.id), artistId: Number(row.artist_id), title: row.title, releaseYear: row.release_year, albumType: row.album_type })),
    tracks: tracks.rows.map((row) => ({ id: Number(row.id), albumId: Number(row.album_id), disc: row.disc_number, number: row.track_number, title: row.title, durationSeconds: row.duration_seconds })),
    creditRoles: roles.rows.map((row) => ({ role: row.role, creditType: row.credit_type, uses: Number(row.uses) })),
    personArtists: personArtistMap,
    personLinks: countMap(personLinks.rows),
    organizationLinks: countMap(organizationLinks.rows),
    artistLinks: countMap(artistLinks.rows),
    reviews: reviewRows,
    conflicts: conflicts.rows.map((row) => ({
      id: Number(row.id), entityKind: row.entity_kind, field: row.field, valueA: row.value_a, valueB: row.value_b,
      targetId: num(row.target_id), hasLiveReview: row.live_review,
    })),
    handledPairs,
  };
}
