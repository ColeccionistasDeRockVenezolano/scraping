// CRV · Evidencia por par para las revisiones `person_duplicate` abiertas (la
// Mesa, E11.5). NO DECIDE: junta, para cada persona del par, sus bandas, discos
// (créditos de disco y de pista), organizaciones, alias, fuentes, fechas y
// nacionalidad, y marca lo que comparten y lo que choca. Quien revisa (Jose o
// Brian) fusiona o separa en la Mesa. Solo lectura.
//
// Uso: tsx scripts/export-person-duplicate-evidence.ts
//   → reports/person-duplicates-evidence-<fecha>.{json,md}
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const DATE = new Date().toISOString().slice(0, 10);

interface Facts {
  id: number; name: string; exists: boolean; venezuelan: boolean | null; nationality: string | null;
  birth: string | null; death: string | null; hasBio: boolean; aliases: string[]; sources: string[];
  bands: Map<number, string>; bandRoles: string[]; albums: Map<number, string>; albumArtists: Map<number, string>;
  orgs: Map<number, string>; albumCredits: number; trackCredits: number; mates: Map<number, string>;
}

const VARIOUS = /^(various artists|varios artistas|varios|v\.?a\.?)$/iu;

interface Described {
  id: number; name: string; venezuelan: boolean | null; nationality: string | null; birth: string | null; death: string | null;
  hasBio: boolean; aliases: string[]; sources: string[]; bands: string[]; albumCredits: number; trackCredits: number;
  albums: string[]; albumCount: number; organizations: string[];
}

async function main(): Promise<void> {
  const pool = getPool();
  const pairs = (await pool.query<{ id: string; a: string | null; b: string | null; payload: { score?: number; features?: Array<{ key: string; evidence: string }> } | null }>(`
    SELECT id::text, person_a_id::text AS a, person_b_id::text AS b, payload
      FROM ingest.review_queue WHERE kind='person_duplicate' AND status IN ('open','in_progress') ORDER BY id`)).rows;
  const ids = [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]).filter((id): id is string => id !== null).map(Number))];
  const facts = new Map<number, Facts>();
  const base = await pool.query<{ id: string; name: string; is_venezuelan: boolean | null; nationality: string | null; birth: string | null; death: string | null; has_bio: boolean }>(`
    SELECT id::text, name, is_venezuelan, nationality, birth_date::text AS birth, death_date::text AS death,
           coalesce(btrim(biography),'') <> '' AS has_bio
      FROM public.persons WHERE id = ANY($1::bigint[])`, [ids]);
  for (const row of base.rows) {
    facts.set(Number(row.id), { id: Number(row.id), name: row.name, exists: true, venezuelan: row.is_venezuelan, nationality: row.nationality,
      birth: row.birth, death: row.death, hasBio: row.has_bio, aliases: [], sources: [], bands: new Map(), bandRoles: [],
      albums: new Map(), albumArtists: new Map(), orgs: new Map(), albumCredits: 0, trackCredits: 0, mates: new Map() });
  }
  const get = (id: string) => facts.get(Number(id));
  for (const row of (await pool.query<{ person_id: string; alias: string }>(
    `SELECT person_id::text, alias FROM ingest.person_aliases WHERE person_id = ANY($1::bigint[]) ORDER BY is_primary DESC, alias`, [ids])).rows) {
    get(row.person_id)?.aliases.push(row.alias);
  }
  for (const row of (await pool.query<{ person_id: string; slug: string }>(`
    SELECT DISTINCT c.person_id::text, s.slug FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
     WHERE c.person_id = ANY($1::bigint[]) AND c.status IN ('accepted','superseded') ORDER BY 2`, [ids])).rows) {
    get(row.person_id)?.sources.push(row.slug);
  }
  for (const row of (await pool.query<{ person_id: string; artist_id: string; artist: string; role: string; from_year: number | null; to_year: number | null }>(`
    SELECT m.person_id::text, m.artist_id::text, a.name AS artist, m.role, m.from_year, m.to_year
      FROM public.artist_members m JOIN public.artists a ON a.id = m.artist_id WHERE m.person_id = ANY($1::bigint[])`, [ids])).rows) {
    const person = get(row.person_id);
    if (!person) continue;
    person.bands.set(Number(row.artist_id), row.artist);
    person.bandRoles.push(`${row.artist} (${row.role}${row.from_year || row.to_year ? `, ${row.from_year ?? "?"}–${row.to_year ?? ""}` : ""})`);
  }
  for (const row of (await pool.query<{ person_id: string; album_id: string; title: string; artist_id: string; artist: string; kind: string; n: number }>(`
    SELECT x.person_id::text, al.id::text AS album_id, al.title, ar.id::text AS artist_id, ar.name AS artist, x.kind, count(*)::int AS n
      FROM (SELECT person_id, album_id, 'disco' AS kind FROM public.album_credits WHERE person_id = ANY($1::bigint[])
            UNION ALL
            SELECT tc.person_id, t.album_id, 'pista' FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id
             WHERE tc.person_id = ANY($1::bigint[])) x
      JOIN public.albums al ON al.id = x.album_id JOIN public.artists ar ON ar.id = al.artist_id
     GROUP BY 1,2,3,4,5,6`, [ids])).rows) {
    const person = get(row.person_id);
    if (!person) continue;
    person.albums.set(Number(row.album_id), `${row.artist} — ${row.title}`);
    if (!VARIOUS.test(row.artist.trim())) person.albumArtists.set(Number(row.artist_id), row.artist);
    if (row.kind === "disco") person.albumCredits += row.n; else person.trackCredits += row.n;
  }
  for (const row of (await pool.query<{ person_id: string; organization_id: string; name: string }>(`
    SELECT po.person_id::text, o.id::text AS organization_id, o.name FROM public.person_organizations po
      JOIN public.organizations o ON o.id = po.organization_id WHERE po.person_id = ANY($1::bigint[])`, [ids])).rows) {
    get(row.person_id)?.orgs.set(Number(row.organization_id), row.name);
  }

  // Compañeros: quien comparte banda o disco con cada persona del par. Dos
  // fichas con los mismos compañeros en bandas distintas suelen ser la misma.
  for (const row of (await pool.query<{ person_id: string; mate_id: string; mate: string }>(`
    WITH mine AS (
      SELECT person_id, 'b' || artist_id AS ctx FROM public.artist_members WHERE person_id = ANY($1::bigint[])
      UNION SELECT person_id, 'a' || album_id FROM public.album_credits WHERE person_id = ANY($1::bigint[])
      UNION SELECT tc.person_id, 'a' || t.album_id FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id
             WHERE tc.person_id = ANY($1::bigint[])),
    everyone AS (
      SELECT person_id, 'b' || artist_id AS ctx FROM public.artist_members
      UNION SELECT person_id, 'a' || album_id FROM public.album_credits WHERE person_id IS NOT NULL
      UNION SELECT tc.person_id, 'a' || t.album_id FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id
             WHERE tc.person_id IS NOT NULL)
    SELECT DISTINCT m.person_id::text, e.person_id::text AS mate_id, p.name AS mate
      FROM mine m JOIN everyone e ON e.ctx = m.ctx AND e.person_id <> m.person_id
      JOIN public.persons p ON p.id = e.person_id
     WHERE m.ctx NOT IN (SELECT 'a' || al.id FROM public.albums al JOIN public.artists ar ON ar.id = al.artist_id
                          WHERE ar.name ~* '^(various artists|varios artistas|varios|v\\.?a\\.?)$')`, [ids])).rows) {
    get(row.person_id)?.mates.set(Number(row.mate_id), row.mate);
  }

  const shared = <T>(left: Map<number, T>, right: Map<number, T>) => [...left].filter(([id]) => right.has(id)).map(([, value]) => value);
  const out = pairs.map((pair) => {
    const a = pair.a ? facts.get(Number(pair.a)) : undefined;
    const b = pair.b ? facts.get(Number(pair.b)) : undefined;
    if (!a || !b) return { reviewId: Number(pair.id), missing: true, a: pair.a, b: pair.b, links: [] as string[], clashes: [] as string[], score: pair.payload?.score ?? null };
    const links: string[] = [];
    const clashes: string[] = [];
    const bands = shared(a.bands, b.bands);
    if (bands.length) links.push(`misma banda: ${bands.join(", ")}`);
    const albums = shared(a.albums, b.albums);
    if (albums.length) links.push(`acreditados en el mismo disco: ${albums.slice(0, 6).join("; ")}${albums.length > 6 ? ` (+${albums.length - 6})` : ""}`);
    const orgs = shared(a.orgs, b.orgs);
    if (orgs.length) links.push(`misma organización: ${orgs.join(", ")}`);
    const crossAB = [...a.bands].filter(([id]) => b.albumArtists.has(id) && !b.bands.has(id)).map(([, name]) => name);
    const crossBA = [...b.bands].filter(([id]) => a.albumArtists.has(id) && !a.bands.has(id)).map(([, name]) => name);
    if (crossAB.length) links.push(`A integra ${crossAB.join(", ")} y B tiene créditos en sus discos`);
    if (crossBA.length) links.push(`B integra ${crossBA.join(", ")} y A tiene créditos en sus discos`);
    const artists = shared(a.albumArtists, b.albumArtists).filter((name) => !bands.includes(name));
    if (artists.length && !albums.length) links.push(`créditos en discos del mismo artista: ${artists.slice(0, 5).join(", ")}`);
    const mates = [...a.mates].filter(([id]) => b.mates.has(id) && id !== a.id && id !== b.id).map(([, name]) => name);
    if (mates.length) links.push(`compañeros en común: ${mates.slice(0, 6).join(", ")}${mates.length > 6 ? ` (+${mates.length - 6})` : ""}`);
    if (a.birth && b.birth && a.birth !== b.birth) clashes.push(`nacimiento distinto: ${a.birth} / ${b.birth}`);
    if (a.death && b.death && a.death !== b.death) clashes.push(`muerte distinta: ${a.death} / ${b.death}`);
    if (a.venezuelan !== null && b.venezuelan !== null && a.venezuelan !== b.venezuelan) clashes.push(`venezolano: ${a.venezuelan ? "sí" : "no"} / ${b.venezuelan ? "sí" : "no"}`);
    if (a.nationality && b.nationality && a.nationality.toLowerCase() !== b.nationality.toLowerCase()) clashes.push(`nacionalidad: ${a.nationality} / ${b.nationality}`);
    if (bands.length === 0 && a.bands.size && b.bands.size && !crossAB.length && !crossBA.length && !albums.length) {
      clashes.push("ambos tienen bandas y ninguna coincide");
    }
    const describe = (person: Facts): Described => ({
      id: person.id, name: person.name, venezuelan: person.venezuelan, nationality: person.nationality, birth: person.birth, death: person.death,
      hasBio: person.hasBio, aliases: person.aliases, sources: person.sources, bands: person.bandRoles,
      albumCredits: person.albumCredits, trackCredits: person.trackCredits, albums: [...person.albums.values()].slice(0, 12),
      albumCount: person.albums.size, organizations: [...person.orgs.values()],
    });
    return { reviewId: Number(pair.id), score: pair.payload?.score ?? null,
      detector: (pair.payload?.features ?? []).map((feature) => `${feature.key}: ${feature.evidence}`),
      links, clashes, a: describe(a), b: describe(b) };
  });

  writeFileSync(`reports/person-duplicates-evidence-${DATE}.json`, JSON.stringify(out, null, 2));
  const groups: Array<[string, typeof out]> = [
    ["Con vínculo común y sin choques", out.filter((item) => item.links.length && !item.clashes.length)],
    ["Con vínculo común y algún choque", out.filter((item) => item.links.length && item.clashes.length)],
    ["Sin vínculo común y sin choques (solo el nombre)", out.filter((item) => !item.links.length && !item.clashes.length && !("missing" in item))],
    ["Sin vínculo común y con choques", out.filter((item) => !item.links.length && item.clashes.length)],
    ["Par incompleto (una ficha ya no existe)", out.filter((item) => "missing" in item)],
  ];
  const lines = [
    `# Posibles duplicados de persona: evidencia por par (${DATE})`, "",
    `${out.length} revisiones \`person_duplicate\` abiertas. Este informe **no decide nada**: ordena los pares por lo que comparten`,
    "y lo que choca para que la revisión en la Mesa sea rápida. «Vínculo» = misma banda, mismo disco, misma organización o",
    "una integra la banda en cuyos discos la otra tiene créditos. «Choque» = fechas, nacionalidad o bandas que no coinciden.", "",
    ...groups.map(([title, list]) => `- ${title}: ${list.length}`), "",
  ];
  const side = (label: string, p: Described) => [
      `  - **${label} · p${p.id} «${p.name}»**${p.venezuelan === true ? " · VE" : p.venezuelan === false ? " · no VE" : ""}${p.nationality ? ` · ${p.nationality}` : ""}${p.birth ? ` · n. ${p.birth}` : ""}${p.hasBio ? " · con biografía" : ""}`,
      `    - bandas: ${p.bands.length ? p.bands.join("; ") : "—"}`,
      `    - créditos: ${p.albumCredits} de disco, ${p.trackCredits} de pista en ${p.albumCount} discos${p.albums.length ? `: ${p.albums.slice(0, 6).join("; ")}${p.albumCount > 6 ? " …" : ""}` : ""}`,
      ...(p.organizations.length ? [`    - organizaciones: ${p.organizations.join(", ")}`] : []),
      ...(p.aliases.length ? [`    - alias: ${p.aliases.slice(0, 8).join(" · ")}`] : []),
      `    - fuentes: ${p.sources.join(", ") || "—"}`,
  ].join("\n");
  for (const [title, list] of groups) {
    if (!list.length) continue;
    lines.push(`## ${title} (${list.length})`, "");
    for (const item of list) {
      if ("missing" in item) { lines.push(`### revisión ${item.reviewId}: p${item.a ?? "—"} / p${item.b ?? "—"} (falta una ficha)`, ""); continue; }
      lines.push(`### revisión ${item.reviewId}: «${item.a.name}» / «${item.b.name}» (score ${item.score ?? "?"})`);
      if (item.links.length) lines.push(`- Vínculos: ${item.links.join(" · ")}`);
      if (item.clashes.length) lines.push(`- Choques: ${item.clashes.join(" · ")}`);
      lines.push(side("A", item.a), side("B", item.b), "");
    }
  }
  writeFileSync(`reports/person-duplicates-evidence-${DATE}.md`, lines.join("\n"));
  console.log(lines.slice(0, 12).join("\n"));
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
