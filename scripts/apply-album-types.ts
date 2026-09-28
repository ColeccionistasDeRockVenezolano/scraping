// CRV · Tipo de disco para los discos que siguen en `other` (el DEFAULT del
// core: «nadie lo dijo»), a partir de los libros de evidencia de
// scripts/harvest-album-types.py (hoja, nombre, formato, posts, Discogs) y
// scripts/harvest-album-types-online.ts (Deezer, MusicBrainz).
//
// Resolución por disco:
//   * la hoja manda (regla de docs/DATA_MODEL.md: «Solo Artist, X»);
//   * un split en cualquier señal deja el disco sin tocar (no hay tipo para eso);
//   * si todas las señales concretas (ep, single, demo, compilation, live_album,
//     remix, soundtrack) dicen lo mismo, ese es el tipo; si discrepan, se salta
//     y queda en el informe (también si solo Deezer o MusicBrainz lo dan y el
//     formato físico dice álbum);
//   * solo «álbum» genérico (LP, Album, record_type=album) → studio_album.
// Music Video, Live Concert, Documentary y B-Sides no llevan tipo de disco
// salvo que la hoja lo diga.
//
// Cada cambio deja un claim de la fuente `crv-tipo-disco` con la evidencia de
// cada señal y su fila de merge_audit, todo en un run reversible. Solo toca
// discos que siguen en `other` al aplicar.
//
// Uso: tsx scripts/apply-album-types.ts [--confirm]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const DATE = "2026-09-28";
const LEDGERS = [`reports/album-type-evidence-${DATE}.jsonl`, `reports/album-type-evidence-online-${DATE}.jsonl`];
const SOURCE_SLUG = "crv-tipo-disco";
const EXTRACTOR = "tipo-disco";
const NO_TYPE = ["Music Video", "Live Concert", "Documentary", "B-Sides"];
const ONLINE = new Set(["deezer", "musicbrainz"]);
const SPECIFIC = new Set(["ep", "single", "demo", "compilation", "live_album", "remix", "soundtrack", "collaboration_album"]);

interface Signal { albumId: number; artist: string; title: string; source: string; via: string; type: string; raw: string; url: string | null }

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function resolveType(signals: Signal[]): { type: string | null; why: string } {
  const sheet = new Set(signals.filter((signal) => signal.via === "hoja").map((signal) => signal.type));
  if (sheet.size === 1) return { type: [...sheet][0]!, why: "hoja" };
  if (sheet.size > 1) return { type: null, why: `la hoja discrepa: ${[...sheet].join(" / ")}` };
  if (signals.some((signal) => signal.type === "split")) return { type: null, why: "split" };
  const specificOf = (list: Signal[]) =>
    new Set(list.map((signal) => signal.type === "live" ? "live_album" : signal.type).filter((type) => SPECIFIC.has(type)));
  const specific = specificOf(signals);
  // Deezer y MusicBrainz describen la reedición digital (un LP a medias sale como
  // «ep»): si solo ellos dan el tipo concreto y el disco físico dice álbum, se salta.
  const offline = signals.filter((signal) => !ONLINE.has(signal.via));
  if (specific.size === 1 && !specificOf(offline).size && offline.some((signal) => signal.type === "album" || signal.type === "studio_album")) {
    return { type: null, why: `señales discrepan: album / ${[...specific][0]} (solo en línea)` };
  }
  if (specific.size === 1) return { type: [...specific][0]!, why: "señales concretas de acuerdo" };
  if (specific.size > 1) return { type: null, why: `señales discrepan: ${[...specific].sort().join(" / ")}` };
  if (signals.some((signal) => signal.type === "album" || signal.type === "studio_album")) return { type: "studio_album", why: "álbum genérico" };
  return { type: null, why: "sin tipo" };
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const byAlbum = new Map<number, Signal[]>();
  for (const file of LEDGERS) {
    if (!existsSync(file)) throw new Error(`falta ${file}`);
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const signal = JSON.parse(line) as Signal;
      const list = byAlbum.get(signal.albumId) ?? [];
      list.push(signal);
      byAlbum.set(signal.albumId, list);
    }
  }
  const report = {
    mode: confirm ? "confirm" : "dry-run", runId: 0, albumsWithSignal: byAlbum.size,
    applied: {} as Record<string, number>, byWhy: {} as Record<string, number>,
    skipped: [] as Array<{ albumId: number; artist: string; title: string; why: string; signals: string[] }>,
    notOther: 0, noTypeClass: 0,
    changes: [] as Array<{ albumId: number; artist: string; title: string; type: string; why: string; signals: string[] }>,
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Tipo de disco (cosecha de señales)','database','medium',false,
             'Tipo de disco resuelto a partir de la hoja, el nombre, el formato de las fuentes, los posts, Discogs, Deezer y MusicBrainz (scripts/apply-album-types.ts). Nunca se raspa; cada claim guarda la evidencia de cada señal.')
      ON CONFLICT (slug) DO NOTHING`, [SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "album_types", ledgers: LEDGERS, confirm })]);
    report.runId = Number(run.rows[0]!.id);
    const current = new Map((await client.query<{ id: string; album_type: string; classes: string[] | null }>(`
      SELECT a.id::text, a.album_type::text,
             (SELECT array_agg(x.classification) FROM ingest.album_classifications x WHERE x.album_id = a.id) AS classes
        FROM public.albums a WHERE a.id = ANY($1::bigint[])`, [[...byAlbum.keys()]])).rows.map((row) => [Number(row.id), row]));

    for (const [albumId, signals] of [...byAlbum].sort(([a], [b]) => a - b)) {
      const row = current.get(albumId);
      if (!row || row.album_type !== "other") { report.notOther += 1; continue; }
      const labels = signals.map((signal) => `${signal.via}:${signal.type} (${signal.raw})`);
      const { type, why } = resolveType(signals);
      if (!type) {
        if (why !== "sin tipo") report.skipped.push({ albumId, artist: signals[0]!.artist, title: signals[0]!.title, why, signals: labels });
        continue;
      }
      if (why !== "hoja" && (row.classes ?? []).some((label) => NO_TYPE.includes(label))) { report.noTypeClass += 1; continue; }
      const updated = await client.query(`UPDATE public.albums SET album_type=$2::album_type, updated_at=now() WHERE id=$1 AND album_type='other' RETURNING id`, [albumId, type]);
      if (!updated.rowCount) { report.notOther += 1; continue; }
      const note = `${why}; señales: ${[...new Set(signals.map((signal) => signal.via))].join(", ")}`;
      const claim = await client.query<{ id: string }>(`
        INSERT INTO ingest.claims(source_id,entity_kind,album_id,field,raw_value,normalized_value,raw_hash,extractor,
                                  extractor_version,confidence,status,created_by,run_id,notes,identity_key)
        VALUES($1,'album',$2,'album_type',to_jsonb($3::text),to_jsonb($3::text),$4,$5,'1','medium','accepted','system',$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id::text`,
      [sourceId, albumId, type, sha([EXTRACTOR, albumId, type]), EXTRACTOR, report.runId, note, `tipo-disco:album:${albumId}`]);
      const claimId = claim.rows[0]?.id;
      if (claimId) {
        for (const [position, signal] of signals.entries()) {
          const url = signal.url ?? `crv-fuente://${signal.source}/album/${albumId}`;
          const excerpt = `[${signal.source} · ${signal.via}] ${signal.type}: ${signal.raw}`.slice(0, 500);
          await client.query(`
            INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT DO NOTHING`, [claimId, url, excerpt, position, sha([url, excerpt])]);
        }
      }
      const audit = await client.query<{ id: string }>(`
        INSERT INTO ingest.merge_audit(run_id,entity_kind,album_id,field,old_value,new_value,reason,confidence,performed_by)
        VALUES($1,'album',$2,'album_type',to_jsonb('other'::text),to_jsonb($3::text),$4,'medium','system') RETURNING id::text`,
      [report.runId, albumId, type, note]);
      if (claimId) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [audit.rows[0]!.id, claimId]);
      report.applied[type] = (report.applied[type] ?? 0) + 1;
      report.byWhy[why] = (report.byWhy[why] ?? 0) + 1;
      report.changes.push({ albumId, artist: signals[0]!.artist, title: signals[0]!.title, type, why, signals: labels });
    }
    await client.query(`UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1`,
      [report.runId, JSON.stringify({ applied: report.applied, skipped: report.skipped.length })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const out = `reports/apply-album-types-${report.mode}-${DATE}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  const total = Object.values(report.applied).reduce((sum, value) => sum + value, 0);
  console.log(`tipos de disco (${report.mode}, run ${report.runId}): ${report.albumsWithSignal} con señal · ${total} aplicados`, JSON.stringify(report.applied),
    `· ${report.skipped.length} saltados · ${report.noTypeClass} con clasificación sin tipo · ${report.notOther} ya tenían tipo → ${out}`);
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
