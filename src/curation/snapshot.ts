// CRV · Foto del catálogo para el detector de conflictos.
//
// Consultas planas, nada de N+1: la base es SQL_ASCII y no sabe comparar sin
// tildes (regla 0.1.11), así que toda comparación de texto se hace en
// TypeScript sobre esta foto. ~50k filas caben de sobra en memoria.
//
// UNA SOLA FOTO. Las consultas van en una transacción REPEATABLE READ de
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
  const albums = await db.query<{ id: string; artist_id: string; title: string; release_year: number | null; album_type: string; label_id: string | null }>(
    "SELECT id::text, artist_id::text, title, release_year, album_type::text, label_id::text FROM public.albums ORDER BY id");
  const tracks = await db.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string; duration_seconds: number | null }>(
    "SELECT id::text, album_id::text, disc_number, track_number, title, duration_seconds FROM public.tracks ORDER BY album_id, disc_number, track_number");
  const roles = await db.query<{ role: string; credit_type: string; uses: string }>(`
    SELECT role, credit_type::text, count(*)::text AS uses FROM (
      SELECT role, credit_type FROM public.album_credits UNION ALL SELECT role, credit_type FROM public.track_credits
    ) credits GROUP BY 1, 2`);
  const credits = await db.query<{
    id: string; parent_kind: "album" | "track"; parent_id: string;
    person_id: string | null; artist_id: string | null; organization_id: string | null;
    credit_type: string; role: string;
  }>(`
    SELECT id::text, 'album'::text AS parent_kind, album_id::text AS parent_id,
           person_id::text, artist_id::text, organization_id::text, credit_type::text, role
      FROM public.album_credits
    UNION ALL
    SELECT id::text, 'track'::text AS parent_kind, track_id::text AS parent_id,
           person_id::text, artist_id::text, organization_id::text, credit_type::text, role
      FROM public.track_credits`);
  const memberships = await db.query<{
    id: string; artist_id: string; person_id: string; role: string;
    from_year: number | null; to_year: number | null; is_current: boolean;
  }>(`
    SELECT id::text, artist_id::text, person_id::text, role, from_year, to_year, is_current
      FROM public.artist_members ORDER BY id`);
  const aliases = await db.query<{
    id: string; kind: "artist" | "person" | "organization" | "album" | "track";
    entity_id: string; alias: string; normalized_alias: string;
  }>(`
    SELECT id::text, 'artist'::text AS kind, artist_id::text AS entity_id, alias, normalized_alias FROM ingest.artist_aliases
    UNION ALL SELECT id::text, 'person', person_id::text, alias, normalized_alias FROM ingest.person_aliases
    UNION ALL SELECT id::text, 'organization', organization_id::text, alias, normalized_alias FROM ingest.organization_aliases
    UNION ALL SELECT id::text, 'album', album_id::text, alias, normalized_alias FROM ingest.album_aliases
    UNION ALL SELECT id::text, 'track', track_id::text, alias, normalized_alias FROM ingest.track_aliases`);
  const redirects = await db.query<{ kind: "artist" | "person" | "organization" | "album" | "track"; from_id: string; to_id: string }>(
    "SELECT entity_kind::text AS kind, from_id::text, to_id::text FROM ingest.entity_redirects ORDER BY entity_kind, from_id");
  const mediaLinks = await db.query<{
    id: string; entity_kind: string; artist_id: string | null; person_id: string | null;
    organization_id: string | null; album_id: string | null; url: string; media_type: string;
  }>(`
    SELECT id::text, entity_kind, artist_id::text, person_id::text, organization_id::text, album_id::text, url, media_type
      FROM media.media_links ORDER BY id`);
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
  // La evidencia de cada lado (fuente, confianza, fecha, URL) sale de sus
  // claims: la tarjeta de conflicto (PLAN_CURADURIA E7.1) la necesita sin
  // depender de una revisión viva, que `conflictos_abiertos` justamente no tiene.
  const conflicts = await db.query<{
    id: string; entity_kind: string; field: string; value_a: unknown; value_b: unknown; target_id: string | null; live_review: boolean;
    source_a_name: string; source_a_trust: string; source_a_url: string | null; source_a_at: Date;
    source_b_name: string; source_b_trust: string; source_b_url: string | null; source_b_at: Date;
  }>(`
    SELECT c.id::text, c.entity_kind::text, c.field, c.value_a, c.value_b,
           COALESCE(a.artist_id, a.person_id, a.organization_id, a.album_id, a.track_id)::text AS target_id,
           EXISTS (SELECT 1 FROM ingest.review_queue r WHERE r.conflict_id=c.id AND r.status IN ('open','in_progress')) AS live_review,
           sa.name AS source_a_name, sa.trust_level::text AS source_a_trust, COALESCE(rpa.canonical_url, rpa.url, sa.url) AS source_a_url, a.created_at AS source_a_at,
           sb.name AS source_b_name, sb.trust_level::text AS source_b_trust, COALESCE(rpb.canonical_url, rpb.url, sb.url) AS source_b_url, b.created_at AS source_b_at
      FROM ingest.conflicts c
      JOIN ingest.claims a ON a.id=c.claim_a_id
      JOIN ingest.claims b ON b.id=c.claim_b_id
      JOIN ingest.sources sa ON sa.id=a.source_id
      JOIN ingest.sources sb ON sb.id=b.source_id
      LEFT JOIN ingest.raw_pages rpa ON rpa.id=a.raw_page_id
      LEFT JOIN ingest.raw_pages rpb ON rpb.id=b.raw_page_id
     WHERE c.status='open' ORDER BY c.id`);
  const handled = await db.query<{ kind: string; person_a_id: string | null; person_b_id: string | null; pair_key: string | null }>(`
    SELECT kind::text, person_a_id::text, person_b_id::text, payload->>'pairKey' AS pair_key
      FROM ingest.review_queue WHERE kind IN ('person_duplicate','possible_duplicate')`);
  // Pares declarados distintos (0020). Antes de migrar la tabla no existe y no
  // hay ninguno declarado: un `--dry-run` sobre una base sin migrar sigue
  // funcionando. Se pregunta primero porque una consulta fallida aborta la foto.
  const distinctTable = await db.query<{ present: boolean }>("SELECT to_regclass('ingest.curation_distinct_pairs') IS NOT NULL AS present");
  const distinct = distinctTable.rows[0]?.present
    ? await db.query<{ kind: string; a_id: string; b_id: string }>("SELECT kind, a_id::text, b_id::text FROM ingest.curation_distinct_pairs")
    : { rows: [] };
  return { artists, persons, organizations, albums, tracks, roles, credits, memberships, aliases, redirects, mediaLinks,
    personArtists, personLinks, organizationLinks, artistLinks, reviews, conflicts, handled, distinct };
}

function buildSnapshot({
  artists, persons, organizations, albums, tracks, roles, credits, memberships, aliases, redirects, mediaLinks,
  personArtists, personLinks, organizationLinks, artistLinks,
  reviews, conflicts, handled, distinct,
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
  const distinctPairs = new Set(distinct.rows.map((row) => pairKey(row.kind, Number(row.a_id), Number(row.b_id))));
  for (const key of distinctPairs) handledPairs.add(key);

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
    albums: albums.rows.map((row) => ({ id: Number(row.id), artistId: Number(row.artist_id), title: row.title, releaseYear: row.release_year, albumType: row.album_type, labelId: num(row.label_id) })),
    tracks: tracks.rows.map((row) => ({ id: Number(row.id), albumId: Number(row.album_id), disc: row.disc_number, number: row.track_number, title: row.title, durationSeconds: row.duration_seconds })),
    creditRoles: roles.rows.map((row) => ({ role: row.role, creditType: row.credit_type, uses: Number(row.uses) })),
    credits: credits.rows.map((row) => ({
      id: Number(row.id), parentKind: row.parent_kind, parentId: Number(row.parent_id),
      personId: num(row.person_id), artistId: num(row.artist_id), organizationId: num(row.organization_id),
      creditType: row.credit_type, role: row.role,
    })),
    memberships: memberships.rows.map((row) => ({
      id: Number(row.id), artistId: Number(row.artist_id), personId: Number(row.person_id), role: row.role,
      fromYear: row.from_year, toYear: row.to_year, isCurrent: row.is_current,
    })),
    aliases: aliases.rows.map((row) => ({
      id: Number(row.id), kind: row.kind, entityId: Number(row.entity_id), alias: row.alias, normalizedAlias: row.normalized_alias,
    })),
    redirects: redirects.rows.map((row) => ({ kind: row.kind, fromId: Number(row.from_id), toId: Number(row.to_id) })),
    mediaLinks: mediaLinks.rows.map((row) => ({
      id: Number(row.id), entityKind: row.entity_kind, artistId: num(row.artist_id), personId: num(row.person_id),
      organizationId: num(row.organization_id), albumId: num(row.album_id), url: row.url, mediaType: row.media_type,
    })),
    personArtists: personArtistMap,
    personLinks: countMap(personLinks.rows),
    organizationLinks: countMap(organizationLinks.rows),
    artistLinks: countMap(artistLinks.rows),
    reviews: reviewRows,
    conflicts: conflicts.rows.map((row) => ({
      id: Number(row.id), entityKind: row.entity_kind, field: row.field, valueA: row.value_a, valueB: row.value_b,
      targetId: num(row.target_id), hasLiveReview: row.live_review,
      sourceA: { name: row.source_a_name, trustLevel: row.source_a_trust, url: row.source_a_url, at: new Date(row.source_a_at).toISOString() },
      sourceB: { name: row.source_b_name, trustLevel: row.source_b_trust, url: row.source_b_url, at: new Date(row.source_b_at).toISOString() },
    })),
    handledPairs,
    distinctPairs,
  };
}

// ---------------------------------------------------------------------------
// Foto dirigida (PLAN_CURADURIA E9.1)
// ---------------------------------------------------------------------------

/**
 * La vecindad de una ficha: lo que un detector LOCAL necesita para decidir
 * sobre ella y dar el mismo resultado que daría mirando el catálogo entero.
 *
 *  * una pista necesita su disco (para el artista del disco y el título) y las
 *    demás pistas de ese disco (la numeración se juzga por cara completa);
 *  * un disco necesita su artista y todas sus pistas;
 *  * un artista tocado necesita sus discos —renombrarlo cambia lo que se
 *    detecta en los títulos que lo repiten— y, con ellos, sus pistas;
 *  * una persona o una organización se bastan con sus vínculos.
 *
 * Todo lo demás que un detector local consulta —cómo se escriben los nombres
 * del catálogo, qué artistas existen con cada clave, la distribución de
 * duraciones— vive en el vocabulario, que se aprende del catálogo entero y se
 * reutiliza (E9.3).
 *
 * `covered` es la promesa que sostiene la resolución: «esto lo miré». Incluye
 * lo que se pidió aunque ya no exista (una ficha retirada por una fusión: su
 * ausencia es justo lo que resuelve el hallazgo) y lo que se cargó de vecindad.
 */
export interface FocusRef { kind: string; id: number }

export interface FocusedSnapshot {
  snapshot: CatalogSnapshot;
  covered: FocusRef[];
}

/** Tope de discos que arrastra un artista tocado: más allá, el análisis completo se encarga. */
const FOCUS_ALBUM_LIMIT = 500;

const ids = (focus: readonly FocusRef[], kind: string): number[] =>
  [...new Set(focus.filter((ref) => ref.kind === kind && Number.isSafeInteger(ref.id)).map((ref) => ref.id))];

export async function loadFocusedSnapshot(db: SnapshotClient, focus: readonly FocusRef[]): Promise<FocusedSnapshot> {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const loaded = await readFocus(db, focus);
    await db.query("COMMIT");
    return loaded;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function readFocus(db: SnapshotClient, focus: readonly FocusRef[]): Promise<FocusedSnapshot> {
  const artistIds = new Set(ids(focus, "artist"));
  const personIds = ids(focus, "person");
  const organizationIds = ids(focus, "organization");
  const albumIds = new Set(ids(focus, "album"));
  const trackIds = ids(focus, "track");

  // La pista pedida trae su disco; el disco traerá luego a todas sus hermanas.
  if (trackIds.length) {
    const { rows } = await db.query<{ album_id: string }>("SELECT album_id::text FROM public.tracks WHERE id = ANY($1::bigint[])", [trackIds]);
    for (const row of rows) albumIds.add(Number(row.album_id));
  }
  if (artistIds.size) {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id::text FROM public.albums WHERE artist_id = ANY($1::bigint[]) ORDER BY id LIMIT $2", [[...artistIds], FOCUS_ALBUM_LIMIT]);
    for (const row of rows) albumIds.add(Number(row.id));
  }

  const albums = await db.query<{ id: string; artist_id: string; title: string; release_year: number | null; album_type: string; label_id: string | null }>(
    "SELECT id::text, artist_id::text, title, release_year, album_type::text, label_id::text FROM public.albums WHERE id = ANY($1::bigint[]) ORDER BY id", [[...albumIds]]);
  for (const row of albums.rows) artistIds.add(Number(row.artist_id));

  // Todas las pistas de los discos cubiertos (la numeración solo se juzga
  // entera), más las pistas pedidas cuyo disco no entró.
  const tracks = await db.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string; duration_seconds: number | null }>(`
    SELECT id::text, album_id::text, disc_number, track_number, title, duration_seconds
      FROM public.tracks WHERE album_id = ANY($1::bigint[]) OR id = ANY($2::bigint[])
     ORDER BY album_id, disc_number, track_number`, [[...albumIds], trackIds]);

  const artists = await db.query<{ id: string; name: string; origin_city: string | null; formed_year: number | null; disbanded_year: number | null }>(
    "SELECT id::text, name, origin_city, formed_year, disbanded_year FROM public.artists WHERE id = ANY($1::bigint[]) ORDER BY id", [[...artistIds]]);
  const persons = await db.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.persons WHERE id = ANY($1::bigint[]) ORDER BY id", [personIds]);
  const organizations = await db.query<{ id: string; name: string; organization_type: string }>(
    "SELECT id::text, name, organization_type::text FROM public.organizations WHERE id = ANY($1::bigint[]) ORDER BY id", [organizationIds]);

  // Vínculos de las fichas cubiertas: sin ellos, «Fichas sin vínculos» daría
  // por huérfano a todo lo que mira.
  const personLinks = await db.query<{ id: string; n: string }>(`
    SELECT id::text, count(*)::text AS n FROM (
      SELECT person_id AS id FROM public.artist_members WHERE person_id = ANY($1::bigint[])
      UNION ALL SELECT person_id FROM public.album_credits WHERE person_id = ANY($1::bigint[])
      UNION ALL SELECT person_id FROM public.track_credits WHERE person_id = ANY($1::bigint[])
      UNION ALL SELECT person_id FROM public.person_organizations WHERE person_id = ANY($1::bigint[])
    ) links GROUP BY id`, [personIds]);
  const organizationLinks = await db.query<{ id: string; n: string }>(`
    SELECT id::text, count(*)::text AS n FROM (
      SELECT label_id AS id FROM public.albums WHERE label_id = ANY($1::bigint[])
      UNION ALL SELECT organization_id FROM public.album_credits WHERE organization_id = ANY($1::bigint[])
      UNION ALL SELECT organization_id FROM public.track_credits WHERE organization_id = ANY($1::bigint[])
      UNION ALL SELECT organization_id FROM public.person_organizations WHERE organization_id = ANY($1::bigint[])
    ) links GROUP BY id`, [organizationIds]);
  const artistLinks = await db.query<{ id: string; n: string }>(`
    SELECT id::text, count(*)::text AS n FROM (
      SELECT artist_id AS id FROM public.albums WHERE artist_id = ANY($1::bigint[])
      UNION ALL SELECT artist_id FROM public.album_credits WHERE artist_id = ANY($1::bigint[])
      UNION ALL SELECT artist_id FROM public.track_credits WHERE artist_id = ANY($1::bigint[])
      UNION ALL SELECT artist_id FROM public.artist_members WHERE artist_id = ANY($1::bigint[])
    ) links GROUP BY id`, [[...artistIds]]);
  const personArtists = await db.query<{ person_id: string; artist_id: string }>(`
    SELECT person_id::text, artist_id::text FROM public.artist_members WHERE person_id = ANY($1::bigint[])
    UNION SELECT c.person_id::text, a.artist_id::text FROM public.album_credits c JOIN public.albums a ON a.id=c.album_id WHERE c.person_id = ANY($1::bigint[])
    UNION SELECT c.person_id::text, a.artist_id::text FROM public.track_credits c JOIN public.tracks t ON t.id=c.track_id JOIN public.albums a ON a.id=t.album_id
     WHERE c.person_id = ANY($1::bigint[])`, [personIds]);

  const personArtistMap = new Map<number, Set<number>>();
  for (const row of personArtists.rows) {
    const id = Number(row.person_id);
    personArtistMap.set(id, (personArtistMap.get(id) ?? new Set<number>()).add(Number(row.artist_id)));
  }

  const snapshot: CatalogSnapshot = {
    takenAt: new Date(),
    artists: artists.rows.map((row) => ({ id: Number(row.id), name: row.name, originCity: row.origin_city, formedYear: row.formed_year, disbandedYear: row.disbanded_year })),
    persons: persons.rows.map((row) => ({ id: Number(row.id), name: row.name })),
    organizations: organizations.rows.map((row) => ({ id: Number(row.id), name: row.name, type: row.organization_type })),
    albums: albums.rows.map((row) => ({ id: Number(row.id), artistId: Number(row.artist_id), title: row.title, releaseYear: row.release_year, albumType: row.album_type, labelId: num(row.label_id) })),
    tracks: tracks.rows.map((row) => ({ id: Number(row.id), albumId: Number(row.album_id), disc: row.disc_number, number: row.track_number, title: row.title, durationSeconds: row.duration_seconds })),
    // El vocabulario llega aprendido del catálogo entero (E9.3): los roles solo
    // lo alimentan a él. Revisiones, conflictos y pares son de detectores
    // globales, que un análisis dirigido no corre ni resuelve.
    creditRoles: [],
    credits: [],
    memberships: [],
    aliases: [],
    redirects: [],
    mediaLinks: [],
    personArtists: personArtistMap,
    personLinks: countMap(personLinks.rows),
    organizationLinks: countMap(organizationLinks.rows),
    artistLinks: countMap(artistLinks.rows),
    reviews: [],
    conflicts: [],
    handledPairs: new Set(),
    distinctPairs: new Set(),
  };

  const covered = new Map<string, FocusRef>();
  const cover = (kind: string, id: number) => covered.set(`${kind}:${id}`, { kind, id });
  for (const ref of focus) if (Number.isSafeInteger(ref.id)) cover(ref.kind, ref.id);
  for (const artist of snapshot.artists) cover("artist", artist.id);
  for (const person of snapshot.persons) cover("person", person.id);
  for (const organization of snapshot.organizations) cover("organization", organization.id);
  for (const album of snapshot.albums) cover("album", album.id);
  for (const track of snapshot.tracks) cover("track", track.id);
  return { snapshot, covered: [...covered.values()] };
}
