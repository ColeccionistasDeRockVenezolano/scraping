// CRV · Congela la parte RELACIONAL del catálogo para medir precisión sin base
// de datos (PLAN_CURADURIA E11.4).
//
//   npm run curation:relations
//
// Por qué un archivo aparte y no una foto nueva: `catalog-2026-09-16.json.gz`
// es la vara con la que están etiquetados todos los detectores anteriores, y
// reemplazarla movería las etiquetas de E2. Esta foto complementaria añade las
// cinco tablas que le faltaban —créditos, membresías, aliases, redirecciones y
// enlaces de medios— sin tocar las fichas. Se toma en REPEATABLE READ y solo
// debe reejecutarse cuando haga falta reetiquetar los detectores relacionales.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Pool } from "pg";
import { getEnv } from "../src/config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../test/fixtures/curation/relations-2026-09-20.json.gz");

async function main(): Promise<void> {
  const env = getEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const credits = await client.query(`
      SELECT id::text, 'album' AS parent_kind, album_id::text AS parent_id,
             person_id::text, artist_id::text, organization_id::text, credit_type::text, role
        FROM public.album_credits
      UNION ALL
      SELECT id::text, 'track', track_id::text, person_id::text, artist_id::text,
             organization_id::text, credit_type::text, role
        FROM public.track_credits
       ORDER BY parent_kind, parent_id, id`);
    const memberships = await client.query(`
      SELECT id::text, artist_id::text, person_id::text, role, from_year, to_year, is_current
        FROM public.artist_members ORDER BY id`);
    const aliases = await client.query(`
      SELECT id::text, 'artist' AS kind, artist_id::text AS entity_id, alias, normalized_alias FROM ingest.artist_aliases
      UNION ALL SELECT id::text, 'person', person_id::text, alias, normalized_alias FROM ingest.person_aliases
      UNION ALL SELECT id::text, 'organization', organization_id::text, alias, normalized_alias FROM ingest.organization_aliases
      UNION ALL SELECT id::text, 'album', album_id::text, alias, normalized_alias FROM ingest.album_aliases
      UNION ALL SELECT id::text, 'track', track_id::text, alias, normalized_alias FROM ingest.track_aliases
      ORDER BY kind, entity_id, id`);
    const redirects = await client.query(
      "SELECT entity_kind::text AS kind, from_id::text, to_id::text FROM ingest.entity_redirects ORDER BY entity_kind, from_id");
    const mediaLinks = await client.query(`
      SELECT id::text, entity_kind, artist_id::text, person_id::text, organization_id::text,
             album_id::text, url, media_type
        FROM media.media_links ORDER BY id`);
    const labels = await client.query(
      "SELECT id::text, label_id::text FROM public.albums WHERE label_id IS NOT NULL ORDER BY id");
    await client.query("COMMIT");

    const n = (value: string | null): number | null => (value === null ? null : Number(value));
    const fixture = {
      format: "crv-curation-relations.v1",
      takenAt: new Date().toISOString(),
      catalog: "catalog-2026-09-16.json.gz",
      credits: credits.rows.map((r) => [
        Number(r.id), r.parent_kind, Number(r.parent_id), n(r.person_id), n(r.artist_id),
        n(r.organization_id), r.credit_type, r.role,
      ]),
      memberships: memberships.rows.map((r) => [
        Number(r.id), Number(r.artist_id), Number(r.person_id), r.role, r.from_year, r.to_year, r.is_current,
      ]),
      aliases: aliases.rows.map((r) => [Number(r.id), r.kind, Number(r.entity_id), r.alias, r.normalized_alias]),
      redirects: redirects.rows.map((r) => [r.kind, Number(r.from_id), Number(r.to_id)]),
      mediaLinks: mediaLinks.rows.map((r) => [
        Number(r.id), r.entity_kind, n(r.artist_id), n(r.person_id), n(r.organization_id), n(r.album_id), r.url, r.media_type,
      ]),
      albumLabels: labels.rows.map((r) => [Number(r.id), Number(r.label_id)]),
    };
    await writeFile(OUT, gzipSync(Buffer.from(JSON.stringify(fixture), "utf8"), { level: 9 }));
    process.stdout.write(
      `Foto relacional guardada en ${OUT}\n`
      + `  créditos ${fixture.credits.length} · membresías ${fixture.memberships.length}`
      + ` · aliases ${fixture.aliases.length} · redirecciones ${fixture.redirects.length}`
      + ` · enlaces ${fixture.mediaLinks.length} · sellos de disco ${fixture.albumLabels.length}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
