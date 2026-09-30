// Descubre imágenes de Commons para fichas sin imagen mediante Wikidata.
// Solo emite candidatos cuando el rótulo coincide exactamente, la ficha CRV
// no duplica ese rótulo y Wikidata sitúa la entidad en Venezuela. El script
// no toca el catálogo: localize-images.ts descarga y asocia los candidatos.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, arg("--out") ?? "reports/media-wikidata-candidates-2026-09-27.jsonl");
const ENDPOINT = "https://query.wikidata.org/sparql";
const VENEZUELA = "wd:Q717";

type Kind = "artist" | "person" | "organization" | "album";
interface Entity { kind: Kind; id: number; name: string; artistName?: string; }
interface Candidate { kind: Kind; id: number; sourceUrl: string; qid: string; label: string; source: "wikidata-commons"; }

function quoted(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"").replace(/\n/gu, " ")}"`;
}
function languageValues(values: string[]): string {
  return values.flatMap((value) => [`${quoted(value)}@es`, `${quoted(value)}@en`]).join(" ");
}
function batches<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function positive(name: string, fallback: number): number {
  const value = arg(name); if (value === undefined) return fallback;
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} debe ser entero positivo`);
  return parsed;
}
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function sparql(query: string): Promise<Array<{ name: string; item: string; image: string; artistName?: string }>> {
  const response = await fetch(`${ENDPOINT}?${new URLSearchParams({ format: "json", query })}`, {
    headers: { accept: "application/sparql-results+json", "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  const payload = await response.json() as { results?: { bindings?: Array<Record<string, { value?: string }>> } };
  return (payload.results?.bindings ?? []).flatMap((row) => {
    const name = row["name"]?.value; const item = row["item"]?.value; const image = row["image"]?.value;
    if (!name || !item || !image || !/^https?:\/\//u.test(image)) return [];
    return [{ name, item, image, ...(row["artistName"]?.value ? { artistName: row["artistName"].value } : {}) }];
  });
}

function queryFor(kind: Exclude<Kind, "album">, names: string[]): string {
  const nationality = kind === "artist"
    ? `{ ?item wdt:P27 ${VENEZUELA} } UNION { ?item wdt:P495 ${VENEZUELA} } UNION { ?item wdt:P17 ${VENEZUELA} }`
    : kind === "organization"
      ? `{ ?item wdt:P17 ${VENEZUELA} } UNION { ?item wdt:P159/wdt:P17 ${VENEZUELA} }`
      : `{ ?item wdt:P27 ${VENEZUELA} }`;
  // La coincidencia literal y el país no bastan: "Maracaibo" y muchos
  // nombres de pila también tienen artículos en Wikidata. La clase u
  // ocupación musical elimina esos homónimos antes de que exista un candidato.
  const domain = kind === "artist"
    ? `{ ?item wdt:P31/wdt:P279* wd:Q2088357 } UNION { ?item wdt:P106/wdt:P279* wd:Q639669 }`
    : kind === "person"
      ? `?item wdt:P106/wdt:P279* wd:Q639669.`
      : `?item wdt:P31/wdt:P279* wd:Q43229.`;
  return `SELECT DISTINCT ?name ?item ?image WHERE {
    VALUES ?name { ${languageValues(names)} }
    ?item rdfs:label ?name; wdt:P18 ?image.
    ${nationality}
    ${domain}
  }`;
}
function albumQuery(entities: Entity[]): string {
  const values = entities.flatMap((entity) => {
    const artist = entity.artistName!;
    return [`(${quoted(entity.name)}@es ${quoted(artist)}@es)`, `(${quoted(entity.name)}@en ${quoted(artist)}@en)`];
  }).join(" ");
  return `SELECT DISTINCT ?name ?artistName ?item ?image WHERE {
    VALUES (?name ?artistName) { ${values} }
    ?item rdfs:label ?name; wdt:P18 ?image; wdt:P175 ?artist.
    ?artist rdfs:label ?artistName.
  }`;
}

async function missing(pool: pg.Pool, kind: Kind, limit: number | undefined): Promise<Entity[]> {
  const query: Record<Kind, string> = {
    artist: `SELECT id::text,name FROM public.artists WHERE picture_url IS NULL ORDER BY id`,
    person: `SELECT id::text,name FROM public.persons WHERE picture_url IS NULL ORDER BY id`,
    organization: `SELECT id::text,name FROM public.organizations WHERE picture_url IS NULL ORDER BY id`,
    album: `SELECT al.id::text,al.title AS name,ar.name AS artist_name FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id WHERE al.cover_url IS NULL ORDER BY al.id`,
  };
  const { rows } = await pool.query<{ id: string; name: string; artist_name?: string }>(query[kind]);
  const unique = new Map<string, { id: string; name: string; artist_name?: string }>();
  for (const row of rows) {
    const key = kind === "album" ? `${row.name}\u0000${row.artist_name ?? ""}` : row.name;
    if (unique.has(key)) unique.set(key, { id: "", name: row.name }); // marca ambigüedad dentro de CRV
    else unique.set(key, row);
  }
  const entities = [...unique.values()].flatMap((row) => row.id ? [{ kind, id: Number(row.id), name: row.name, ...(row.artist_name ? { artistName: row.artist_name } : {}) }] : []);
  return limit === undefined ? entities : entities.slice(0, limit);
}

async function main(): Promise<void> {
  const batchSize = positive("--batch-size", 40);
  const limitRaw = arg("--limit");
  const limit = limitRaw === undefined ? undefined : positive("--limit", 1);
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const candidates: Candidate[] = [];
    for (const kind of ["artist", "person", "organization", "album"] as const) {
      const entities = await missing(pool, kind, limit);
      let found = 0;
      for (const group of batches(entities, batchSize)) {
        const result = await sparql(kind === "album" ? albumQuery(group) : queryFor(kind, group.map((entity) => entity.name)));
        const byIdentity = new Map<string, typeof result>();
        for (const row of result) {
          const key = kind === "album" ? `${row.name}\u0000${row.artistName ?? ""}` : row.name;
          byIdentity.set(key, [...(byIdentity.get(key) ?? []), row]);
        }
        for (const entity of group) {
          const key = kind === "album" ? `${entity.name}\u0000${entity.artistName!}` : entity.name;
          const matches = [...new Map((byIdentity.get(key) ?? []).map((row) => [row.item, row])).values()];
          if (matches.length !== 1) continue;
          const match = matches[0]!;
          const qid = match.item.match(/\/Q(\d+)$/u)?.[1];
          if (!qid) continue;
          candidates.push({ kind, id: entity.id, sourceUrl: match.image, qid: `Q${qid}`, label: entity.name, source: "wikidata-commons" });
          found += 1;
        }
        process.stdout.write(`${kind}: ${Math.min(group.at(-1)?.id ?? 0, Number.MAX_SAFE_INTEGER)} · candidatos ${found}\n`);
        await pause(750);
      }
      process.stdout.write(`${kind}: ${entities.length} fichas únicas sin imagen; ${found} candidatas\n`);
    }
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""));
    process.stdout.write(`${JSON.stringify({ candidates: candidates.length, out: path.relative(ROOT, OUT) })}\n`);
  } finally { await pool.end(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
