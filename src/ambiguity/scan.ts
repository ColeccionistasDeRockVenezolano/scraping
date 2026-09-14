// E10 · Lleva a la cola los casos dudosos que el cierre de F2–F5 dejó
// descritos en PHASES.md pero fuera de ella: discos del mismo artista que
// comparten pistas en la misma posición y personas con grafías distintas.
//
// El resolutor solo trabaja sobre la cola, nunca sobre el catálogo entero: este
// barrido es el que decide qué entra, con dos reglas deterministas.
//  * Un par de discos entra si comparte al menos tres pistas en la misma
//    posición (el criterio del cierre de F2–F5).
//  * Un par de personas entra si sus nombres guardan una relación reconocible
//    Y comparten una banda. El parecido del nombre solo no es evidencia; esos
//    pares no se encolan, pero quedan listados en reports/ambiguity-scan.json.
//
// Idempotente: cada par tiene su `pairKey` y un par ya encolado —abierto o
// decidido— no se vuelve a abrir.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { youtubeLinkKey } from "../youtube/linker.js";
import { compareTracklists, type AlbumTrack } from "./albums.js";
import { parsePersonName, personRelation, type PersonRelation } from "./text.js";

const log = moduleLogger("ambiguity:scan");

export const SCAN_VIA = "ambiguity:scan";
export const MIN_SHARED_POSITIONS = 3;

export interface ScanAlbum { id: number; artistId: number; artistName: string; title: string; }
export interface AlbumPairCandidate { pairKey: string; ids: [number, number]; artist: string; titles: [string, string]; samePositions: number; commonPositions: number; }
export interface PersonPairCandidate { pairKey: string; ids: [number, number]; names: [string, string]; relation: PersonRelation; sharedArtists: string[]; }

export function findAlbumPairCandidates(albums: ScanAlbum[], tracks: Map<number, AlbumTrack[]>): AlbumPairCandidate[] {
  const byArtist = new Map<number, ScanAlbum[]>();
  for (const album of albums) byArtist.set(album.artistId, [...(byArtist.get(album.artistId) ?? []), album]);
  const out: AlbumPairCandidate[] = [];
  for (const list of byArtist.values()) {
    const sorted = [...list].sort((x, y) => x.id - y.id);
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i]!; const ta = tracks.get(a.id);
      if (!ta?.length) continue;
      const exactA = new Map(ta.map((track) => [`${track.disc}.${track.number}`, youtubeLinkKey(track.title)]));
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j]!; const tb = tracks.get(b.id);
        if (!tb?.length) continue;
        // Filtro barato antes de comparar con erratas: alguna pista idéntica en la misma posición.
        if (!tb.some((track) => exactA.get(`${track.disc}.${track.number}`) === youtubeLinkKey(track.title))) continue;
        const comparison = compareTracklists(ta, tb);
        if (comparison.same < MIN_SHARED_POSITIONS) continue;
        out.push({ pairKey: `album:${a.id}-${b.id}`, ids: [a.id, b.id], artist: a.artistName, titles: [a.title, b.title], samePositions: comparison.same, commonPositions: comparison.common });
      }
    }
  }
  return out.sort((x, y) => x.ids[0] - y.ids[0] || x.ids[1] - y.ids[1]);
}

export function findPersonPairCandidates(
  persons: Array<{ id: number; name: string }>, context: Map<number, Set<number>>, artistNames: Map<number, string>,
): { withContext: PersonPairCandidate[]; withoutContext: PersonPairCandidate[] } {
  const parsed = persons.map((person) => ({ ...person, parsed: parsePersonName(person.name) }))
    .filter((person) => person.parsed.tokens.length >= 2 && !person.parsed.compound);
  // Dos bloques por persona: mismo apellido (apodos, iniciales, segundos
  // nombres) y mismo nombre de pila con igual número de palabras (erratas en
  // el apellido).
  const blocks = new Map<string, typeof parsed>();
  for (const person of parsed) {
    for (const key of [`last:${person.parsed.tokens.at(-1)}`, `first:${person.parsed.tokens[0]}:${person.parsed.tokens.length}`]) {
      blocks.set(key, [...(blocks.get(key) ?? []), person]);
    }
  }
  const seen = new Set<string>();
  const withContext: PersonPairCandidate[] = []; const withoutContext: PersonPairCandidate[] = [];
  for (const block of blocks.values()) {
    for (let i = 0; i < block.length; i += 1) {
      for (let j = i + 1; j < block.length; j += 1) {
        const [a, b] = block[i]!.id < block[j]!.id ? [block[i]!, block[j]!] : [block[j]!, block[i]!];
        const pairKey = `person:${a.id}-${b.id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const relation = personRelation(a.parsed, b.parsed);
        if (!relation) continue;
        const other = context.get(b.id) ?? new Set<number>();
        const shared = [...(context.get(a.id) ?? [])].filter((artist) => other.has(artist)).sort((x, y) => x - y);
        const candidate: PersonPairCandidate = { pairKey, ids: [a.id, b.id], names: [a.name, b.name], relation, sharedArtists: shared.map((id) => artistNames.get(id) ?? String(id)) };
        (shared.length ? withContext : withoutContext).push(candidate);
      }
    }
  }
  const order = (x: PersonPairCandidate, y: PersonPairCandidate): number => x.ids[0] - y.ids[0] || x.ids[1] - y.ids[1];
  return { withContext: withContext.sort(order), withoutContext: withoutContext.sort(order) };
}

/**
 * Various Artists es un marcador de recopilatorio, no una banda (decisión del
 * propietario, 2026-09-13): figurar en el mismo recopilatorio no acerca a dos
 * personas, así que no cuenta como contexto.
 */
export const NOT_A_BAND_SQL = "lower(ar.name) NOT IN ('various artists', 'varios artistas', 'v.a.', 'va')";

/** Bandas de cada persona: membresías y créditos de disco o de pista. */
export async function loadPersonContext(client: Pick<PoolClient, "query">): Promise<Map<number, Set<number>>> {
  const { rows } = await client.query<{ person_id: string; artist_id: string }>(`
    SELECT m.person_id::text, m.artist_id::text FROM public.artist_members m JOIN public.artists ar ON ar.id=m.artist_id WHERE ${NOT_A_BAND_SQL}
    UNION SELECT c.person_id::text, a.artist_id::text FROM public.album_credits c JOIN public.albums a ON a.id=c.album_id JOIN public.artists ar ON ar.id=a.artist_id
     WHERE c.person_id IS NOT NULL AND ${NOT_A_BAND_SQL}
    UNION SELECT c.person_id::text, a.artist_id::text FROM public.track_credits c JOIN public.tracks t ON t.id=c.track_id JOIN public.albums a ON a.id=t.album_id
      JOIN public.artists ar ON ar.id=a.artist_id WHERE c.person_id IS NOT NULL AND ${NOT_A_BAND_SQL}`);
  const context = new Map<number, Set<number>>();
  for (const row of rows) {
    const id = Number(row.person_id);
    context.set(id, (context.get(id) ?? new Set<number>()).add(Number(row.artist_id)));
  }
  return context;
}

export interface ScanResult {
  dryRun: boolean; runId?: number;
  albums: { candidates: number; enqueued: number; alreadyQueued: number };
  persons: { candidates: number; enqueued: number; alreadyQueued: number; withoutContext: number };
  reportFile?: string;
}

async function enqueue(client: PoolClient, pairKey: string, columns: Record<string, number>, payload: object, notes: string): Promise<boolean> {
  const names = Object.keys(columns);
  const values = Object.values(columns);
  const inserted = await client.query(`
    INSERT INTO ingest.review_queue(kind, priority, ${names.join(", ")}, payload, notes)
    SELECT 'possible_duplicate', 5, ${names.map((_, index) => `$${index + 1}`).join(", ")}, $${names.length + 1}::jsonb, $${names.length + 2}
     WHERE NOT EXISTS (SELECT 1 FROM ingest.review_queue WHERE kind='possible_duplicate' AND payload->>'pairKey'=$${names.length + 3})`,
  [...values, JSON.stringify(payload), notes.slice(0, 2000), pairKey]);
  return (inserted.rowCount ?? 0) > 0;
}

export async function scanAmbiguities(options: { dryRun?: boolean; reportDir?: string } = {}): Promise<ScanResult> {
  const dryRun = options.dryRun ?? false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES ('merge_run', 'running', $1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "ambiguity_scan", dryRun })]);
    const runId = Number(run.rows[0]!.id);

    const albums = (await client.query<{ id: string; artist_id: string; artist: string; title: string }>(`
      SELECT a.id::text, a.artist_id::text, ar.name AS artist, a.title FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id ORDER BY a.id`)).rows
      .map((row) => ({ id: Number(row.id), artistId: Number(row.artist_id), artistName: row.artist, title: row.title }));
    const tracks = new Map<number, AlbumTrack[]>();
    for (const row of (await client.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string }>(
      "SELECT id::text, album_id::text, disc_number, track_number, title FROM public.tracks ORDER BY album_id, disc_number, track_number")).rows) {
      const albumId = Number(row.album_id);
      tracks.set(albumId, [...(tracks.get(albumId) ?? []), { id: Number(row.id), disc: row.disc_number, number: row.track_number, title: row.title }]);
    }
    const albumPairs = findAlbumPairCandidates(albums, tracks);

    const persons = (await client.query<{ id: string; name: string }>("SELECT id::text, name FROM public.persons ORDER BY id")).rows.map((row) => ({ id: Number(row.id), name: row.name }));
    const artistNames = new Map((await client.query<{ id: string; name: string }>("SELECT id::text, name FROM public.artists")).rows.map((row) => [Number(row.id), row.name]));
    const personPairs = findPersonPairCandidates(persons, await loadPersonContext(client), artistNames);

    const result: ScanResult = {
      dryRun, ...(dryRun ? {} : { runId }),
      albums: { candidates: albumPairs.length, enqueued: 0, alreadyQueued: 0 },
      persons: { candidates: personPairs.withContext.length, enqueued: 0, alreadyQueued: 0, withoutContext: personPairs.withoutContext.length },
    };
    for (const pair of albumPairs) {
      const created = await enqueue(client, pair.pairKey, { album_id: pair.ids[0] },
        { via: SCAN_VIA, pairKey: pair.pairKey, entity: "album", ids: pair.ids, artist: pair.artist, titles: pair.titles, samePositions: pair.samePositions, commonPositions: pair.commonPositions },
        `Discos de ${pair.artist} con ${pair.samePositions} pistas iguales en la misma posición: «${pair.titles[0]}» (${pair.ids[0]}) / «${pair.titles[1]}» (${pair.ids[1]})`);
      if (created) result.albums.enqueued += 1; else result.albums.alreadyQueued += 1;
    }
    for (const pair of personPairs.withContext) {
      const created = await enqueue(client, pair.pairKey, { person_a_id: pair.ids[0], person_b_id: pair.ids[1] },
        { via: SCAN_VIA, pairKey: pair.pairKey, entity: "person", ids: pair.ids, names: pair.names, relation: pair.relation, sharedArtists: pair.sharedArtists },
        `Personas con grafías relacionadas (${pair.relation}) que comparten ${pair.sharedArtists.join(", ")}: «${pair.names[0]}» (${pair.ids[0]}) / «${pair.names[1]}» (${pair.ids[1]})`);
      if (created) result.persons.enqueued += 1; else result.persons.alreadyQueued += 1;
    }
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ albums: result.albums, persons: result.persons })]);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");

    if (!dryRun) {
      const dir = options.reportDir ?? "reports";
      await mkdir(dir, { recursive: true });
      const reportFile = path.join(dir, "ambiguity-scan.json");
      await writeFile(reportFile, `${JSON.stringify({
        runId, rules: { minSharedPositions: MIN_SHARED_POSITIONS, persons: "relación nominal reconocible y al menos una banda en común" },
        summary: { albums: result.albums, persons: result.persons },
        albumPairs, personPairs: personPairs.withContext,
        notQueued: { reason: "nombres relacionados sin ninguna banda en común: el parecido del nombre no es evidencia de identidad", personPairs: personPairs.withoutContext },
      }, null, 2)}\n`);
      result.reportFile = reportFile;
    }
    log.info({ albums: result.albums, persons: result.persons, dryRun }, "barrido de ambigüedades");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
