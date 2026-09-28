// Lista los artistas sin género principal confirmado (id y nombre) para los
// cosechadores de fuentes externas. Solo lectura.
import { closeDb, getPool } from "../src/db/client.js";

const { rows } = await getPool().query(`
  SELECT a.id, a.name FROM public.artists a
   WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=a.id AND g.role='primary' AND g.status='confirmed')
   ORDER BY a.id`);
console.log(JSON.stringify(rows));
await closeDb();
