// CRV · Expedientes de integrantes (Brian, 2026-10-01: «hay muchas bandas que
// tienen los integrantes en la bio y nada en membresía»).
//
// Para cada artista SIN membresías junta lo que se sabe de su alineación:
//  * la biografía actual del core;
//  * los TEXTOS ORIGINALES del expediente de biografías (posts de los blogs,
//    Lobotoradio, Discogs, MusicBrainz, Wikipedia, La Venciclopedia, Last.fm,
//    directorio RHV…), con sus listas estructuradas de miembros («facts»);
//  * los músicos acreditados en sus PROPIOS discos (sin recopilatorios).
//
// Requiere los expedientes de biografías al día:
//   BIO_DOSSIERS_DIR=<dir> tsx scripts/export-biography-dossiers.ts --kinds=artist
// Solo lectura. Salida: <out>/member-dossiers.jsonl
// Uso: tsx scripts/export-member-dossiers.mts --bio=<dir de expedientes> --out=<dir> [--ids=1,2]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const BIO_DIR = arg("bio") ?? "reports/bio-dossiers";
const OUT_DIR = arg("out") ?? "reports/member-dossiers";
const ONLY = arg("ids")?.split(",").map(Number);
const MAX_TEXT = 4000;
const MAX_SOURCES_CHARS = 14000;

interface BioSource { ref: string; source: string; url: string | null; text: string; facts?: Record<string, unknown> }
interface BioDossier { entityId: number; sources: BioSource[] }

export interface MemberDossier {
  caseId: string;
  artistId: number;
  name: string;
  bio: string | null;
  catalog: { ciudad: string | null; formación: number | null; disolución: number | null; discos: string[] };
  /** Personas con crédito de músico (o invitado) en sus discos propios. */
  credited: Array<{ personId: number; name: string; roles: string[]; guestOnly: boolean; years: number[] }>;
  sources: Array<{ ref: string; source: string; url: string | null; text: string; facts?: Record<string, unknown> }>;
}

function loadBioDossiers(): Map<number, BioDossier> {
  const byId = new Map<number, BioDossier>();
  if (!existsSync(BIO_DIR)) return byId;
  for (const file of readdirSync(BIO_DIR).filter((name) => /^artist-\d+\.jsonl$/u.test(name))) {
    for (const line of readFileSync(path.join(BIO_DIR, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const dossier = JSON.parse(line) as BioDossier;
      byId.set(dossier.entityId, dossier);
    }
  }
  return byId;
}

async function main(): Promise<void> {
  const pool = getPool();
  const bioDossiers = loadBioDossiers();
  const { rows: artists } = await pool.query<{ id: string; name: string; biography: string | null; origin_city: string | null; formed_year: number | null; disbanded_year: number | null }>(`
    SELECT a.id::text, a.name, a.biography, a.origin_city, a.formed_year, a.disbanded_year
      FROM public.artists a
     WHERE NOT EXISTS (SELECT 1 FROM public.artist_members m WHERE m.artist_id = a.id)
       ${ONLY ? "AND a.id = ANY($1::bigint[])" : ""}
     ORDER BY a.id`, ONLY ? [ONLY] : []);
  const ids = artists.map((row) => Number(row.id));
  const { rows: albums } = await pool.query<{ artist_id: string; title: string; release_year: number | null; album_type: string }>(
    "SELECT artist_id::text, title, release_year, album_type::text FROM public.albums WHERE artist_id = ANY($1::bigint[]) ORDER BY release_year NULLS LAST, title", [ids]);
  // Créditos de músico o invitado en los discos propios (sin recopilatorios), de disco y de pista.
  const { rows: credits } = await pool.query<{ artist_id: string; person_id: string; name: string; role: string; credit_type: string; year: number | null }>(`
    SELECT al.artist_id::text, c.person_id::text, p.name, c.role, c.credit_type::text, al.release_year AS year
      FROM public.album_credits c JOIN public.albums al ON al.id = c.album_id JOIN public.persons p ON p.id = c.person_id
     WHERE al.artist_id = ANY($1::bigint[]) AND al.album_type <> 'compilation' AND c.credit_type IN ('musician','guest')
    UNION ALL
    SELECT al.artist_id::text, tc.person_id::text, p.name, tc.role, tc.credit_type::text, al.release_year
      FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id JOIN public.albums al ON al.id = t.album_id
      JOIN public.persons p ON p.id = tc.person_id
     WHERE al.artist_id = ANY($1::bigint[]) AND al.album_type <> 'compilation' AND tc.credit_type IN ('musician','guest')`, [ids]);

  const albumsBy = new Map<number, string[]>();
  for (const album of albums) {
    const list = albumsBy.get(Number(album.artist_id)) ?? [];
    list.push(`${album.title}${album.release_year ? ` (${album.release_year})` : ""} [${album.album_type}]`);
    albumsBy.set(Number(album.artist_id), list);
  }
  const creditsBy = new Map<number, Map<number, MemberDossier["credited"][number]>>();
  for (const credit of credits) {
    const artistId = Number(credit.artist_id);
    const personId = Number(credit.person_id);
    const people = creditsBy.get(artistId) ?? new Map();
    const entry = people.get(personId) ?? { personId, name: credit.name, roles: [], guestOnly: true, years: [] };
    if (!entry.roles.includes(credit.role)) entry.roles.push(credit.role);
    if (credit.credit_type === "musician") entry.guestOnly = false;
    if (credit.year && !entry.years.includes(credit.year)) entry.years.push(credit.year);
    people.set(personId, entry);
    creditsBy.set(artistId, people);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out: string[] = [];
  let withSources = 0;
  for (const artist of artists) {
    const id = Number(artist.id);
    let budget = MAX_SOURCES_CHARS;
    const sources: MemberDossier["sources"] = [];
    for (const source of bioDossiers.get(id)?.sources ?? []) {
      const text = (source.text ?? "").slice(0, Math.min(MAX_TEXT, Math.max(0, budget)));
      if (!text && !source.facts) continue;
      budget -= text.length;
      sources.push({ ref: source.ref, source: source.source, url: source.url, text, ...(source.facts ? { facts: source.facts } : {}) });
    }
    if (sources.length) withSources += 1;
    const credited = [...(creditsBy.get(id)?.values() ?? [])].map((entry) => ({ ...entry, years: entry.years.sort() }));
    const dossier: MemberDossier = {
      caseId: `artist:${id}`, artistId: id, name: artist.name, bio: artist.biography,
      catalog: { ciudad: artist.origin_city, formación: artist.formed_year, disolución: artist.disbanded_year, discos: (albumsBy.get(id) ?? []).slice(0, 25) },
      credited, sources,
    };
    out.push(JSON.stringify(dossier));
  }
  writeFileSync(path.join(OUT_DIR, "member-dossiers.jsonl"), out.join("\n") + "\n");
  console.log(JSON.stringify({ artistsWithoutMembers: artists.length, withSources, withCredits: creditsBy.size, out: path.join(OUT_DIR, "member-dossiers.jsonl") }));
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
