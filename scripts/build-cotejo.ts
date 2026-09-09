// CRV · Genera public/cotejo.html a partir de la plantilla y de la base.
//
// La página es un archivo único y navegable, así que los careos y las
// contradicciones van EMBEBIDOS: se ven en cuanto abre, sin esperar a la red.
// Lo que cambia solo (conteos, decisiones del equipo) lo pide al servicio.
// Regenerar es barato; hazlo cuando la cola haya cambiado de verdad.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "../src/db/client.js";

const TEMPLATE = path.resolve("src/cotejo/page.template.html");
const OUT = path.resolve("public/cotejo.html");

const MATCHES_SQL = `
  SELECT r.id, r.kind::text AS kind, d.entity_kind AS "entityKind",
         d.input_name_original AS name, round(d.score::numeric,3)::float8 AS score,
         d.action, r.payload->>'explanation' AS explanation,
         d.input_context AS context, d.features,
         (SELECT json_agg(json_build_object('id',(c->>'candidateId')::bigint,
            'score', round((c->>'score')::numeric,3)::float8, 'action', c->>'action',
            'features', c->'features',
            'name', CASE d.entity_kind
              WHEN 'ALBUM' THEN (SELECT a.title||' · '||ar.name||coalesce(' ('||a.release_year||')','')
                                   FROM albums a JOIN artists ar ON ar.id=a.artist_id WHERE a.id=(c->>'candidateId')::bigint)
              WHEN 'PERSON' THEN (SELECT p.name FROM persons p WHERE p.id=(c->>'candidateId')::bigint)
              WHEN 'ORGANIZATION' THEN (SELECT o.name FROM organizations o WHERE o.id=(c->>'candidateId')::bigint)
              WHEN 'TRACK' THEN (SELECT t.title FROM tracks t WHERE t.id=(c->>'candidateId')::bigint)
              WHEN 'ARTIST' THEN (SELECT ar.name FROM artists ar WHERE ar.id=(c->>'candidateId')::bigint) END)
            ORDER BY (c->>'score')::numeric DESC)
          FROM jsonb_array_elements(d.candidates) c WHERE (c->>'score')::numeric > 0.15) AS candidates
    FROM ingest.review_queue r
    JOIN ingest.entity_resolution_decisions d ON d.id = (r.payload->>'resolutionDecisionId')::bigint
   WHERE r.status='open' AND r.kind IN ('album_match','person_match','organization_match')
   ORDER BY d.score DESC`;

const CONFLICTS_SQL = `
  SELECT r.id, r.payload->>'entityKind' AS entity_kind, r.payload->>'field' AS field,
         r.payload->>'canonicalValue' AS canonical, r.payload->>'proposedValue' AS proposed,
         (r.payload->>'targetId')::bigint AS target_id,
         CASE r.payload->>'entityKind'
           WHEN 'organization' THEN (SELECT o.name FROM organizations o WHERE o.id=(r.payload->>'targetId')::bigint)
           WHEN 'track' THEN (SELECT t.title||' — '||a.title FROM tracks t JOIN albums a ON a.id=t.album_id
                               WHERE t.id=(r.payload->>'targetId')::bigint)
           WHEN 'album' THEN (SELECT a.title FROM albums a WHERE a.id=(r.payload->>'targetId')::bigint)
           WHEN 'artist' THEN (SELECT ar.name FROM artists ar WHERE ar.id=(r.payload->>'targetId')::bigint)
           WHEN 'person' THEN (SELECT p.name FROM persons p WHERE p.id=(r.payload->>'targetId')::bigint)
         END AS target_name
    FROM ingest.review_queue r
   WHERE r.kind='field_conflict' AND r.status='open' ORDER BY r.id`;

async function main(): Promise<void> {
  const pool = getPool();
  const [matches, conflicts, template] = await Promise.all([
    pool.query(MATCHES_SQL), pool.query(CONFLICTS_SQL), readFile(TEMPLATE, "utf8"),
  ]);
  const slim = matches.rows.map((row) => ({
    ...row, candidates: ((row["candidates"] as unknown[]) ?? []).slice(0, 3),
  }));
  const blob = JSON.stringify({ matches: slim, conflicts: conflicts.rows });
  // Un "</script" dentro del JSON cerraría la etiqueta y rompería la página.
  if (blob.includes("</script")) throw new Error("los datos contienen </script; hay que escaparlos antes de embeber");
  await writeFile(OUT, template.replace("__DATA__", blob), "utf8");
  // eslint-disable-next-line no-console
  console.log(`cotejo: ${slim.length} careos y ${conflicts.rowCount} contradicciones -> ${OUT}`);
  await pool.end();
}
void main();
