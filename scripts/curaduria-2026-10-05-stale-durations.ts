// CRV · Curaduría 2026-10-05: duraciones del core desfasadas tras repartir pistas homónimas (run 13400).
// La pista fundida guardaba la duración de otra ocurrencia; tras el reparto, su único claim de duración
// aceptado (misma posición de la ficha de Sincopa) dice otra cosa. Se escribe el valor del claim.
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: duración según el claim aceptado de la pista (la fundida guardaba la de otra ocurrencia)";
const { runId, result } = await withOperatorRun({ name: "curation:stale-durations", operator: "claude-code", note: NOTE }, async ({ client }) => {
  const { rowCount } = await client.query(`
    WITH d AS (SELECT c.track_id, array_agg(DISTINCT (COALESCE(c.normalized_value,c.raw_value)#>>'{}')::int) v FROM ingest.claims c
                WHERE c.field='duration_seconds' AND c.status='accepted' AND c.track_id IS NOT NULL
                  AND (COALESCE(c.normalized_value,c.raw_value)#>>'{}') ~ '^\\d+$' GROUP BY 1)
    UPDATE public.tracks t SET duration_seconds=d.v[1] FROM d
     WHERE d.track_id=t.id AND array_length(d.v,1)=1 AND t.duration_seconds IS NOT NULL AND abs(t.duration_seconds-d.v[1])>2`);
  return rowCount;
});
console.log(`run ${runId}: ${result} pistas`);
await closeDb();
