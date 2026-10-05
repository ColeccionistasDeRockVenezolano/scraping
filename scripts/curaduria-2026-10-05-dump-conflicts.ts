// CRV · Curaduría 2026-10-05: volcado de los conflictos de campo abiertos con su contexto.
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-dump-conflicts.ts
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

async function main(): Promise<void> {
  const { rows } = await getPool().query(`
    SELECT r.id AS review_id, r.conflict_id, r.payload,
           cs.slug AS canon_src, cc.status AS canon_status, rpc.url AS canon_url,
           ps.slug AS prop_src, cp.status AS prop_status, rpp.url AS prop_url,
           CASE r.payload->>'entityKind'
             WHEN 'track' THEN (SELECT concat_ws(' | ', t.title, al.title, ar.name, al.release_year::text, 'pos ' || t.track_number) FROM public.tracks t JOIN public.albums al ON al.id=t.album_id LEFT JOIN public.artists ar ON ar.id=al.artist_id WHERE t.id=(r.payload->>'targetId')::bigint)
             WHEN 'album' THEN (SELECT concat_ws(' | ', al.title, ar.name, al.release_year::text) FROM public.albums al LEFT JOIN public.artists ar ON ar.id=al.artist_id WHERE al.id=(r.payload->>'targetId')::bigint)
             WHEN 'organization' THEN (SELECT o.name FROM public.organizations o WHERE o.id=(r.payload->>'targetId')::bigint)
             WHEN 'person' THEN (SELECT p.name FROM public.persons p WHERE p.id=(r.payload->>'targetId')::bigint)
             WHEN 'artist' THEN (SELECT a.name FROM public.artists a WHERE a.id=(r.payload->>'targetId')::bigint)
           END AS context
      FROM ingest.review_queue r
      LEFT JOIN ingest.claims cc ON cc.id=(r.payload->>'canonicalClaimId')::bigint
      LEFT JOIN ingest.sources cs ON cs.id=cc.source_id
      LEFT JOIN ingest.raw_pages rpc ON rpc.id=cc.raw_page_id
      LEFT JOIN ingest.claims cp ON cp.id=(r.payload->>'proposedClaimId')::bigint
      LEFT JOIN ingest.sources ps ON ps.id=cp.source_id
      LEFT JOIN ingest.raw_pages rpp ON rpp.id=cp.raw_page_id
     WHERE r.kind='field_conflict' AND r.status IN ('open','in_progress')
     ORDER BY r.payload->>'entityKind', r.payload->>'field', r.id`);
  writeFileSync("reports/curaduria-2026-10-05/conflicts-dump.json", JSON.stringify(rows, null, 1));
  console.log(`${rows.length} conflictos`);
  await closeDb();
}
void main();
