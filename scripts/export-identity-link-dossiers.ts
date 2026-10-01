// CRV · Expedientes de identidad persona ↔ artista (Brian, 2026-09-30, caso Ashwave).
//
// Ashwave es el proyecto solista de Pedro Castillo, pero el catálogo tenía la
// persona y el artista sin ningún vínculo. Aquí se reúnen todos los pares
// (artista, persona) donde el nombre del artista coincide con el nombre o con
// un alias de una persona que NO es miembro del artista. Laya decide después
// si la persona ES el artista (solista), si la «persona» es en realidad un
// grupo, o si son entidades distintas. Solo lectura: escribe
// reports/identity-link-dossiers-2026-09-30.jsonl.
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { nameKey } from "../src/curation/lexicon.js";
import { classifyPersonName, looksLikeOrganization } from "../src/review/person-junk.js";

const OUT = "reports/identity-link-dossiers-2026-09-30.jsonl";
const MAX_BIO = 700;

interface Row { id: string; name: string; bio: string | null }

async function main(): Promise<void> {
  const pool = getPool();
  const artists = (await pool.query<Row & { origin: string | null }>(
    "SELECT id::text, name, biography AS bio, origin_country AS origin FROM public.artists")).rows;
  const persons = (await pool.query<Row & { venezuelan: boolean | null }>(
    "SELECT id::text, name, biography AS bio, is_venezuelan AS venezuelan FROM public.persons")).rows;
  const personAliases = new Map<number, string[]>();
  for (const row of (await pool.query<{ person_id: string; alias: string }>("SELECT person_id::text, alias FROM ingest.person_aliases")).rows) {
    personAliases.set(Number(row.person_id), [...(personAliases.get(Number(row.person_id)) ?? []), row.alias]);
  }
  const members = new Map<number, Array<{ personId: number; name: string; role: string }>>();
  for (const row of (await pool.query<{ artist_id: string; person_id: string; name: string; role: string }>(
    "SELECT m.artist_id::text, m.person_id::text, p.name, m.role FROM public.artist_members m JOIN public.persons p ON p.id=m.person_id")).rows) {
    members.set(Number(row.artist_id), [...(members.get(Number(row.artist_id)) ?? []), { personId: Number(row.person_id), name: row.name, role: row.role }]);
  }
  const albumCount = new Map<number, number>();
  for (const row of (await pool.query<{ artist_id: string; n: number }>("SELECT artist_id::text, count(*)::int AS n FROM public.albums GROUP BY 1")).rows) albumCount.set(Number(row.artist_id), row.n);
  // Créditos de la persona en discos del artista.
  const credits = new Map<string, { roles: Set<string>; albums: Set<number> }>();
  for (const row of (await pool.query<{ artist_id: string; person_id: string; album_id: string; role: string; credit_type: string }>(`
    SELECT a.artist_id::text, c.person_id::text, a.id::text AS album_id, c.role, c.credit_type::text
      FROM public.album_credits c JOIN public.albums a ON a.id=c.album_id WHERE c.person_id IS NOT NULL`)).rows) {
    const key = `${row.artist_id}:${row.person_id}`;
    const entry = credits.get(key) ?? { roles: new Set<string>(), albums: new Set<number>() };
    entry.roles.add(`${row.credit_type}: ${row.role}`); entry.albums.add(Number(row.album_id));
    credits.set(key, entry);
  }
  const totalCredits = new Map<number, number>();
  for (const row of (await pool.query<{ person_id: string; n: number }>(
    "SELECT person_id::text, count(*)::int AS n FROM public.album_credits WHERE person_id IS NOT NULL GROUP BY 1")).rows) totalCredits.set(Number(row.person_id), row.n);
  const otherBands = new Map<number, string[]>();
  for (const row of (await pool.query<{ person_id: string; name: string }>(
    "SELECT m.person_id::text, a.name FROM public.artist_members m JOIN public.artists a ON a.id=m.artist_id")).rows) {
    otherBands.set(Number(row.person_id), [...(otherBands.get(Number(row.person_id)) ?? []), row.name]);
  }

  const byKey = new Map<string, Set<number>>();
  for (const person of persons) {
    for (const label of [person.name, ...(personAliases.get(Number(person.id)) ?? [])]) {
      const key = nameKey(label);
      if (key.length < 3) continue;
      byKey.set(key, new Set([...(byKey.get(key) ?? []), Number(person.id)]));
    }
  }
  const personById = new Map(persons.map((p) => [Number(p.id), p]));
  const cases: unknown[] = [];
  for (const artist of artists) {
    const artistId = Number(artist.id);
    const found = byKey.get(nameKey(artist.name));
    if (!found) continue;
    for (const personId of found) {
      const person = personById.get(personId)!;
      const bandMembers = members.get(artistId) ?? [];
      if (bandMembers.some((m) => m.personId === personId)) continue;
      const credit = credits.get(`${artistId}:${personId}`);
      const viaAlias = nameKey(person.name) !== nameKey(artist.name);
      cases.push({
        caseId: `${artistId}-${personId}`, artistId, personId,
        artist: artist.name, person: person.name, viaAlias,
        artistBio: artist.bio?.slice(0, MAX_BIO) ?? null, personBio: person.bio?.slice(0, MAX_BIO) ?? null,
        artistAlbums: albumCount.get(artistId) ?? 0,
        artistMembers: bandMembers.length, artistMemberNames: bandMembers.slice(0, 8).map((m) => `${m.name} (${m.role})`),
        personAliases: (personAliases.get(personId) ?? []).slice(0, 8),
        personCreditsAtArtist: credit?.albums.size ?? 0, personRolesAtArtist: [...(credit?.roles ?? [])].slice(0, 8),
        personTotalCredits: totalCredits.get(personId) ?? 0, personOtherBands: (otherBands.get(personId) ?? []).slice(0, 6),
        personNameClass: classifyPersonName(person.name).kind, personLooksOrganization: looksLikeOrganization(person.name),
        personVenezuelan: (person as { venezuelan: boolean | null }).venezuelan,
      });
    }
  }
  writeFileSync(OUT, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(`${cases.length} expedientes → ${OUT}`);
  await closeDb();
}

main().catch((error) => { console.error(error); process.exit(1); });
