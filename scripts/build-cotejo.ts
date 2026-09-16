// CRV · Genera public/cotejo.html a partir de la plantilla y de la base.
//
// La página es un archivo único y navegable, así que los careos y las
// contradicciones van EMBEBIDOS: se ven en cuanto abre, sin esperar a la red.
// Lo que cambia solo (conteos, decisiones del equipo) lo pide al servicio.
// Regenerar es barato; hazlo cuando la cola haya cambiado de verdad.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getPool } from "../src/db/client.js";

const TEMPLATE = path.resolve("src/cotejo/page.template.html");
const OUT = path.resolve("public/cotejo.html");

const MATCHES_SQL = `
  SELECT r.id, r.kind::text AS kind, d.entity_kind AS "entityKind",
         d.input_name_original AS name, round(d.score::numeric,3)::float8 AS score,
         d.action, r.payload->>'explanation' AS explanation,
         d.input_context AS context, d.features, s.slug AS source,
         cl.identity_key AS "identityKey", cl.field AS "claimField",
         cl.confidence::text AS confidence, ev.url AS "evidenceUrl",
         ev.excerpt AS "evidenceExcerpt", ev.selector AS "evidenceSelector",
         cl.created_at AS "observedAt",
         (SELECT json_agg(json_build_object('id',(c->>'candidateId')::bigint,
            'score', round((c->>'score')::numeric,3)::float8, 'action', c->>'action',
            'features', c->'features',
            'canonicalName', CASE d.entity_kind
              WHEN 'ALBUM' THEN (SELECT a.title FROM albums a WHERE a.id=(c->>'candidateId')::bigint)
              WHEN 'PERSON' THEN (SELECT p.name FROM persons p WHERE p.id=(c->>'candidateId')::bigint)
              WHEN 'ORGANIZATION' THEN (SELECT o.name FROM organizations o WHERE o.id=(c->>'candidateId')::bigint)
              WHEN 'TRACK' THEN (SELECT t.title FROM tracks t WHERE t.id=(c->>'candidateId')::bigint)
              WHEN 'ARTIST' THEN (SELECT ar.name FROM artists ar WHERE ar.id=(c->>'candidateId')::bigint) END,
            'name', CASE d.entity_kind
              WHEN 'ALBUM' THEN (SELECT a.title||' · '||ar.name||coalesce(' ('||a.release_year||')','')
                                   FROM albums a JOIN artists ar ON ar.id=a.artist_id WHERE a.id=(c->>'candidateId')::bigint)
              WHEN 'PERSON' THEN (SELECT p.name FROM persons p WHERE p.id=(c->>'candidateId')::bigint)
              WHEN 'ORGANIZATION' THEN (SELECT o.name FROM organizations o WHERE o.id=(c->>'candidateId')::bigint)
              WHEN 'TRACK' THEN (SELECT t.title FROM tracks t WHERE t.id=(c->>'candidateId')::bigint)
              WHEN 'ARTIST' THEN (SELECT ar.name FROM artists ar WHERE ar.id=(c->>'candidateId')::bigint) END,
            'context', CASE d.entity_kind
              WHEN 'ALBUM' THEN (SELECT json_build_object('artist',ar.name,'year',a.release_year,'type',a.album_type,'genre',a.genre)
                                   FROM albums a JOIN artists ar ON ar.id=a.artist_id WHERE a.id=(c->>'candidateId')::bigint)
              WHEN 'PERSON' THEN (SELECT json_build_object('nationality',p.nationality,'venezuelan',p.is_venezuelan,'birthDate',p.birth_date)
                                    FROM persons p WHERE p.id=(c->>'candidateId')::bigint)
              WHEN 'ORGANIZATION' THEN (SELECT json_build_object('type',o.organization_type,'country',o.country,'website',o.website_url)
                                          FROM organizations o WHERE o.id=(c->>'candidateId')::bigint)
              WHEN 'TRACK' THEN (SELECT json_build_object('album',a.title,'artist',ar.name,'disc',t.disc_number,'track',t.track_number)
                                   FROM tracks t JOIN albums a ON a.id=t.album_id JOIN artists ar ON ar.id=a.artist_id
                                  WHERE t.id=(c->>'candidateId')::bigint)
              WHEN 'ARTIST' THEN (SELECT json_build_object('type',ar.artist_type,'city',ar.origin_city,'country',ar.origin_country,'formedYear',ar.formed_year)
                                    FROM artists ar WHERE ar.id=(c->>'candidateId')::bigint) END,
            'canonicalEvidence', (
              SELECT json_agg(json_build_object(
                'source', ce.source, 'url', ce.url, 'excerpt', ce.excerpt, 'field', ce.field
              ) ORDER BY ce.priority, ce.claim_id DESC)
              FROM (
                SELECT DISTINCT ON (e2.url)
                       s2.slug AS source, e2.url, e2.excerpt, cl2.field, cl2.id AS claim_id,
                       CASE WHEN cl2.field IN ('name','title') THEN 0 ELSE 1 END AS priority
                  FROM ingest.claims cl2
                  JOIN ingest.sources s2 ON s2.id=cl2.source_id
                 JOIN ingest.claim_evidence e2 ON e2.claim_id=cl2.id
                 WHERE cl2.status='accepted' AND e2.url IS NOT NULL AND btrim(e2.url)<>''
                   -- La columna izquierda ya muestra ev como fuente nueva. Si
                   -- la ficha canónica nació de otra afirmación de esa misma
                   -- página, repetirla aquí no es evidencia independiente.
                   AND e2.url IS DISTINCT FROM ev.url
                   AND ((d.entity_kind='ALBUM' AND cl2.album_id=(c->>'candidateId')::bigint)
                     OR (d.entity_kind='PERSON' AND cl2.person_id=(c->>'candidateId')::bigint)
                     OR (d.entity_kind='ORGANIZATION' AND cl2.organization_id=(c->>'candidateId')::bigint)
                     OR (d.entity_kind='TRACK' AND cl2.track_id=(c->>'candidateId')::bigint)
                     OR (d.entity_kind='ARTIST' AND cl2.artist_id=(c->>'candidateId')::bigint))
                 ORDER BY e2.url, priority, cl2.id DESC
                 LIMIT 3
              ) ce
            ))
            ORDER BY (c->>'score')::numeric DESC)
          FROM (
            SELECT candidate AS c FROM jsonb_array_elements(d.candidates) candidate
             ORDER BY (candidate->>'score')::numeric DESC LIMIT 1
          ) top_candidate) AS candidates
    FROM ingest.review_queue r
    JOIN ingest.entity_resolution_decisions d ON d.id = (r.payload->>'resolutionDecisionId')::bigint
    JOIN ingest.claims cl ON cl.id=d.claim_id
    JOIN ingest.sources s ON s.id=cl.source_id
    LEFT JOIN LATERAL (
      SELECT e.url,e.excerpt,e.selector FROM ingest.claim_evidence e
       WHERE e.claim_id=cl.id ORDER BY e.id LIMIT 1
    ) ev ON true
   -- Una revisión puede haber quedado abierta después de que una aprobación
   -- por entidad aceptara el claim. Ya no es un careo pendiente y, si se
   -- muestra, termina comparando la fuente consigo misma a través del core.
   WHERE r.status='open' AND cl.status='candidate'
     AND r.kind IN ('album_match','person_match','organization_match')
   ORDER BY d.score DESC`;

export const CONFLICTS_SQL = `
  WITH raw AS (
    SELECT r.*, cf.value_a, cf.value_b, cf.claim_a_id AS cf_claim_a_id,
           cf.claim_b_id AS cf_claim_b_id,
           CASE r.payload->>'entityKind'
             WHEN 'artist' THEN to_jsonb(cur_artist)->(r.payload->>'field')
             WHEN 'person' THEN to_jsonb(cur_person)->(r.payload->>'field')
             WHEN 'organization' THEN to_jsonb(cur_organization)->(r.payload->>'field')
             WHEN 'album' THEN to_jsonb(cur_album)->(r.payload->>'field')
             WHEN 'track' THEN to_jsonb(cur_track)->(r.payload->>'field')
           END AS current_value
      FROM ingest.review_queue r
      LEFT JOIN ingest.conflicts cf ON cf.id=r.conflict_id
      LEFT JOIN artists cur_artist ON r.payload->>'entityKind'='artist'
        AND cur_artist.id=(r.payload->>'targetId')::bigint
      LEFT JOIN persons cur_person ON r.payload->>'entityKind'='person'
        AND cur_person.id=(r.payload->>'targetId')::bigint
      LEFT JOIN organizations cur_organization ON r.payload->>'entityKind'='organization'
        AND cur_organization.id=(r.payload->>'targetId')::bigint
      LEFT JOIN albums cur_album ON r.payload->>'entityKind'='album'
        AND cur_album.id=(r.payload->>'targetId')::bigint
      LEFT JOIN tracks cur_track ON r.payload->>'entityKind'='track'
        AND cur_track.id=(r.payload->>'targetId')::bigint
     WHERE r.kind='field_conflict' AND r.status='open'
  ), sided AS (
    SELECT raw.*,
      CASE
        WHEN payload->>'canonicalClaimId' ~ '^[1-9][0-9]*$' THEN (payload->>'canonicalClaimId')::bigint
        WHEN conflict_id IS NULL THEN NULL
        WHEN value_a IS NOT DISTINCT FROM current_value THEN cf_claim_a_id
        WHEN value_b IS NOT DISTINCT FROM current_value THEN cf_claim_b_id
      END AS canonical_claim_id,
      CASE
        WHEN payload->>'proposedClaimId' ~ '^[1-9][0-9]*$' THEN (payload->>'proposedClaimId')::bigint
        WHEN conflict_id IS NULL THEN claim_a_id
        WHEN value_a IS NOT DISTINCT FROM current_value THEN cf_claim_b_id
        WHEN value_b IS NOT DISTINCT FROM current_value THEN cf_claim_a_id
      END AS proposed_claim_id,
      CASE WHEN conflict_id IS NOT NULL
             AND ((payload ? 'canonicalValue' AND payload->'canonicalValue' IS DISTINCT FROM current_value)
               OR (NOT (payload ? 'canonicalValue')
                 AND value_a IS DISTINCT FROM current_value
                 AND value_b IS DISTINCT FROM current_value))
           THEN 'El valor actual cambió desde que se creó este conflicto y sus lados ya no son seguros.'
      END AS mapping_error
    FROM raw
  )
  SELECT r.id, r.payload->>'entityKind' AS entity_kind, r.payload->>'field' AS field,
         CASE WHEN r.conflict_id IS NULL THEN r.payload->>'canonicalValue'
              ELSE r.current_value #>> '{}' END AS canonical,
         COALESCE(r.payload->>'proposedValue',
           CASE WHEN r.proposed_claim_id=r.cf_claim_a_id THEN r.value_a #>> '{}'
                WHEN r.proposed_claim_id=r.cf_claim_b_id THEN r.value_b #>> '{}' END) AS proposed,
         r.payload->>'reason' AS reason,
         (r.payload->>'targetId')::bigint AS target_id,
         r.mapping_error,
         proposed_source.slug AS proposed_source,
         proposed_claim.confidence::text AS proposed_confidence,
         proposed_ev.url AS evidence_url, proposed_ev.excerpt AS evidence_excerpt,
         proposed_ev.selector AS evidence_selector,
         canonical_source.slug AS canonical_source,
         canonical_ev.url AS canonical_evidence_url,
         canonical_ev.excerpt AS canonical_evidence_excerpt,
         CASE r.payload->>'entityKind'
           WHEN 'organization' THEN (SELECT o.name FROM organizations o WHERE o.id=(r.payload->>'targetId')::bigint)
           WHEN 'track' THEN (SELECT t.title||' — '||a.title FROM tracks t JOIN albums a ON a.id=t.album_id
                               WHERE t.id=(r.payload->>'targetId')::bigint)
           WHEN 'album' THEN (SELECT a.title||' · '||ar.name||coalesce(' ('||a.release_year||')','')
                                FROM albums a JOIN artists ar ON ar.id=a.artist_id
                               WHERE a.id=(r.payload->>'targetId')::bigint)
           WHEN 'artist' THEN (SELECT ar.name FROM artists ar WHERE ar.id=(r.payload->>'targetId')::bigint)
           WHEN 'person' THEN (SELECT p.name FROM persons p WHERE p.id=(r.payload->>'targetId')::bigint)
         END AS target_name
    FROM sided r
    LEFT JOIN ingest.claims proposed_claim ON proposed_claim.id=r.proposed_claim_id
    LEFT JOIN ingest.sources proposed_source ON proposed_source.id=proposed_claim.source_id
    LEFT JOIN LATERAL (
      SELECT e.url,e.excerpt,e.selector FROM ingest.claim_evidence e
       WHERE e.claim_id=proposed_claim.id ORDER BY e.id LIMIT 1
    ) proposed_ev ON true
    LEFT JOIN ingest.claims canonical_claim ON canonical_claim.id=r.canonical_claim_id
    LEFT JOIN ingest.sources canonical_source ON canonical_source.id=canonical_claim.source_id
    LEFT JOIN LATERAL (
      SELECT e.url,e.excerpt FROM ingest.claim_evidence e
       WHERE e.claim_id=canonical_claim.id ORDER BY e.id LIMIT 1
    ) canonical_ev ON true
   ORDER BY r.id`;

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
  // El navegador compara este sello con /health. Cambia en cada generación
  // cuyo contenido cambie, pero no expone datos de la base en el HTML.
  const buildId = createHash("sha256").update(template).update(blob).digest("hex").slice(0, 16);
  await writeFile(OUT, template.replace("__DATA__", blob).replaceAll("__COTEJO_BUILD__", buildId), "utf8");
  console.log(`cotejo: ${slim.length} careos y ${conflicts.rowCount} contradicciones -> ${OUT}`);
  await pool.end();
}
void main();
