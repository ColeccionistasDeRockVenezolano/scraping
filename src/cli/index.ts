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
import { applyReviewDecisions, planReviewDecisions } from "../review/decisions.js";
import { findDuplicateGroups, mergeAllDuplicates } from "../review/duplicates.js";
import { applyPersonCorrections, loadPersonCorrectionPlan } from "../review/person-corrections.js";
import { findPersonCandidates, openPersonCandidateReviews, PERSON_CANDIDATE_MIN_SCORE } from "../review/person-candidates.js";
import { findOrganizationCandidates, openOrganizationCandidateReviews } from "../review/organization-candidates.js";
import { getDb } from "../db/client.js";
import { sources } from "../db/schema/ingest.js";
import { eq } from "drizzle-orm";
import { adapterFor, adapterRegistrationFor } from "../adapters/registry.js";
import { ingestStoredAdapterSource } from "../ingest/runner.js";
import { registerManualEvidence } from "../ingest/manual-evidence.js";
import { discoverChannelUploads, hydrateYouTubeVideos, importYouTubeMasterSheet, knownYouTubeVideoIds, rederiveYouTubeDescriptions, syncYouTubeChannel, syncYouTubeVideo, unmatchedYouTubeRows } from "../youtube/pipeline.js";
import { ingestSeedClaims } from "../youtube/seed-claims.js";
import { syncAlbumClassifications } from "../youtube/classifications.js";
import { ingestYouTubeApiClaims } from "../youtube/api-claims.js";
import { confirmYouTubeAlbumLink, linkYouTubeAlbums } from "../youtube/linker.js";
import { enrichArtistFromYouTube } from "../youtube/enrich.js";
import { reconcileYouTubeChannel } from "../youtube/reconcile.js";
import { YT_MASTER_XLSX_PATH } from "../ingest/sources.js";
import { getPool } from "../db/client.js";
import { keepRepeatedTrackOccurrences } from "../merge/engine.js";
import { scanAmbiguities } from "../ambiguity/scan.js";
import { resolveAmbiguities } from "../ambiguity/resolve.js";
import { applyAmbiguityResolutions, describeApply } from "../ambiguity/apply.js";
import { DeepSeekArbiter, FileArbiter, type Arbiter } from "../ambiguity/arbiter.js";
import { createDeepSeekGateway } from "../ai/gateway.js";
import { getEnv } from "../config/env.js";
import { applySincopaOrganizationRepair, planSincopaOrganizationRepair } from "../review/sincopa-organizations.js";
import { runCurationScan } from "../curation/scan.js";
import { getCurationSummary } from "../curation/repository.js";
import { pruneCuration } from "../curation/retention.js";

/** `--review=1,2,3` → ids; undefined si no vino; null si vino mal escrito. */
function parseIdList(value: string | undefined): number[] | undefined | null {
  if (value === undefined) return undefined;
  const ids = value.split(",").filter(Boolean).map(Number);
  return ids.length && ids.every((id) => Number.isSafeInteger(id) && id > 0) ? ids : null;
}

const log = moduleLogger("cli");

const KNOWN_SITE_TYPES = ["blogspot", "wordpress", "website", "database", "instagram", "spreadsheet", "youtube_api"] as const;

// Nombres de ARCHITECTURE.md §4.13 que el proyecto implementó con otra forma:
// quien los escriba recibe el comando real en lugar de "no implementado".
const RENAMED_COMMANDS = new Map([
  ["seed:import-yt", "youtube import-sheet <path> && crv youtube seed-claims"],
  ["yt:sync", "youtube sync [--pending]"],
  ["merge:run", "scrape source <slug> --all (el merge corre dentro de cada ingesta)"],
  ["review:list", "review list"],
  ["review:approve", "review approve <id>"],
  ["review:dismiss", "review dismiss <id>"],
]);

// Especificados en ARCHITECTURE.md §4.13 y todavía sin implementar.
const KNOWN_FUTURE_COMMANDS = new Set(["genre:add", "genre:disable", "export:json"]);

async function main(): Promise<number> {
  // Falla ruidoso si el runtime no cumple engines.node (PHASES F0).
  assertSupportedNode();
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "doctor": {
      const report = await runDoctor();
      const MARK = { ok: "\u2713", warn: "!", fail: "\u2717" } as const;
      for (const check of report.checks) {
        console.log(`  ${MARK[check.status]} ${check.name}: ${check.detail}`);
      }
      const summary = !report.ok
        ? "doctor: HAY PROBLEMAS"
        : report.warnings > 0
          ? `doctor: VERDE CON ${report.warnings} AVISO(S)`
          : "doctor: TODO VERDE";
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
      console.log(`ingest.sources: ${result.inserted} insertadas, ${result.updated} actualizadas`);
      return 0;
    }

    case "sources:list":
    case "sources": {
      if (cmd === "sources" && args[0] !== "list") {
        console.error("uso: crv sources list");
        return 1;
      }
      const rows = await listSources();
      for (const r of rows) {
        const registration = adapterRegistrationFor(r);
        const capability = registration ? `${registration.status}/${registration.mode}/${registration.automation}` : "sin-adapter";
        console.log(`  [${r.enabled ? "✓" : "✗"}] ${r.slug.padEnd(32)} ${r.siteType.padEnd(10)} trust=${r.trustLevel} adapter=${capability}`);
      }
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
        console.error(`uso: sources:add "<nombre>" <url> <site_type> <justificación...>\n  site_type ∈ ${KNOWN_SITE_TYPES.join(", ")}`);
        return 1;
      }
      if (!(KNOWN_SITE_TYPES as readonly string[]).includes(siteType)) {
        console.error(`site_type inválido: "${siteType}". Debe ser uno de: ${KNOWN_SITE_TYPES.join(", ")}`);
        return 1;
      }
      const result = await proposeSource({
        name, url, siteType: siteType as (typeof KNOWN_SITE_TYPES)[number],
        justification: justificationParts.join(" "),
      });
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
      if (args[0] === "apply-decisions") {
        const note = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        const plan = await planReviewDecisions();
        console.log(JSON.stringify(plan, null, 2));
        if (!args.includes("--confirm")) {
          console.log('\n(previsualización) para ejecutar: crv review apply-decisions --note="<motivo>" --confirm');
          return 0;
        }
        if (!note?.trim()) {
          console.error("--note es obligatorio al confirmar");
          return 1;
        }
        const result = await applyReviewDecisions(note);
        console.log(JSON.stringify(result, null, 2));
        return result.failed === 0 ? 0 : 1;
      }
      // Filas del core que son la misma entidad escrita con otra tilde o
      // mayúscula. Sin --confirm solo lista; con él fusiona y audita.
      if (args[0] === "duplicates") {
        const note = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        const scan = await findDuplicateGroups();
        for (const group of scan.groups) {
          console.log(`${group.kind}\tconserva ${group.keepId}\tfusiona ${group.dropIds.join(",")}\t${group.artist ? `${group.artist} — ` : ""}${group.names.join(" | ")}`);
        }
        for (const item of scan.skipped) console.log(`(no se toca) ${item.kind} ${item.ids.join(",")}\t${item.names.join(" | ")}\t${item.reason}`);
        console.log(`TOTAL: ${scan.groups.length} grupos, ${scan.skipped.length} descartados`);
        if (!args.includes("--confirm") || !note?.trim()) {
          console.log('\n(previsualización) para ejecutar: crv review duplicates --note="<motivo>" --confirm');
          return 0;
        }
        const result = await mergeAllDuplicates(note);
        console.log(JSON.stringify(result, null, 2));
        return result.failed.length === 0 ? 0 : 1;
      }
      // Candidatos de duplicado de persona: propone pares explicables (apodo
      // con y sin comillas, alias cruzados, nombre con contexto) y los deja en
      // la cola. No fusiona nada: decide una persona.
      if (args[0] === "person-candidates") {
        const note = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        const minScoreRaw = args.find((arg) => arg.startsWith("--min-score="))?.slice("--min-score=".length);
        const limitRaw = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
        const minScore = minScoreRaw === undefined ? PERSON_CANDIDATE_MIN_SCORE : Number(minScoreRaw);
        const limit = limitRaw === undefined ? undefined : Number(limitRaw);
        if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1
          || (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))) {
          console.error('uso: crv review person-candidates [--min-score=0.45] [--limit=200] [--note="<motivo>" --confirm]');
          return 1;
        }
        const scan = await findPersonCandidates({ minScore, ...(limit === undefined ? {} : { limit }) });
        for (const candidate of scan.candidates) {
          const features = candidate.features.map((feature) => `${feature.key}=${feature.value}`).join(", ");
          console.log(`${candidate.score.toFixed(3)}\tprioridad ${candidate.priority}\t${candidate.a.id} «${candidate.a.name}» / ${candidate.b.id} «${candidate.b.name}»\t${features}`);
        }
        console.log(`TOTAL: ${scan.candidates.length} pares propuestos entre ${scan.persons} personas (${scan.comparedPairs} pares comparados)`);
        if (!args.includes("--confirm") || !note?.trim()) {
          console.log('\n(previsualización: nada se escribió) para abrir las revisiones: crv review person-candidates --note="<motivo>" --confirm');
          return 0;
        }
        const result = await openPersonCandidateReviews(scan.candidates, note, getEnv().CRV_OPERATOR_NAME);
        console.log(`run ${result.runId}: ${result.opened} ${result.opened === 1 ? "revisión abierta" : "revisiones abiertas"}, ${result.skipped} ya existían`);
        return 0;
      }

      // Candidatos de duplicado de organización (E11.10): mismo bloqueo y
      // puntuación explicable, con las palabras de estudio quitadas de la clave
      // («Estudio Uno» y «Uno» son la misma). También propone, nunca fusiona.
      if (args[0] === "organization-candidates") {
        const orgNote = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        const orgMinScore = Number(args.find((arg) => arg.startsWith("--min-score="))?.slice("--min-score=".length) ?? 0.45);
        const orgLimitArg = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
        const orgLimit = orgLimitArg ? Number(orgLimitArg) : undefined;
        if (!Number.isFinite(orgMinScore) || orgMinScore < 0 || orgMinScore > 1
          || (orgLimit !== undefined && (!Number.isInteger(orgLimit) || orgLimit <= 0))) {
          console.error("uso: crv review organization-candidates [--min-score=0.45] [--limit=200] [--note=\"<motivo>\" --confirm]");
          return 1;
        }
        const scan = await findOrganizationCandidates({ minScore: orgMinScore, ...(orgLimit === undefined ? {} : { limit: orgLimit }) });
        for (const candidate of scan.candidates) {
          console.log(`${candidate.score.toFixed(3)}\tprioridad ${candidate.priority}\t${candidate.a.id} «${candidate.a.name}» / ${candidate.b.id} «${candidate.b.name}»\t${candidate.features.map((feature) => feature.key).join(",")}`);
        }
        console.log(`TOTAL: ${scan.candidates.length} pares propuestos de ${scan.organizations} organizaciones (${scan.comparedPairs} pares comparados)`);
        if (!args.includes("--confirm") || !orgNote?.trim()) {
          console.log('\n(previsualización) para abrir las revisiones: crv review organization-candidates --note="<motivo>" --confirm');
          return 0;
        }
        const result = await openOrganizationCandidateReviews(scan.candidates, orgNote, getEnv().CRV_OPERATOR_NAME);
        console.log(`run ${result.runId}: ${result.opened} ${result.opened === 1 ? "revisión abierta" : "revisiones abiertas"}, ${result.skipped} ya existían`);
        return 0;
      }
      // Correcciones de identidad de personas decididas por el propietario,
      // escritas en un plan JSON versionado (docs/decisions/). Sin --confirm
      // se ejecutan y se deshacen: muestra el efecto sin aplicarlo.
      if (args[0] === "persons") {
        const planPath = args.find((arg) => arg.startsWith("--plan="))?.slice("--plan=".length);
        const note = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        if (!planPath) { console.error('uso: crv review persons --plan=<archivo.json> [--note="<motivo>" --confirm]'); return 1; }
        const plan = await loadPersonCorrectionPlan(planPath);
        const confirm = args.includes("--confirm") && Boolean(note?.trim());
        const result = await applyPersonCorrections(plan, note?.trim() || plan.evidence, { dryRun: !confirm });
        for (const outcome of result.outcomes) console.log(`${outcome.status === "applied" ? "✓" : "·"} ${outcome.op}\t${outcome.detail}`);
        console.log(`${result.creditsMerged} créditos equivalentes unidos (run ${result.runId})`);
        if (!confirm) console.log('\n(previsualización: nada se escribió) para aplicar: crv review persons --plan=<archivo> --note="<motivo>" --confirm');
        return 0;
      }
      if (args[0] === "sincopa-organizations") {
        const note = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        const plan = await planSincopaOrganizationRepair();
        for (const item of plan.candidates) {
          console.log(`retirar\t${item.id}\t${item.name}\tpáginas=${item.rawPageIds.join(",")}`);
        }
        for (const item of plan.skipped) {
          console.log(`conservar\t${item.id}\t${item.name}\t${item.dependents.map((dep) => `${dep.rows} en ${dep.table}.${dep.column}`).join(", ")}`);
        }
        console.log(`TOTAL: ${plan.candidates.length} retirables, ${plan.skipped.length} conservadas por dependencias; ${plan.validNames} nombres válidos reextraídos`);
        if (!args.includes("--confirm")) {
          console.log('\n(previsualización) para ejecutar: crv review sincopa-organizations --note="<motivo>" --confirm');
          return 0;
        }
        if (!note?.trim()) { console.error("--note es obligatorio al confirmar"); return 1; }
        const result = await applySincopaOrganizationRepair(note);
        console.log(`run ${result.runId}: ${result.removed.length} organizaciones retiradas; ${result.skipped.length} conservadas`);
        return 0;
      }
      if (args[0] === "keep-repeated-tracks") {
        const ids = (args[1] ?? "").split(",").filter(Boolean).map(Number);
        const note = args.find((arg) => arg.startsWith("--note="))?.slice("--note=".length);
        if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
          console.error('uso: crv review keep-repeated-tracks <conflict-id,...> --note="<evidencia>" --confirm');
          return 1;
        }
        console.log(`Conflictos: ${ids.join(", ")} (se conservarán ambas posiciones de cada título)`);
        if (!args.includes("--confirm") || !note?.trim()) {
          console.log('(previsualización) añade --note="<evidencia>" --confirm para ejecutar');
          return 0;
        }
        const opened = await getPool().query<{ id: string }>(`
          INSERT INTO ingest.scrape_runs(kind,status,params)
          VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
        [JSON.stringify({ action: "keep_repeated_tracks", conflictIds: ids, note })]);
        const runId = Number(opened.rows[0]!.id);
        try {
          const result = await keepRepeatedTrackOccurrences(ids, { actor: "human", note, runId });
          await finishRun(runId, "ok", { conflicts: result.length, tracksCreated: result.length });
          console.log(JSON.stringify({ runId, result }, null, 2));
          return 0;
        } catch (error) {
          await finishRun(runId, "failed", { conflicts: 0 }, (error as Error).message);
          throw error;
        }
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
      console.error('uso: crv review list | show <id> | apply-decisions [--note="<motivo>" --confirm] | sincopa-organizations [--note="<motivo>" --confirm] | keep-repeated-tracks <conflict-id,...> --note="<evidencia>" --confirm | entities [kind] [--limit=N] | approve <kind> "<identity>" <nota> | dismiss <kind> "<identity>" <nota> | approve-batch [kind] [--source=<slug>] [--limit=N] --note="<motivo>" --confirm | dismiss-batch [...]');
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
        console.error('uso: scrape <slug> --observe   (solo modo observación implementado: descarga + almacenamiento crudo, sin extracción)');
        return 1;
      }
      if (!observe) {
        console.log("solo --observe está implementado en esta fase (F1); la extracción llega en F4.");
        return 1;
      }
      const result = await runObserve(slug);
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
      // Paso 4: lo derivado entra al catálogo como claims candidatos.
      if (subcommand === "api-claims") {
        const result = await ingestYouTubeApiClaims(args.includes("--dry-run") ? { dryRun: true } : {});
        console.log(`youtube api-claims${args.includes("--dry-run") ? " --dry-run" : ""}: ${result.videos} videos `
          + `(${result.releases} discos, ${result.mediaOnly} audiovisuales sin disco, ${result.skipped} sin identidad) -> `
          + `${result.artists} artistas, ${result.albums} discos, ${result.tracks} pistas, ${result.persons} personas, ${result.organizations} organizaciones, `
          + `${result.albumCredits} créditos de disco, ${result.trackCredits} de pista; `
          + `${result.claimsInserted} claims nuevos, ${result.claimsReused} reusados`);
        return 0;
      }
      // Paso 3: re-parsea lo ya guardado. Sin red, sin cuota, repetible.
      if (subcommand === "rederive") {
        const result = await rederiveYouTubeDescriptions({ dryRun: args.includes("--dry-run") });
        const signo = (a: number, b: number) => `${a} -> ${b}${b === a ? "" : ` (${b > a ? "+" : ""}${b - a})`}`;
        console.log(`youtube rederive${result.dryRun ? " --dry-run" : ""} (run ${result.runId}): ${result.videos} videos, `
          + `${result.changed} con cambios, ${result.errors} fallidos`);
        console.log(`  secciones: ${signo(result.sectionsBefore, result.sectionsAfter)}   pistas: ${signo(result.tracksBefore, result.tracksAfter)}`);
        for (const sample of result.samples) {
          console.log(`  ${sample.videoId}  secciones ${signo(...sample.sections)}  pistas ${signo(...sample.tracks)}  ${(sample.title ?? "").slice(0, 58)}`);
        }
        if (result.dryRun) console.log("  (dry-run: nada se escribió)");
        return result.errors > 0 ? 1 : 0;
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
      // Todas las clasificaciones de la hoja por disco (el core guarda una sola).
      if (subcommand === "classifications") {
        const result = await syncAlbumClassifications({ dryRun: args.includes("--dry-run") });
        console.log(`youtube classifications${result.dryRun ? " --dry-run" : ""}: ${result.rows} filas -> ${result.matched} atadas a ${result.albums} discos `
          + `(${result.classifications} clasificaciones, ${result.inferred} inferidas); ${result.unmatched} sin disco, ${result.ambiguous} ambiguas`);
        return 0;
      }
      if (subcommand === "unmatched") {
        const rows = await unmatchedYouTubeRows();
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      console.error("uso: crv youtube import-sheet <path> | seed-claims [--dry-run] | discover-channel [channel-id] [--resume] | sync [--pending] | rederive [--dry-run] | api-claims [--dry-run] | sync-video <video-id> | sync-channel [channel-id] | classifications [--dry-run] | unmatched");
      return 1;
    }

    // Último recurso para discos que siguen sin video: búsqueda dentro del
    // canal, con presupuesto de cuota; propone, nunca enlaza ni crea.
    case "yt:enrich-artist": {
      const artist = args.find((arg) => !arg.startsWith("--"));
      const maxArg = args.find((arg) => arg.startsWith("--max="))?.slice(6);
      if (!artist || (maxArg !== undefined && !/^\d+$/.test(maxArg))) { console.error('uso: crv yt:enrich-artist "<artista>" [--max=N] [--dry-run]'); return 1; }
      const result = await enrichArtistFromYouTube(artist, { dryRun: args.includes("--dry-run"), ...(maxArg ? { maxResults: Number(maxArg) } : {}) });
      console.log(`yt:enrich-artist ${result.artist}${result.runId ? ` (run ${result.runId})` : ""}: ${result.albumsWithoutVideo} discos sin video; `
        + `cuota hoy ${result.quotaUsedToday}/${result.quotaBudget}, gastadas ${result.quotaSpent}; ${result.found} videos encontrados, `
        + `${result.hydrated} hidratados, ${result.matches.length} coincidencias, ${result.reviewsCreated} revisiones youtube_match`);
      for (const match of result.matches) console.log(`  ? ${match.album} -> https://www.youtube.com/watch?v=${match.videoId} (${match.videoTitle})`);
      if (result.skippedReason) console.log(`  (${result.skippedReason})`);
      return 0;
    }

    // Relaciones video→artista y video→pista desde lo ya hidratado: sin red
    // ni cuota. Solo escribe identidades exactas; el resto va a youtube_match.
    case "yt:reconcile": {
      const result = await reconcileYouTubeChannel({ dryRun: args.includes("--dry-run") });
      const { summary } = result;
      console.log(`yt:reconcile${result.dryRun ? " --dry-run" : ` (run ${result.runId})`}: ${summary.videos} videos, ${summary.albums} discos`);
      for (const [category, count] of Object.entries(summary.byCategory)) console.log(`  ${category.padEnd(16)} ${count}`);
      console.log(`  ${"UNMATCHED_ALBUM".padEnd(16)} ${summary.unmatchedAlbums} (${summary.unmatchedAlbumsOfChannelArtists} de artistas con videos en el canal)`);
      console.log(`  tracklist: ${summary.tracklistEntries.matched}/${summary.tracklistEntries.total} entradas casadas`);
      console.log(`  video_artists: ${summary.videoArtists.inserted} nuevas, ${summary.videoArtists.total} en total · `
        + `video_tracks: ${summary.videoTracks.inserted} nuevas, ${summary.videoTracks.total} en total (${summary.videoTracks.withClaim} con claim) · `
        + `${summary.reviewsCreated} revisiones youtube_match nuevas`);
      if (result.dryRun) console.log("  (dry-run: nada se escribió)");
      for (const file of result.reportFiles) console.log(`  reporte: ${file}`);
      return 0;
    }

    case "yt:link": {
      const option =(name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
      const albumArg = option("album");
      const videoId = option("video");
      if (albumArg || videoId) {
        if (!albumArg || !videoId || !/^\d+$/.test(albumArg)) {
          console.error('uso: crv yt:link --album=<id> --video=<youtube-id> --note="evidencia" --confirm');
          return 1;
        }
        const note = option("note");
        if (!args.includes("--confirm") || !note) {
          console.log(`(previsualización) confirmaría video ${videoId} como enlace primario del álbum ${albumArg}; añade --note="evidencia" --confirm`);
          return 0;
        }
        const link = await confirmYouTubeAlbumLink(Number(albumArg), videoId, note);
        console.log(`yt:link: ${link.artist} — ${link.album} -> https://www.youtube.com/watch?v=${link.videoId}`);
        return 0;
      }
      const result = await linkYouTubeAlbums({ dryRun: args.includes("--dry-run") });
      console.log(`yt:link${result.dryRun ? " --dry-run" : ""}: ${result.linked.length} enlaces primarios inequívocos, ${result.ambiguous.length} ambiguos, ${result.unmatched.length} sin video confirmado; ${result.reviewsCreated} reviews creadas`);
      for (const link of result.linked) console.log(`  ✓ ${link.artist} — ${link.album}: https://www.youtube.com/watch?v=${link.videoId}`);
      if (result.dryRun) console.log("  (dry-run: nada se escribió)");
      return 0;
    }

    // E10 · Lleva a la cola los pares dudosos de discos y personas.
    case "ambiguity:scan": {
      const result = await scanAmbiguities({ dryRun: args.includes("--dry-run") });
      console.log(`ambiguity:scan${result.dryRun ? " --dry-run" : ` (run ${result.runId})`}: `
        + `discos ${result.albums.candidates} pares (${result.albums.enqueued} encolados, ${result.albums.alreadyQueued} ya en la cola) · `
        + `personas ${result.persons.candidates} pares con banda en común (${result.persons.enqueued} encolados, ${result.persons.alreadyQueued} ya en la cola); `
        + `${result.persons.withoutContext} pares de nombres parecidos sin banda en común no se encolan`);
      if (result.reportFile) console.log(`  reporte: ${result.reportFile}`);
      if (result.dryRun) console.log("  (dry-run: nada se escribió)");
      return 0;
    }

    // E10 · Decide los casos ambiguos de la cola: reglas primero, árbitro de IA
    // después y solo con evidencia citada. No toca el core.
    case "ambiguity:resolve": {
      const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
      const reviewIds = parseIdList(option("review"));
      const arbiterFile = option("arbiter-file");
      const exportPath = option("export");
      if (reviewIds === null || (args.includes("--ai") && arbiterFile)) {
        console.error('uso: crv ambiguity:resolve [--dry-run] [--review=<id,...>] [--ai | --arbiter-file=<json>] [--export=<json>]');
        return 1;
      }
      let arbiter: Arbiter | undefined;
      if (args.includes("--ai")) {
        if (!getEnv().DEEPSEEK_API_KEY) {
          console.error("--ai necesita DEEPSEEK_API_KEY (usa DEEPSEEK_MODEL_FAST); sin ella los casos semánticos quedan NEEDS_HUMAN");
          return 1;
        }
        arbiter = new DeepSeekArbiter(createDeepSeekGateway());
      } else if (arbiterFile) {
        arbiter = await FileArbiter.load(arbiterFile);
      }
      const result = await resolveAmbiguities({
        dryRun: args.includes("--dry-run"), ...(arbiter ? { arbiter } : {}), ...(reviewIds ? { reviewIds } : {}), ...(exportPath ? { exportPath } : {}),
      });
      const { summary } = result;
      console.log(`ambiguity:resolve${result.dryRun ? " --dry-run" : ` (run ${result.runId})`}: ${summary.cases} revisiones, ${summary.questions} preguntas`);
      for (const [decision, count] of Object.entries(summary.byDecision)) console.log(`  ${decision.padEnd(22)} ${count}`);
      console.log(`  filas: ${summary.rows.created} nuevas, ${summary.rows.reused} sin cambios, ${summary.rows.superseded} sustituidas, ${summary.rows.alreadyApplied} ya aplicadas`);
      if (summary.arbiter.name) {
        console.log(`  árbitro ${summary.arbiter.name}: ${summary.arbiter.consulted} consultas, ${summary.arbiter.accepted} aceptadas, `
          + `${summary.arbiter.rejected} descartadas por la política, ${summary.arbiter.withoutDecision} sin decisión, ${summary.arbiter.unavailable} fallidas`);
      }
      console.log(`  ${summary.aiEligiblePending} preguntas NEEDS_HUMAN con ambigüedad semántica esperan árbitro`);
      if (summary.unsupported.length) console.log(`  fuera de este resolutor: ${summary.unsupported.map((item) => `${item.kind} ${item.count}`).join(" · ")}`);
      for (const file of result.reportFiles) console.log(`  reporte: ${file}`);
      if (result.exported) console.log(`  dosieres para árbitro externo: ${result.exported}`);
      if (result.dryRun) console.log("  (dry-run: nada se escribió)");
      return 0;
    }

    // E10 · Única puerta al core de esta etapa, y la abre una persona.
    case "ambiguity:apply": {
      const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
      const reviewIds = parseIdList(option("review"));
      if (reviewIds === null) { console.error('uso: crv ambiguity:apply [--review=<id,...>] --note="<motivo>" --confirm'); return 1; }
      const note = option("note");
      const result = await applyAmbiguityResolutions({ ...(reviewIds ? { reviewIds } : {}), ...(note ? { note } : {}), confirm: args.includes("--confirm") });
      for (const item of result.planned) {
        console.log(`  ${item.decision === "MATCH_HIGH_CONFIDENCE" ? "✓" : "·"} #${item.reviewId} ${item.questionKey} [${item.decidedBy === "ai" ? `árbitro ${item.arbiter}` : "reglas"}] ${describeApply(item)}`);
      }
      if (result.heldForExplicitReview.length) {
        console.log(`  ${result.heldForExplicitReview.length} decisiones de árbitro no entran en lote; se aplican nombrando su revisión: --review=${[...new Set(result.heldForExplicitReview.map((item) => item.reviewId))].join(",")}`);
      }
      if (!result.confirmed) {
        console.log(`\n(previsualización: ${result.planned.length} decisiones) para aplicar: crv ambiguity:apply --note="<motivo>" --confirm [--review=<id,...>]`);
        return 0;
      }
      console.log(`ambiguity:apply (run ${result.runId}): ${result.applied.length} aplicadas, ${result.skipped.length} saltadas, ${result.failed.length} fallidas, ${result.reviewsClosed.length} revisiones cerradas`);
      for (const item of result.skipped) console.log(`  · saltada #${item.reviewId} ${item.questionKey}: ${item.reason}`);
      for (const item of result.failed) console.log(`  ✗ #${item.reviewId} ${item.questionKey}: ${item.error}`);
      return result.failed.length ? 1 : 0;
    }

    // Curaduría · detector de conflictos: analiza el catálogo entero, agrupa por
    // categoría y verifica qué resolvió y qué apareció desde el análisis anterior.
    case "curation": {
      const [subcommand] = args;
      if (subcommand === "scan") {
        const summary = await runCurationScan({ trigger: "cli", dryRun: args.includes("--dry-run") });
        if (summary.status === "failed") {
          console.error(`curation scan falló: ${summary.error ?? "error desconocido"}`);
          return 1;
        }
        if (summary.status === "skipped") {
          console.error(`curation scan omitido (análisis ${summary.scanId}): otro proceso está analizando el catálogo; reintenta en unos segundos`);
          return 1;
        }
        console.log(`curation scan${summary.dryRun ? " --dry-run" : ` (análisis ${summary.scanId})`}: ${summary.total} hallazgos en ${summary.durationMs} ms · `
          + `${summary.inserted} nuevos · ${summary.reopened} reabiertos · ${summary.resolved} resueltos · ${summary.chained} aparecidos tras una corrección`);
        for (const [category, count] of Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(6)}  ${category}`);
        for (const failure of summary.failures) console.error(`  ! detector ${failure.detector}: ${failure.error}`);
        // Parcial: lo que miraron los detectores sanos quedó guardado; lo del roto, intacto.
        if (summary.status === "partial") console.error("  análisis parcial: los hallazgos de los detectores que fallaron no se tocaron");
        if (summary.dryRun) console.log("  (dry-run: nada se escribió)");
        return summary.status === "partial" ? 1 : 0;
      }
      if (subcommand === "prune") {
        const result = await pruneCuration({ dryRun: args.includes("--dry-run") });
        if (result.status === "skipped") {
          console.error("curation prune: otro proceso está analizando el catálogo; no se borró nada, reintenta en unos segundos");
          return 1;
        }
        console.log(`curation prune${result.dryRun ? " --dry-run" : ""}: ${result.scans} análisis anteriores a los últimos ${result.keepScans} · `
          + `${result.resolvedFindings} hallazgos resueltos hace más de ${result.resolvedDays} días`
          + (result.dryRun ? " (dry-run: nada se borró)" : " · borrados"));
        return 0;
      }
      if (subcommand === "summary") {
        const summary = await getCurationSummary(false);
        console.log(`último análisis: ${summary.lastScan ? `#${summary.lastScan.id} ${summary.lastScan.trigger} ${summary.lastScan.status} ${summary.lastScan.startedAt}` : "ninguno"}`);
        console.log(`abiertos ${summary.totals.open} · ignorados ${summary.totals.ignored} · resueltos ${summary.totals.resolved} · nuevos en el último ${summary.totals.newInLastScan}`);
        for (const category of summary.categories) {
          console.log(`\n${String(category.open).padStart(6)}  ${category.label}`);
          for (const detector of category.detectors.filter((item) => item.open > 0)) console.log(`${String(detector.open).padStart(12)}  ${detector.label}`);
        }
        return 0;
      }
      console.error("uso: crv curation scan [--dry-run] | crv curation summary | crv curation prune [--dry-run]");
      return 1;
    }

    case undefined:
    case "help":
    case "--help":
      printHelp();
      return 0;

    default:
      if (RENAMED_COMMANDS.has(cmd)) {
        console.error(`"${cmd}" se implementó como: crv ${RENAMED_COMMANDS.get(cmd)!}`);
        return 1;
      }
      if (KNOWN_FUTURE_COMMANDS.has(cmd)) {
        console.error(`"${cmd}" está especificado en ARCHITECTURE.md §4 pero aún no implementado (ver PHASES.md).`);
        return 1;
      }
      console.error(`comando desconocido: "${cmd}"`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
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
  sources:evidence <slug> <url> "<extracto>" [notas]
                      registra evidencia manual de una fuente limitada/manual: abre revisión, no crea claims
  runs list           lista los runs (id, kind, estado, inicio)
  review list | review show <id>
  review entities [kind] [--limit=N]
                      entidades candidatas pendientes, agrupadas por entidad y no por claim
  review approve|dismiss <kind> "<identity>" <nota>
                      aprueba o descarta los claims candidatos de una entidad
  review approve-batch|dismiss-batch [kind] [--source=<slug>] [--limit=N] [--note="<motivo>" --confirm]
                      lo mismo por lotes; sin --confirm solo imprime el plan
  review duplicates [--note="<motivo>" --confirm]
                      fusiona filas del core que son la misma entidad con otra tilde o mayúscula
  review persons --plan=<archivo.json> [--note="<motivo>" --confirm]
                      aplica correcciones de identidad de personas decididas (docs/decisions/)
  review keep-repeated-tracks <conflict-id,...> --note="<evidencia>" --confirm
                      conserva las dos posiciones de un título repetido en un disco
  review apply-decisions [--note="<motivo>" --confirm]
                      previsualiza/aplica las decisiones concluyentes de la Mesa;
                      unsure permanece abierto y sin tocar el catálogo
  review sincopa-organizations [--note="<motivo>" --confirm]
                      reextrae el crudo con el parser vigente y retira falsos sellos
                      sin evidencia externa ni dependencias; conserva auditoría
  youtube import-sheet <path>  importa YT Master Spreadsheet de forma idempotente
  youtube seed-claims [--dry-run]  emite los claims de la hoja importada (low: candidatos a revisión)
  youtube discover-channel [channel-id] [--resume]  recorre el playlist de uploads sin hidratar
  youtube sync [--pending]     hidrata la unión de hoja y canal en lotes de 50
  youtube rederive [--dry-run]  re-parsea las descripciones guardadas, sin red ni cuota
  youtube api-claims [--dry-run]  emite los claims del canal (candidatos, van a revisión)
  youtube sync-video <video-id>  consulta YouTube Data API (requiere YOUTUBE_API_KEY)
  youtube sync-channel [channel-id]  recorre uploads playlist oficial (requiere YOUTUBE_API_KEY)
  youtube classifications [--dry-run]  guarda todas las clasificaciones que la hoja da a cada disco
  youtube unmatched          filas seed pendientes de enlace o revisión
  yt:link [--dry-run]        enlaza sólo releases inequívocos de la hoja YT; el resto va a revisión
  yt:link --album=<id> --video=<youtube-id> --note="evidencia" --confirm
                             confirma una selección humana como enlace primario
  yt:enrich-artist "<artista>" [--max=N] [--dry-run]
                             busca en el canal los discos del artista que siguen sin video
                             (search.list, 100 unidades; respeta YOUTUBE_DAILY_QUOTA_UNITS);
                             abre youtube_match, nunca enlaza ni crea álbumes
  yt:reconcile [--dry-run]   relaciona cada video con artista, disco y pistas (timestamps);
                             solo identidades exactas, el resto a youtube_match; sin red ni cuota;
                             escribe reports/youtube-reconciliation.{json,md}
  ambiguity:scan [--dry-run] encola como possible_duplicate los discos del mismo artista con >=3 pistas
                             en la misma posición y las personas con grafías relacionadas y banda en común
  ambiguity:resolve [--dry-run] [--review=<id,...>] [--ai | --arbiter-file=<json>] [--export=<json>]
                             decide los casos de la cola: MATCH_HIGH_CONFIDENCE / KEEP_SEPARATE / NEEDS_HUMAN /
                             CONFLICT con evidencia citada; --ai consulta DeepSeek (flash); no toca el core;
                             escribe reports/ambiguity-resolution.{json,md}
  curation scan [--dry-run]  analiza el catálogo con el detector de conflictos de Curaduría: nombres sucios,
                             mal segmentados, fichas de otro tipo, repetidas, incoherentes, en disputa, «Otros»
  curation summary           conteos abiertos por categoría y detector, y el último análisis
  curation prune [--dry-run] retención: borra los análisis anteriores a los últimos 500 y los hallazgos resueltos
                             hace más de 180 días (nunca abiertos ni ignorados)
  ambiguity:apply [--review=<id,...>] --note="<motivo>" --confirm
                             aplica MATCH y KEEP de reglas; las de árbitro solo nombrando su revisión

Nombres de ARCHITECTURE.md §4.13 con otra forma: ${[...RENAMED_COMMANDS.keys()].join(", ")}
Especificados y aún sin implementar: ${[...KNOWN_FUTURE_COMMANDS].join(", ")}
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
