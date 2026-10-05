// CRV · Curaduría 2026-10-05: «El Puma En Ritmo» (José Luis Rodríguez, disco 7898).
// El reparto de pistas homónimas (run 13400) mudó las dos ocurrencias de «Mi Novia De
// Escuela» y dejó la pista 53712 (posición 2) vacía; según Sincopa la 2 es «Ella Me
// Vacila (Remix Disco Version)» 6:43 y la 5 «Ella Me Vacila» 5:19 (Alston Becket Cyrus),
// cuyos claims habían quedado sin pista.
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: tracklist de Sincopa (joseluis_91pumaenritmo1.htm): posiciones 2 y 5 son «Ella Me Vacila»";
const { runId } = await withOperatorRun({ name: "curation:fix-puma-en-ritmo", operator: "claude-code", note: NOTE }, async ({ client }) => {
  await client.query("UPDATE public.tracks SET title='Ella Me Vacila', duration_seconds=403 WHERE id=53712");
  await client.query("UPDATE ingest.claims SET track_id=53712, album_id=NULL, status='accepted', updated_at=now() WHERE id IN (891776,891777,891781,891774)");
  await client.query("UPDATE ingest.track_aliases SET alias='Ella Me Vacila', normalized_alias='ella me vacila' WHERE id=41377");
  await client.query("UPDATE public.track_credits SET person_id=25922 WHERE id=27874");
  const { rows: [created] } = await client.query<{ id: string }>(
    "INSERT INTO public.tracks(album_id, disc_number, track_number, title, duration_seconds) VALUES (7898,1,5,'Ella Me Vacila',319) RETURNING id::text");
  const id = Number(created!.id);
  await client.query("UPDATE ingest.claims SET track_id=$1, status='accepted', updated_at=now() WHERE id IN (891916,891917,891919,891914)", [id]);
  await client.query("INSERT INTO public.track_credits(track_id, person_id, credit_type, role) VALUES ($1,25922,'composer','composer')", [id]);
  await client.query("INSERT INTO public.track_credits(track_id, person_id, credit_type, role) VALUES (159437,13349,'composer','composer'),(159438,13349,'composer','composer')");
});
console.log(`run ${runId}`);
await closeDb();
