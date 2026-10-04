// Vinilos de Sincopa: las pistas de la cara B que entraron al core antes del
// arreglo del adapter quedaron con el número de su cara («01» → 4 en vez de 7).
// Con las fichas ya reingeridas, mueve cada pista al número que la ficha
// afirma ahora, disco por disco y en una transacción, y deja el claim viejo
// como `superseded` y el nuevo como `accepted`.
//
// Un disco se salta (y se informa) si el orden final repite una posición, si
// otra pista del disco que no viene de la ficha estorba, si la ficha repite el
// título o si otra fuente sostiene el número actual.
//
//   DATA_DIR=… tsx scripts/renumber-sincopa-sides.ts --urls-file=…txt            # ensayo
//   DATA_DIR=… tsx scripts/renumber-sincopa-sides.ts --urls-file=… --confirm --note="…"
import { readFileSync, writeFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getDb, getPool } from "../src/db/client.js";
import { bindRun } from "../src/db/run-binding.js";
import { scrapeRuns } from "../src/db/schema/ingest.js";
import { loadStoredAdapterPages } from "../src/ingest/runner.js";
import { finishRun } from "../src/ingest/runs.js";
import { normalizeRecord } from "../src/normalization/claims.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

interface Move { trackId: number; title: string; from: number; to: number; oldClaimIds: number[]; newClaimId: number; url: string }
interface AlbumPlan { albumId: number; disc: number; moves: Move[] }
interface Skipped { albumId: number; disc: number; url: string; reason: string }

async function main(): Promise<void> {
  const urlsFile = arg("urls-file");
  if (urlsFile === undefined) throw new Error("--urls-file obligatorio");
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: la cara B del vinilo numera corrido; la pista entró con el número de su cara";
  const wanted = new Set(readFileSync(urlsFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean));
  const adapter = new SincopaAdapter();
  const pages = (await loadStoredAdapterPages("sincopa", adapter)).filter((page) => wanted.has(page.url));
  const pool = getPool();

  const { rows: claims } = await pool.query<{ id: string; raw_page_id: string; identity_raw: string; value: string; status: string; track_id: string | null }>(`
    SELECT c.id::text, c.raw_page_id::text, c.identity_raw, c.raw_value #>> '{}' AS value, c.status::text, c.track_id::text
      FROM ingest.claims c
     WHERE c.source_id = (SELECT id FROM ingest.sources WHERE slug = 'sincopa')
       AND c.entity_kind = 'track' AND c.field = 'track_number' AND c.raw_page_id = ANY($1::bigint[])`,
  [pages.map((page) => page.rawPageId)]);
  const byKey = new Map<string, typeof claims>();
  for (const row of claims) {
    const key = `${row.raw_page_id}|${row.identity_raw}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  // Movimientos candidatos, por pista del core.
  const moves = new Map<number, Move>();
  const skipped: Skipped[] = [];
  const repeatedTitle = new Set<number>();
  for (const page of pages) {
    const expected = adapter.extractSnapshot(page).flatMap(normalizeRecord)
      .filter((claim) => claim.entityKind === "track" && claim.field === "track_number");
    const perIdentity = new Map<string, number[]>();
    for (const claim of expected) perIdentity.set(claim.originalIdentity, [...(perIdentity.get(claim.originalIdentity) ?? []), Number(claim.rawValue)]);
    for (const [identity, numbers] of perIdentity) {
      const have = byKey.get(`${page.rawPageId}|${identity}`) ?? [];
      const accepted = have.filter((row) => row.status === "accepted" && row.track_id !== null);
      if (numbers.length > 1) {
        for (const row of accepted) repeatedTitle.add(Number(row.track_id));
        continue;
      }
      const want = numbers[0]!;
      const wrong = accepted.filter((row) => Number(row.value) !== want);
      if (wrong.length === 0) continue;
      const trackIds = new Set(wrong.map((row) => Number(row.track_id)));
      const fresh = have.find((row) => Number(row.value) === want && row.status === "candidate");
      if (trackIds.size !== 1 || fresh === undefined) continue;
      const trackId = [...trackIds][0]!;
      moves.set(trackId, { trackId, title: identity.split("::").at(-1) ?? identity, from: Number(wrong[0]!.value), to: want,
        oldClaimIds: wrong.map((row) => Number(row.id)), newClaimId: Number(fresh.id), url: page.url });
    }
  }

  // Estado actual del core y apoyo de otras fuentes al número actual.
  const trackIds = [...moves.keys()];
  const { rows: core } = await pool.query<{ id: string; album_id: string; disc_number: number; track_number: number; title: string }>(`
    SELECT t.id::text, t.album_id::text, t.disc_number, t.track_number, t.title
      FROM public.tracks t
     WHERE t.album_id IN (SELECT album_id FROM public.tracks WHERE id = ANY($1::bigint[]))`, [trackIds]);
  const { rows: support } = await pool.query<{ track_id: string; sources: string }>(`
    SELECT c.track_id::text, string_agg(DISTINCT s.slug, ',') AS sources
      FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id JOIN public.tracks t ON t.id = c.track_id
     WHERE c.track_id = ANY($1::bigint[]) AND c.field = 'track_number' AND c.status = 'accepted'
       AND s.slug <> 'sincopa' AND (c.raw_value #>> '{}') ~ '^[0-9]+$' AND (c.raw_value #>> '{}')::int = t.track_number
     GROUP BY c.track_id`, [trackIds]);
  const supported = new Map(support.map((row) => [Number(row.track_id), row.sources]));

  const plans: AlbumPlan[] = [];
  const byAlbum = new Map<string, typeof core>();
  for (const row of core) byAlbum.set(`${row.album_id}|${row.disc_number}`, [...(byAlbum.get(`${row.album_id}|${row.disc_number}`) ?? []), row]);
  for (const [key, tracks] of byAlbum) {
    const albumMoves = tracks.map((track) => moves.get(Number(track.id))).filter((move): move is Move => move !== undefined);
    if (albumMoves.length === 0) continue;
    const [albumId, disc] = key.split("|").map(Number) as [number, number];
    const url = albumMoves[0]!.url;
    const blocked = albumMoves.find((move) => supported.has(move.trackId) || repeatedTitle.has(move.trackId));
    const staleCore = albumMoves.find((move) => tracks.find((track) => Number(track.id) === move.trackId)?.track_number !== move.from);
    const final = new Map<number, string>();
    let collision: string | undefined;
    for (const track of tracks) {
      const position = moves.get(Number(track.id))?.to ?? track.track_number;
      const other = final.get(position);
      if (other !== undefined) collision ??= `posición ${position}: «${other}» y «${track.title}»`;
      final.set(position, track.title);
    }
    if (blocked !== undefined) {
      skipped.push({ albumId, disc, url, reason: supported.has(blocked.trackId)
        ? `«${blocked.title}»: ${supported.get(blocked.trackId)} sostiene el número ${blocked.from}`
        : `«${blocked.title}»: la ficha repite el título` });
    } else if (staleCore !== undefined) {
      skipped.push({ albumId, disc, url, reason: `«${staleCore.title}»: el core ya no tiene el número ${staleCore.from}` });
    } else if (collision !== undefined) {
      skipped.push({ albumId, disc, url, reason: collision });
    } else plans.push({ albumId, disc, moves: albumMoves });
  }

  let runId: number | undefined;
  let moved = 0;
  if (confirm && plans.length > 0) {
    const [run] = await getDb().insert(scrapeRuns).values({
      kind: "manual", status: "running",
      params: { action: "renumber-sincopa-sides", note, urlsFile, albums: plans.length },
    }).returning();
    if (!run) throw new Error("no se pudo abrir el run");
    runId = run.id;
    const reason = `[run ${run.id}] ${note}`;
    for (const plan of plans) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await bindRun(client, run.id);
        // La restricción única no es diferible: primero a posiciones libres.
        for (const [index, move] of plan.moves.entries()) {
          await client.query("UPDATE public.tracks SET track_number=$2 WHERE id=$1", [move.trackId, 32000 - index]);
        }
        for (const move of plan.moves) {
          await client.query("UPDATE public.tracks SET track_number=$2 WHERE id=$1", [move.trackId, move.to]);
          await client.query("UPDATE ingest.claims SET status='superseded', updated_at=now() WHERE id=ANY($1::bigint[])", [move.oldClaimIds]);
          await client.query("UPDATE ingest.claims SET status='accepted', track_id=$2, updated_at=now() WHERE id=$1", [move.newClaimId, move.trackId]);
          const saved = await client.query<{ id: string }>(`
            INSERT INTO ingest.merge_audit(run_id,entity_kind,track_id,field,old_value,new_value,reason,confidence,performed_by)
            VALUES($1,'track',$2,'track_number',$3::jsonb,$4::jsonb,$5,'high','human') RETURNING id::text`,
          [run.id, move.trackId, JSON.stringify(move.from), JSON.stringify(move.to), reason]);
          await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [saved.rows[0]!.id, move.newClaimId]);
          await client.query(`
            UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$2, resolved_at=now(), updated_at=now()
             WHERE claim_a_id=$1 AND status IN ('open','in_progress')`, [move.newClaimId, reason]);
          moved += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        skipped.push({ albumId: plan.albumId, disc: plan.disc, url: plan.moves[0]!.url, reason: `error: ${(error as Error).message}` });
      } finally {
        client.release();
      }
    }
    await finishRun(run.id, skipped.some((item) => item.reason.startsWith("error")) ? "partial" : "ok", { albums: plans.length, moved, skipped: skipped.length });
  }
  const report = {
    dryRun: !confirm, runId, pages: pages.length, albums: plans.length, tracksToMove: plans.reduce((sum, plan) => sum + plan.moves.length, 0),
    moved, skipped: skipped.length,
  };
  const out = arg("out");
  if (out !== undefined) writeFileSync(out, `${JSON.stringify({ ...report, plans, skippedList: skipped }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
