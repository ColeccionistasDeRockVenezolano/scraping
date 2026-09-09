// CRV · CLI (ARCHITECTURE.md §4.13). Se invoca vía `tsx` (ver package.json:
// scripts "cli"/"doctor"/"db:migrate"), no como binario ejecutable directo.
// Mismos casos de uso que la futura API,
// sin UI. Comandos se añaden fase a fase; los no implementados todavía
// devuelven un mensaje explícito en vez de fallar en silencio.
import { runDoctor } from "../doctor/index.js";
import { migrateUp, migrateDownAll } from "../db/migrate.js";
import { closeDb } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { seedSources, listSources, proposeSource, LINKS_XLSX_PATH } from "../ingest/sources.js";
import { runObserve } from "../fetcher/observe.js";
import { assertSupportedNode } from "../config/runtime.js";
import { listRuns, createArtistEnrichmentRun, finishRun } from "../ingest/runs.js";
import { listReviews, showReview } from "../review/queue.js";
import { approveEntity, dismissEntity, pendingEntities } from "../review/approval.js";
import { planBatch, runBatch, BATCH_ORDER } from "../review/batch.js";
import { getDb } from "../db/client.js";
import { sources } from "../db/schema/ingest.js";
import { eq } from "drizzle-orm";
import { adapterFor, adapterRegistrationFor } from "../adapters/registry.js";
import { ingestStoredAdapterSource } from "../ingest/runner.js";
import { registerManualEvidence } from "../ingest/manual-evidence.js";
import { discoverChannelUploads, hydrateYouTubeVideos, importYouTubeMasterSheet, knownYouTubeVideoIds, syncYouTubeChannel, syncYouTubeVideo, unmatchedYouTubeRows } from "../youtube/pipeline.js";
import { ingestSeedClaims } from "../youtube/seed-claims.js";
import { YT_MASTER_XLSX_PATH } from "../ingest/sources.js";
import { getPool } from "../db/client.js";

const log = moduleLogger("cli");

const KNOWN_SITE_TYPES = ["blogspot", "wordpress", "website", "database", "instagram", "spreadsheet", "youtube_api"] as const;

const KNOWN_FUTURE_COMMANDS = new Set([
  "seed:import-yt", "yt:sync",
  "yt:link", "yt:enrich", "merge:run", "review:list", "review:approve",
  "review:dismiss", "genre:add", "genre:disable", "export:json",
]);

async function main(): Promise<number> {
  // Falla ruidoso si el runtime no cumple engines.node (PHASES F0).
  assertSupportedNode();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "doctor": {
      const report = await runDoctor();
      const MARK = { ok: "\u2713", warn: "!", fail: "\u2717" } as const;
      for (const check of report.checks) {
        // eslint-disable-next-line no-console
        console.log(`  ${MARK[check.status]} ${check.name}: ${check.detail}`);
      }
      const summary = !report.ok
        ? "doctor: HAY PROBLEMAS"
        : report.warnings > 0
          ? `doctor: VERDE CON ${report.warnings} AVISO(S)`
          : "doctor: TODO VERDE";
      // eslint-disable-next-line no-console
      console.log(summary);
      return report.ok ? 0 : 1;
    }

    case "db:migrate": {
      const mode = args[0] === "down" ? "down" : "up";
      const result = mode === "down" ? await migrateDownAll() : await migrateUp();
      log.info(result, mode === "down" ? "rollback completo" : "migración completa");
      return 0;
    }

    case "sources:seed": {
      const result = await seedSources(LINKS_XLSX_PATH);
      // eslint-disable-next-line no-console
      console.log(`ingest.sources: ${result.inserted} insertadas, ${result.updated} actualizadas`);
      return 0;
    }

    case "sources:list":
    case "sources": {
      if (cmd === "sources" && args[0] !== "list") {
        // eslint-disable-next-line no-console
        console.error("uso: crv sources list");
        return 1;
      }
      const rows = await listSources();
      for (const r of rows) {
        const registration = adapterRegistrationFor(r);
        const capability = registration ? `${registration.status}/${registration.mode}/${registration.automation}` : "sin-adapter";
        // eslint-disable-next-line no-console
        console.log(`  [${r.enabled ? "✓" : "✗"}] ${r.slug.padEnd(32)} ${r.siteType.padEnd(10)} trust=${r.trustLevel} adapter=${capability}`);
      }
      // eslint-disable-next-line no-console
      console.log(`${rows.length} fuentes registradas`);
      return 0;
    }

    case "sources:evidence": {
      const [slug, evidenceUrl, excerpt, ...notes] = args;
      if (!slug || !evidenceUrl || !excerpt) {
        console.error('uso: sources:evidence <slug> <url> "<extracto>" [notas...]');
        return 1;
      }
      const result = await registerManualEvidence(slug, {
        evidenceUrl,
        excerpt,
        ...(notes.length > 0 ? { notes: notes.join(" ") } : {}),
      });
      console.log(`evidencia manual registrada: source=${slug}, run=${result.runId}, review=${result.reviewId}, sha256=${result.evidenceHash}`);
      return 0;
    }

    case "sources:add": {
      const [name, url, siteType, ...justificationParts] = args;
      if (!name || !url || !siteType || justificationParts.length === 0) {
        // eslint-disable-next-line no-console
        console.error(`uso: sources:add "<nombre>" <url> <site_type> <justificación...>\n  site_type ∈ ${KNOWN_SITE_TYPES.join(", ")}`);
        return 1;
      }
      if (!(KNOWN_SITE_TYPES as readonly string[]).includes(siteType)) {
        // eslint-disable-next-line no-console
        console.error(`site_type inválido: "${siteType}". Debe ser uno de: ${KNOWN_SITE_TYPES.join(", ")}`);
        return 1;
      }
      const result = await proposeSource({
        name, url, siteType: siteType as (typeof KNOWN_SITE_TYPES)[number],
        justification: justificationParts.join(" "),
      });
      // eslint-disable-next-line no-console
      console.log(
        `Fuente propuesta con enabled=false (source id ${result.sourceId}). ` +
        `Ítem de revisión creado (review id ${result.reviewId}, kind=new_source). ` +
        "Requiere aprobación manual antes de habilitarla (SOURCES.md §6).",
      );
      return 0;
    }

    case "runs": {
      if (args[0] !== "list") { console.error("uso: crv runs list"); return 1; }
      for (const run of await listRuns()) console.log(`${run.id}\t${run.kind}\t${run.status}\t${run.startedAt.toISOString()}`);
      return 0;
    }

    case "review": {
      if (args[0] === "list") {
        for (const review of await listReviews()) console.log(`${review.id}\t${review.kind}\tpriority=${review.priority}\t${review.status}`);
        return 0;
      }
      if (args[0] === "show" && /^\d+$/.test(args[1] ?? "")) {
        const review = await showReview(Number(args[1]));
        if (!review) { console.error(`review inexistente: ${args[1]}`); return 1; }
        console.log(JSON.stringify(review, null, 2));
        return 0;
      }
      // La cola guarda un ítem por claim, pero se decide por entidad: aprobar
      // "Los Kings" cubre su nombre, año de formación, origen y género juntos.
      if (args[0] === "entities") {
        const kind = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
        const limitArg = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
        const pending = await pendingEntities({
          ...(kind ? { entityKind: kind } : {}),
          ...(limitArg && /^\d+$/.test(limitArg) ? { limit: Number(limitArg) } : {}),
        });
        for (const item of pending) {
          console.log(`${item.entityKind}\t${item.claims} claims\t${item.sources} fuente(s)\t${item.identityRaw}\t[${item.fields.join(",")}]`);
        }
        if (pending.length === 0) console.log("(sin entidades candidatas)");
        return 0;
      }
      // Un lote es UNA decisión humana sobre un conjunto, no una vía nueva al
      // core: sin --confirm solo imprime el plan, y con él llama a la misma
      // approveEntity de siempre.
      if (args[0] === "approve-batch" || args[0] === "dismiss-batch") {
        const action = args[0] === "approve-batch" ? "approve" : "dismiss";
        const kind = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
        const opt = (name: string): string | undefined =>
          args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
        const limitArg = opt("limit");
        const filter = {
          ...(kind ? { entityKind: kind } : {}),
          ...(opt("source") ? { sourceSlug: opt("source") as string } : {}),
          ...(limitArg && /^\d+$/.test(limitArg) ? { limitPerKind: Number(limitArg) } : {}),
        };
        const plan = await planBatch(filter);
        for (const item of plan.items) {
          console.log(`${item.entityKind}\t${item.entities} entidades\t${item.claims} claims\t${item.samples.join(" · ")}`);
        }
        console.log(`TOTAL: ${plan.totalEntities} entidades, ${plan.totalClaims} claims (orden: ${BATCH_ORDER.join(" → ")})`);
        if (plan.totalEntities === 0) return 0;
        const note = opt("note");
        if (!args.includes("--confirm") || !note) {
          console.log(`\n(previsualización) para ejecutar: crv review ${args[0]}${kind ? " " + kind : ""} --note="<motivo>" --confirm`);
          return 0;
        }
        const result = await runBatch(action, filter, note);
        console.log(JSON.stringify(result, null, 2));
        return result.failed === 0 ? 0 : 1;
      }
      if (args[0] === "approve" || args[0] === "dismiss") {
        const [, kind, identity, ...noteParts] = args;
        const note = noteParts.join(" ");
        if (!kind || !identity || !note) {
          console.error(`uso: crv review ${args[0]} <entity_kind> "<identity_key>" <nota...>`);
          return 1;
        }
        const result = args[0] === "approve"
          ? await approveEntity(kind, identity, note)
          : await dismissEntity(kind, identity, note);
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.error('uso: crv review list | show <id> | entities [kind] [--limit=N] | approve <kind> "<identity>" <nota> | dismiss <kind> "<identity>" <nota> | approve-batch [kind] [--source=<slug>] [--limit=N] --note="<motivo>" --confirm | dismiss-batch [...]');
      return 1;
    }

    case "scrape": {
      // API pública mínima aprobada: `scrape source <source> --all` y
      // `scrape artist "<name>" --all-sources`. Se conserva el alias F1.
      if (args[0] === "source") {
        const slug = args[1];
        const dryRun = args.includes("--dry-run");
        if (!slug || !args.includes("--all")) { console.error("uso: crv scrape source <source> --all [--dry-run]"); return 1; }
        const [source] = await getDb().select().from(sources).where(eq(sources.slug, slug));
        if (!source) { console.error(`fuente desconocida: ${slug}`); return 1; }
        const adapter = adapterFor(source);
        if (!adapter) {
          const registration = adapterRegistrationFor(source);
          console.error(registration?.status === "limited"
            ? `la fuente ${slug} está ${registration.status}/${registration.mode}/${registration.automation}: ${registration.reason}`
            : `la fuente ${slug} no tiene adapter HTTP automatizado autorizado`);
          return 1;
        }
        if (dryRun) {
          const parsed = await ingestStoredAdapterSource(slug, adapter, { confidence: "low", dryRun: true });
          console.log(JSON.stringify({ dryRun: true, source: slug, adapter: adapter.slug, claims: parsed.plan, merges: [] }, null, 2));
          return 0;
        }
        const observed = await runObserve(slug);
        // Todos los adapters web entran primero como candidatos low: preservan
        // evidencia y evitan cualquier alta/duplicado en el catálogo canónico.
        const parsed = await ingestStoredAdapterSource(slug, adapter, { confidence: "low" });
        console.log(`scrape source ${slug}: ${observed.fetched} descargadas, ${observed.cached} desde caché, ${observed.errors} errores${observed.limited ? "; límite de crawl alcanzado" : ""}; adapter=${adapter.slug}, claims=${parsed.claimsInserted} nuevas/${parsed.claimsReused} reutilizadas (candidatas, sin mutar core)`);
        return observed.errors > 0 ? 1 : 0;
      }
      if (args[0] === "artist") {
        const artist = args[1];
        const dryRun = args.includes("--dry-run");
        if (!artist || !args.includes("--all-sources")) { console.error('uso: crv scrape artist "<name>" --all-sources [--dry-run]'); return 1; }
        const enabled = (await listSources()).filter((s) => s.enabled);
        if (dryRun) { console.log(JSON.stringify({ dryRun: true, artist, sources: enabled.map((s) => s.slug), claims: [], merges: [] }, null, 2)); return 0; }
        const run = await createArtistEnrichmentRun(artist);
        let errors = 0;
        for (const source of enabled) {
          const adapter = adapterFor(source);
          if (!adapter) continue; // spreadsheet/API tienen flujos propios, nunca se fingen como HTTP.
          try { await runObserve(source.slug); } catch (error) { errors += 1; log.error({ source: source.slug, error }, "falló enriquecimiento dirigido"); }
        }
        await finishRun(run.id, errors > 0 ? "partial" : "ok", { artist, sources: enabled.length, errors });
        console.log(`scrape artist ${artist}: run=${run.id}, errores=${errors}; sin claims semánticos hasta conectar adapters caracterizados`);
        return errors > 0 ? 1 : 0;
      }
      const slug = args[0];
      const observe = args.includes("--observe");
      if (!slug) {
        // eslint-disable-next-line no-console
        console.error('uso: scrape <slug> --observe   (solo modo observación implementado: descarga + almacenamiento crudo, sin extracción)');
        return 1;
      }
      if (!observe) {
        // eslint-disable-next-line no-console
        console.log("solo --observe está implementado en esta fase (F1); la extracción llega en F4.");
        return 1;
      }
      const result = await runObserve(slug);
      // eslint-disable-next-line no-console
      console.log(`scrape --observe ${slug}: ${result.fetched} descargadas, ${result.cached} desde caché, ${result.errors} errores`);
      return result.errors > 0 ? 1 : 0;
    }

    case "youtube": {
      const [subcommand, argument] = args;
      if (subcommand === "import-sheet") {
        const result = await importYouTubeMasterSheet(argument ?? YT_MASTER_XLSX_PATH);
        console.log(`youtube import-sheet: ${result.inserted} nuevas, ${result.updated} actualizadas, ${result.unchanged} sin cambios; ${result.videos} videos, ${result.reviews} reviews`);
        return 0;
      }
      if (subcommand === "sync-video") {
        if (!argument) { console.error("uso: crv youtube sync-video <video-id>"); return 1; }
        const result = await syncYouTubeVideo(argument);
        console.log(`youtube sync-video ${result.videoId}: ${result.synced ? "sincronizado" : "no encontrado por la API"}`);
        return result.synced ? 0 : 1;
      }
      // Paso 2: hidrata la unión de la hoja y el canal en lotes de 50.
      if (subcommand === "sync") {
        const ids = await knownYouTubeVideoIds({ pendingOnly: args.includes("--pending") });
        if (!ids.length) { console.log("youtube sync: nada que hidratar"); return 0; }
        const result = await hydrateYouTubeVideos(ids);
        console.log(`youtube sync (run ${result.runId}): ${result.requested} IDs pedidos en ${result.batches} lotes, `
          + `${result.hydrated} hidratados, ${result.missing.length} sin respuesta, ${result.errors} lotes con error`);
        if (result.missing.length) console.log(`  sin respuesta de la API (borrados o privados): ${result.missing.join(", ")}`);
        return result.errors > 0 ? 1 : 0;
      }
      // Descubrimiento sin hidratación: qué videos hay, no qué dice cada uno.
      if (subcommand === "discover-channel") {
        const channelId = argument && !argument.startsWith("--")
          ? argument
          : (await getPool().query<{ channel_id: string }>("SELECT channel_id FROM media.youtube_channels ORDER BY id LIMIT 1")).rows[0]?.channel_id
            ?? (await getPool().query<{ channel_id: string }>("SELECT DISTINCT channel_id FROM media.youtube_videos WHERE channel_id IS NOT NULL LIMIT 1")).rows[0]?.channel_id;
        if (!channelId) { console.error("uso: crv youtube discover-channel <channel-id> [--resume]"); return 1; }
        const result = await discoverChannelUploads(channelId, { resume: args.includes("--resume") });
        console.log(`youtube discover-channel ${result.channelId} (run ${result.runId}, ${result.status}): `
          + `${result.pages} páginas, ${result.items} entradas, ${result.inserted} nuevas, ${result.updated} revisitadas, `
          + `${result.errors} incidencias; el canal declara ${result.declaredVideoCount ?? "?"} videos públicos`);
        return result.status === "ok" ? 0 : 1;
      }
      if (subcommand === "sync-channel") {
        const channelIds = argument ? [argument] : (await getPool().query<{ channel_id: string }>("SELECT DISTINCT channel_id FROM media.youtube_videos WHERE channel_id IS NOT NULL")).rows.map((row) => row.channel_id);
        if (!channelIds.length) { console.error("uso: crv youtube sync-channel <channel-id> (o importe/sincronice primero un video con canal conocido)"); return 1; }
        for (const channelId of channelIds) {
          const result = await syncYouTubeChannel(channelId);
          console.log(`youtube sync-channel ${result.channelId}: ${result.uploads} uploads descubiertos, ${result.syncedVideos} metadatos sincronizados`
            + (result.missing.length ? `, ${result.missing.length} sin respuesta de la API (borrados o privados): ${result.missing.join(", ")}` : ""));
        }
        return 0;
      }
      // La hoja no es una lista de videos: es una discografía escrita a mano.
      // `seed-claims` la mete por la puerta normal (claims candidatos), que se
      // aprueban después con `review approve-batch --source=yt-master-seed`.
      if (subcommand === "seed-claims") {
        const result = await ingestSeedClaims(args.includes("--dry-run") ? { dryRun: true } : {});
        console.log(`youtube seed-claims: ${result.rows} filas -> ${result.artists} artistas, ${result.albums} discos `
          + `(${result.mediaOnly} audiovisuales sin disco, ${result.albumsSinTipo} sin tipo, ${result.skipped} sin identidad); `
          + `${result.claimsInserted} claims nuevos, ${result.claimsReused} reusados`);
        return 0;
      }
      if (subcommand === "unmatched") {
        const rows = await unmatchedYouTubeRows();
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      console.error("uso: crv youtube import-sheet <path> | seed-claims [--dry-run] | discover-channel [channel-id] [--resume] | sync [--pending] | sync-video <video-id> | sync-channel [channel-id] | unmatched");
      return 1;
    }

    case undefined:
    case "help":
    case "--help":
      printHelp();
      return 0;

    default:
      if (KNOWN_FUTURE_COMMANDS.has(cmd)) {
        // eslint-disable-next-line no-console
        console.log(`"${cmd}" está especificado en ARCHITECTURE.md §4 pero aún no implementado (ver PHASES.md).`);
        return 1;
      }
      // eslint-disable-next-line no-console
      console.error(`comando desconocido: "${cmd}"`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
CRV CLI

  doctor              integridad: core (hash+catálogo), schemas aux, migraciones, fuentes
  db:migrate [down]   aplica migrations/*.up.sql pendientes (o revierte todo con "down")
  sources:seed        siembra las 11 fuentes del XLSX + YouTube Data API + 2 seeds internos
  sources:list        lista ingest.sources (slug, tipo, confianza, enabled)
  sources:add "<nombre>" <url> <site_type> <justificación>
                      propone una fuente NUEVA: enabled=false + review(new_source);
                      nunca la habilita directo (requiere aprobación manual, SOURCES.md §6)
  scrape <slug> --observe   descarga + cachea crudo de una fuente habilitada (sin extracción)
  scrape source <source> --all [--dry-run]
  scrape artist "<name>" --all-sources [--dry-run]
  sources list | runs list | review list | review show <id>
  youtube import-sheet <path>  importa YT Master Spreadsheet de forma idempotente
  youtube discover-channel [channel-id] [--resume]  recorre el playlist de uploads sin hidratar
  youtube sync [--pending]     hidrata la unión de hoja y canal en lotes de 50
  youtube sync-video <video-id>  consulta YouTube Data API (requiere YOUTUBE_API_KEY)
  youtube sync-channel [channel-id]  recorre uploads playlist oficial (requiere YOUTUBE_API_KEY)
  youtube unmatched          filas seed pendientes de enlace o revisión

Comandos especificados para fases futuras (F1+): ${[...KNOWN_FUTURE_COMMANDS].join(", ")}
`);
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    log.error({ err }, "fallo en CLI");
    await closeDb();
    process.exitCode = 1;
  });
