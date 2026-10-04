// Discos del core que juntan varias fichas de Sincopa con el mismo título del
// mismo artista («Grupo Mango::Mango» de 1975, 1976, 1979…). Sincopa les da la
// misma identidad (artista::título) y la promoción los fundió en un disco.
// Decisiones de Brian (2026-10-03):
//   - una edición del mismo disco (mismo año, o la mitad del repertorio en
//     común: LP/CD/DVD) se queda en el disco;
//   - un disco distinto (otro año y casi nada en común) se separa: la página
//     recibe un sufijo de identidad en el adapter (sincopa-identity-overrides)
//     y, tras reingerirla, este script crea su disco y le mueve lo suyo;
//   - un disco cuyo orden y datos vienen del canal no se cambia: de él no se
//     mueve ninguna pista ni crédito.
//
//   tsx scripts/split-sincopa-mixed-albums.ts --plan [--out=…json] [--write-overrides]
//   tsx scripts/split-sincopa-mixed-albums.ts --apply=<plan.json> [--confirm --note="…"]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const CHANNEL_SOURCES = [12, 14]; // yt-master-seed, youtube-data-api: el canal manda
const OVERRIDES_FILE = "src/adapters/sincopa-identity-overrides.ts";

export interface PagePlan { pageId: number; url: string; year?: number; tracks: number; linked: number; role: "dueña" | "edición" | "separar" | "retener"; why: string; suffix?: string }
export interface AlbumPlan { albumId: number; title: string; artistId: number | null; year: number | null; channel: boolean; pages: PagePlan[] }

async function plan(): Promise<AlbumPlan[]> {
  const pool = getPool();
  const { rows: albums } = await pool.query<{ album_id: string; title: string; artist_id: string | null; release_year: number | null; pages: string }>(`
    SELECT c.album_id::text, a.title, a.artist_id::text, a.release_year, count(DISTINCT c.raw_page_id)::text AS pages
      FROM ingest.claims c JOIN ingest.raw_pages p ON p.id = c.raw_page_id JOIN public.albums a ON a.id = c.album_id
     WHERE c.source_id = 7 AND c.entity_kind = 'album' AND c.status = 'accepted' AND p.url LIKE '%/cdinfo%'
     GROUP BY 1, 2, 3, 4 HAVING count(DISTINCT c.raw_page_id) > 1 ORDER BY 1`);
  const out: AlbumPlan[] = [];
  for (const album of albums) {
    const albumId = Number(album.album_id);
    const { rows: [channel] } = await pool.query<{ hit: boolean }>(`
      SELECT (SELECT youtube_url FROM public.albums WHERE id = $1) IS NOT NULL
          OR EXISTS (SELECT 1 FROM ingest.claims WHERE album_id = $1 AND source_id = ANY($2) AND status = 'accepted')
          OR EXISTS (SELECT 1 FROM ingest.claims c JOIN public.tracks t ON t.id = c.track_id WHERE t.album_id = $1 AND c.source_id = ANY($2) AND c.status = 'accepted') AS hit`,
      [albumId, CHANNEL_SOURCES]);
    const { rows: pages } = await pool.query<{ id: string; url: string; year: string | null; titles: string[] | null; linked: string }>(`
      SELECT p.id::text, p.url,
             (SELECT max(substring(c.raw_value #>> '{}' from '(\\d{4})')) FROM ingest.claims c
               WHERE c.raw_page_id = p.id AND c.entity_kind = 'album' AND c.field = 'release_year') AS year,
             (SELECT array_agg(DISTINCT c.raw_value #>> '{}') FROM ingest.claims c
               WHERE c.raw_page_id = p.id AND c.entity_kind = 'track' AND c.field = 'title' AND c.status <> 'rejected') AS titles,
             (SELECT count(DISTINCT t.id) FROM ingest.claims c JOIN public.tracks t ON t.id = c.track_id
               WHERE c.raw_page_id = p.id AND c.status = 'accepted' AND t.album_id = $1)::text AS linked
        FROM ingest.raw_pages p
       WHERE p.url LIKE '%/cdinfo%' AND p.id IN (SELECT raw_page_id FROM ingest.claims WHERE source_id = 7 AND entity_kind = 'album' AND status = 'accepted' AND album_id = $1)
       ORDER BY p.id`, [albumId]);
    const rows: Array<{ pageId: number; url: string; year: number | undefined; titles: Set<string>; linked: number }> = pages.map((page) => ({ pageId: Number(page.id), url: page.url, year: page.year === null ? undefined : Number(page.year),
      titles: new Set((page.titles ?? []).map(fold)), linked: Number(page.linked) }));
    // La dueña: la del año del disco; si no hay una sola, la que más pistas del disco sostiene.
    const byYear = rows.filter((row) => album.release_year !== null && row.year === album.release_year);
    const owner = byYear.length === 1 ? byYear[0]! : [...rows].sort((a, b) => b.linked - a.linked || a.pageId - b.pageId)[0]!;
    const result: PagePlan[] = [];
    for (const row of rows) {
      const base = { pageId: row.pageId, url: row.url, ...(row.year === undefined ? {} : { year: row.year }), tracks: row.titles.size, linked: row.linked };
      if (row === owner) { result.push({ ...base, role: "dueña", why: byYear.length === 1 ? "su año es el del disco" : "la que más pistas del disco sostiene" }); continue; }
      const shared = [...row.titles].filter((title) => owner.titles.has(title)).length;
      const smaller = Math.min(row.titles.size, owner.titles.size);
      const overlap = smaller === 0 ? 0 : shared / smaller;
      if (row.year !== undefined && row.year === owner.year) { result.push({ ...base, role: "edición", why: `mismo año que la dueña (${row.year})` }); continue; }
      if (overlap >= 0.5) { result.push({ ...base, role: "edición", why: `comparte ${shared}/${smaller} pistas con la dueña` }); continue; }
      // «La Música Más Pura y Bella… 501…505», «20 Exitos 1/2»: sin año, pero otro repertorio entero.
      if (row.year === undefined || owner.year === undefined) {
        if (overlap < 0.2 && row.titles.size >= 3 && owner.titles.size >= 3) result.push({ ...base, role: "separar", why: `sin año que comparar, ${shared}/${smaller} pistas en común` });
        else result.push({ ...base, role: "retener", why: `sin año que comparar y ${shared}/${smaller} pistas en común` });
        continue;
      }
      result.push({ ...base, role: "separar", why: `otro año (${row.year} frente a ${owner.year}) y ${shared}/${smaller} pistas en común` });
    }
    // Sufijo de identidad: el año; sin año o si dos páginas del disco lo comparten, el nombre de la página.
    for (const page of result.filter((item) => item.role === "separar")) {
      const slug = page.url.split("/").pop()!.replace(/\.html?$/u, "");
      const twins = result.filter((item) => item.year === page.year).length;
      page.suffix = page.year === undefined ? slug : twins > 1 ? `${page.year} ${slug}` : String(page.year);
    }
    out.push({ albumId, title: album.title, artistId: album.artist_id === null ? null : Number(album.artist_id), year: album.release_year, channel: channel?.hit ?? false, pages: result });
  }
  return out;
}

function writeOverrides(albums: AlbumPlan[]): void {
  const entries = albums.flatMap((album) => album.pages.filter((page) => page.role === "separar").map((page) => [page.url, page.suffix!] as const))
    .sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([url, suffix]) => `  ${JSON.stringify(url)}: ${JSON.stringify(suffix)},`).join("\n");
  writeFileSync(OVERRIDES_FILE, `// Sufijos de identidad para fichas de Sincopa que comparten artista y título con
// otro disco distinto del mismo artista («Grupo Mango::Mango» de 1975 y de 1976).
// Sin ellos la promoción los funde en un disco. Lo genera
// scripts/split-sincopa-mixed-albums.ts --write-overrides (decisión de Brian, 2026-10-03).
export const SINCOPA_IDENTITY_SUFFIX: Readonly<Record<string, string>> = {
${body}
};
`);
}

/**
 * Tras reingerir las páginas a separar con el adapter 1.3.2 (identidad con
 * sufijo): crea el disco de cada página, le mueve las pistas y créditos de disco
 * que solo esa página sostiene (nunca de un disco del canal) y retira los claims
 * viejos de la página (candidatos → rejected, aceptados → superseded). Las
 * pistas y créditos nuevos los promueve después la pasada normal.
 */
async function apply(file: string, confirm: boolean, note: string): Promise<void> {
  const pool = getPool();
  const albums = JSON.parse(readFileSync(file, "utf8")) as AlbumPlan[];
  const work: Array<{ album: AlbumPlan; page: PagePlan; key: string; artistName: string; tracks: number[]; credits: number[] }> = [];
  for (const album of albums) {
    for (const page of album.pages.filter((item) => item.role === "separar")) {
      const { rows: [identity] } = await pool.query<{ identity_key: string; identity_raw: string }>(`
        SELECT identity_key, identity_raw FROM ingest.claims
         WHERE source_id = 7 AND raw_page_id = $1 AND entity_kind = 'album' AND status = 'candidate' AND identity_raw LIKE $2
         LIMIT 1`, [page.pageId, `%(${page.suffix})`]);
      if (identity === undefined) { console.error("sin claims nuevos (¿falta reingerir?)", page.url); continue; }
      // Lo que solo sostiene esta página: todos sus claims aceptados vienen de ella.
      const { rows: tracks } = await pool.query<{ id: string }>(`
        SELECT t.id::text FROM public.tracks t
         WHERE t.album_id = $1
           AND EXISTS (SELECT 1 FROM ingest.claims c WHERE c.track_id = t.id AND c.status = 'accepted' AND c.raw_page_id = $2)
           AND NOT EXISTS (SELECT 1 FROM ingest.claims c WHERE c.track_id = t.id AND c.status = 'accepted' AND c.raw_page_id IS DISTINCT FROM $2)`,
        [album.albumId, page.pageId]);
      const { rows: credits } = await pool.query<{ id: string }>(`
        SELECT r.id::text FROM public.album_credits r
         WHERE r.album_id = $1
           AND EXISTS (SELECT 1 FROM ingest.claims c WHERE c.album_credit_id = r.id AND c.status = 'accepted' AND c.raw_page_id = $2)
           AND NOT EXISTS (SELECT 1 FROM ingest.claims c WHERE c.album_credit_id = r.id AND c.status = 'accepted' AND c.raw_page_id IS DISTINCT FROM $2)`,
        [album.albumId, page.pageId]);
      work.push({ album, page, key: identity.identity_key, artistName: identity.identity_raw,
        tracks: album.channel ? [] : tracks.map((row) => Number(row.id)), credits: album.channel ? [] : credits.map((row) => Number(row.id)) });
    }
  }
  const summary = { pages: work.length, tracksToMove: work.reduce((sum, item) => sum + item.tracks.length, 0), creditsToMove: work.reduce((sum, item) => sum + item.credits.length, 0) };
  console.log(JSON.stringify({ dryRun: !confirm, ...summary }, null, 2));
  if (!confirm) { await closeDb(); return; }

  // 1) Discos nuevos: la identidad con sufijo, aprobada como distinta del disco mezclado.
  const { getDb } = await import("../src/db/client.js");
  const { withRunScope } = await import("../src/db/run-binding.js");
  const { scrapeRuns } = await import("../src/db/schema/ingest.js");
  const { finishRun } = await import("../src/ingest/runs.js");
  const { approveEntity } = await import("../src/review/approval.js");
  const { createRelation, deleteRelation, updateEntity, withOperatorRun } = await import("../src/merge/operator.js");
  const [run] = await getDb().insert(scrapeRuns).values({ kind: "merge_run", status: "running", params: { action: "split-sincopa-mixed-albums", note } }).returning();
  if (!run) throw new Error("no se pudo abrir el run");
  const created = new Map<number, number>();
  await withRunScope(run.id, async () => {
    for (const item of work) {
      const reference = `${item.page.why} (split-sincopa-mixed-albums, run ${run.id})`;
      try {
        // La reingesta engancha los claims nuevos de la página al disco que ya
        // sostenía (run 11723): sin soltarlos, la aprobación los heredaría y
        // pisaría el disco viejo en vez de crear el suyo (runs 11724–11725, deshechos).
        await pool.query(`UPDATE ingest.claims SET album_id = NULL, updated_at = now()
          WHERE source_id = 7 AND entity_kind = 'album' AND identity_key = $1 AND status = 'candidate' AND album_id = $2`, [item.key, item.album.albumId]);
        const result = await approveEntity("album", item.key, `[run ${run.id}] ${note} · ${item.page.url}`, {
          humanResolution: { verdict: "different", decidedBy: "brian", reference },
          ...(item.album.artistId === null ? {} : { parentArtistId: item.album.artistId }),
        });
        if (result.targetId === item.album.albumId) console.error("disco: volvió al disco mezclado, se deja", item.page.url);
        else if (result.targetId !== undefined) created.set(item.page.pageId, result.targetId);
      } catch (error) {
        console.error("disco", item.page.url, (error as Error).message);
      }
    }
  });
  await finishRun(run.id, created.size === work.length ? "ok" : "partial", { albums: created.size });

  // 2) Pistas y créditos de disco que solo sostiene la página; 3) claims viejos de la página.
  const moved = await withOperatorRun({ name: "split-sincopa-mixed-albums:move", operator: "brian", note, params: { from: file, albumsRun: run.id } }, async (context) => {
    const done = { tracks: 0, credits: 0, failed: 0, rejected: 0, superseded: 0 };
    const reason = `[run ${context.runId}] ${note}`;
    for (const item of work) {
      const target = created.get(item.page.pageId);
      if (target === undefined) continue;
      for (const trackId of item.tracks) {
        await context.client.query("SAVEPOINT split");
        try {
          await updateEntity(context, "track", trackId, {}, { parentId: target });
          done.tracks += 1;
          await context.client.query("RELEASE SAVEPOINT split");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT split");
          done.failed += 1;
          console.error("pista", trackId, (error as Error).message);
        }
      }
      for (const creditId of item.credits) {
        await context.client.query("SAVEPOINT split");
        try {
          const { rows: [credit] } = await context.client.query<{ person_id: string | null; artist_id: string | null; organization_id: string | null; credit_type: string; role: string | null }>(
            "SELECT person_id::text, artist_id::text, organization_id::text, credit_type::text, role FROM public.album_credits WHERE id = $1", [creditId]);
          if (credit === undefined) throw new Error("crédito desaparecido");
          await createRelation(context, "album_credit", {
            albumId: target,
            ...(credit.person_id === null ? {} : { personId: Number(credit.person_id) }),
            ...(credit.artist_id === null ? {} : { artistId: Number(credit.artist_id) }),
            ...(credit.organization_id === null ? {} : { organizationId: Number(credit.organization_id) }),
          }, { credit_type: credit.credit_type, credit_role: credit.role ?? undefined });
          await deleteRelation(context, "album_credit", creditId);
          done.credits += 1;
          await context.client.query("RELEASE SAVEPOINT split");
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT split");
          done.failed += 1;
          console.error("crédito", creditId, (error as Error).message);
        }
      }
      // Claims viejos: los de identidad sin sufijo de disco, pista y créditos de esta página.
      const fresh = `%(${item.page.suffix})%`;
      const { rowCount: rejected } = await context.client.query(`
        UPDATE ingest.claims SET status = 'rejected', notes = $3, updated_at = now()
         WHERE source_id = 7 AND raw_page_id = $1 AND entity_kind IN ('album','track','track_credit','album_credit')
           AND status = 'candidate' AND identity_raw NOT LIKE $2`,
        [item.page.pageId, fresh, `${reason}: identidad sin el sufijo «(${item.page.suffix})»; la reemplaza la de la reingesta`]);
      const { rowCount: superseded } = await context.client.query(`
        UPDATE ingest.claims SET status = 'superseded', notes = $3, updated_at = now()
         WHERE source_id = 7 AND raw_page_id = $1 AND entity_kind IN ('album','track','track_credit','album_credit')
           AND status = 'accepted' AND identity_raw NOT LIKE $2`,
        [item.page.pageId, fresh, `${reason}: disco separado de ${item.album.albumId} → ${target}; lo sostiene la identidad «(${item.page.suffix})»`]);
      done.rejected += rejected ?? 0;
      done.superseded += superseded ?? 0;
    }
    return done;
  });
  console.log(JSON.stringify({ albumsRun: run.id, albumsCreated: created.size, ...moved }, null, 2));
  writeFileSync(arg("out") ?? "reports/sincopa-discos-mezclados-aplicado-2026-10-03.json",
    `${JSON.stringify({ albumsRun: run.id, created: Object.fromEntries(created), ...moved, work: work.map((item) => ({ albumId: item.album.albumId, url: item.page.url, suffix: item.page.suffix, newAlbum: created.get(item.page.pageId), tracks: item.tracks, credits: item.credits })) }, null, 2)}\n`);
  await closeDb();
}

async function main(): Promise<void> {
  const applyFile = arg("apply");
  if (applyFile !== undefined) {
    await apply(applyFile, process.argv.includes("--confirm"), arg("note") ?? "Sincopa: disco distinto con el mismo título del mismo artista, separado del disco mezclado (decisión de Brian 2026-10-03)");
    return;
  }
  if (process.argv.includes("--plan")) {
    const albums = await plan();
    const count = (role: PagePlan["role"]) => albums.reduce((sum, album) => sum + album.pages.filter((page) => page.role === role).length, 0);
    const out = arg("out");
    if (out) writeFileSync(out, `${JSON.stringify(albums, null, 2)}\n`);
    if (process.argv.includes("--write-overrides")) writeOverrides(albums);
    console.log(JSON.stringify({ albums: albums.length, channel: albums.filter((album) => album.channel).length,
      dueñas: count("dueña"), ediciones: count("edición"), separar: count("separar"), retener: count("retener") }, null, 2));
  }
  await closeDb();
}

await main();
