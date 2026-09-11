// Exporta un snapshot minimo y publico para la Radio CRV en Herra.
// No copia payloads, descripciones, claims ni evidencia: solo lo necesario
// para programar y presentar los albumes elegibles del canal oficial.
import fs from "node:fs";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import {
  RADIO_CATALOG_VERSION,
  buildRadioTracks,
  livePlayableVideoIds,
  type RadioTrackRow,
} from "../src/radio/catalog.js";

const CRV_CHANNEL_ID = "UCtYlrz6GyvRahlhHjocWQYQ";

async function main(): Promise<void> {
  const requested = process.argv[2] ?? process.env["CRV_RADIO_EXPORT_PATH"];
  if (!requested) throw new Error("uso: npm run radio:export -- /ruta/crv-radio-catalog.json");
  const outputPath = path.resolve(requested);
  const result = await getPool().query<RadioTrackRow>(`
    SELECT v.video_id, v.title AS video_title,
           v.duration_seconds AS video_duration_seconds,
           t.position, t.title AS track_title, t.start_seconds
      FROM media.youtube_videos v
      JOIN media.youtube_tracklist_entries t ON t.video_id = v.id
     WHERE v.channel_id = $1
       AND v.publication_status = 'published'
       AND COALESCE((v.metadata->'status'->>'embeddable')::boolean, false) = true
       AND v.duration_seconds BETWEEN 60 AND 21600
       AND v.title IS NOT NULL
     ORDER BY v.video_id, t.position`, [CRV_CHANNEL_ID]);

  const candidateIds = [...new Set(result.rows.map(row => row.video_id))];
  const playableIds = await livePlayableVideoIds(candidateIds);
  const items = buildRadioTracks(result.rows, playableIds);
  if (items.length < 2) throw new Error(`catalogo insuficiente: ${items.length} canciones elegibles`);

  const checkedAt = new Date().toISOString();

  const payload = JSON.stringify({
    version: RADIO_CATALOG_VERSION,
    generatedAt: checkedAt,
    availabilityCheckedAt: checkedAt,
    channelId: CRV_CHANNEL_ID,
    items,
  }, null, 2) + "\n";
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, outputPath);
  const hours = items.reduce((sum, item) => sum + item.durationSeconds, 0) / 3600;
  const unavailable = candidateIds.length - playableIds.size;
  process.stdout.write(`Radio CRV: ${items.length} canciones, ${hours.toFixed(1)} horas; ${unavailable} videos no disponibles excluidos -> ${outputPath}\n`);
}

main()
  .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; })
  .finally(closeDb);
