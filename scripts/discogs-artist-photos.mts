// Etapa 3 (fotos): candidatos de foto para los artistas con identidad Discogs
// ya aceptada (status matched) que siguen sin foto en el catálogo. Lee el
// payload de la API con el token del .env y emite candidatos para
// localize-images.ts (que descarga y asocia).
// Uso: tsx discogs-artist-photos.mts [--out reports/media-discogs-artist-2026-10-01.jsonl] [--delay-ms 1500]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const USER_AGENT = "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function positive(name: string, fallback: number): number {
  const raw = arg(name); if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isInteger(value) || value < 1) throw new Error(`${name} debe ser entero positivo`);
  return value;
}
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

interface Row { id: number; name: string; externalId: string; url: string; }
interface Candidate { kind: "artist"; id: number; sourceUrl: string; label: string; source: "discogs"; discogsId: string; }

async function main(): Promise<void> {
  const delay = positive("--delay-ms", 1500);
  const out = path.resolve(ROOT, arg("--out") ?? "reports/media-discogs-artist-2026-10-01.jsonl");
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  const token = process.env["DISCOGS_TOKEN"]?.trim();
  if (!token) throw new Error("falta DISCOGS_TOKEN");
  try {
    const { rows } = await pool.query<{ id: string; name: string; external_id: string }>(`
      SELECT a.id::text, a.name, i.external_id
        FROM ingest.genre_external_identities i
        JOIN ingest.genre_external_sources s ON s.id=i.source_id AND s.slug='discogs'
        JOIN public.artists a ON a.id=i.entity_id
       WHERE i.entity_kind='artist' AND i.status='matched'
         AND (a.picture_url IS NULL OR btrim(a.picture_url)='') ORDER BY a.id`);
    const pendientes: Row[] = rows.map((r) => ({ id: Number(r.id), name: r.name, externalId: r.external_id, url: `https://api.discogs.com/artists/${r.external_id}` }));
    console.log(`artistas matched sin foto: ${pendientes.length}`);
    const candidates: Candidate[] = []; const rejected: Array<Record<string, unknown>> = [];
    for (const row of pendientes) {
      try {
        const response = await fetch(row.url, { headers: { authorization: `Discogs token=${token}`, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) { rejected.push({ id: row.id, name: row.name, reason: `HTTP ${response.status}` }); await pause(delay); continue; }
        const payload = await response.json() as { images?: Array<{ uri?: string; type?: string }> };
        const images = payload.images ?? [];
        const primary = images.find((image) => image.type === "primary" && /^https?:\/\//u.test(image.uri ?? "")) ?? images.find((image) => /^https?:\/\//u.test(image.uri ?? ""));
        if (primary?.uri) candidates.push({ kind: "artist", id: row.id, sourceUrl: primary.uri, label: row.name, source: "discogs", discogsId: row.externalId });
        else rejected.push({ id: row.id, name: row.name, reason: "sin imágenes en Discogs" });
      } catch (error) { rejected.push({ id: row.id, name: row.name, reason: (error as Error).message }); }
      await pause(delay);
    }
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""));
    await writeFile(out.replace(/\.jsonl$/u, "-rejected.jsonl"), rejected.map((row) => JSON.stringify(row)).join("\n") + (rejected.length ? "\n" : ""));
    console.log(JSON.stringify({ pendientes: pendientes.length, candidatos: candidates.length, rechazados: rejected.length, out: path.relative(ROOT, out) }));
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
