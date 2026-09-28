// CRV · Importación de géneros desde una fuente externa autorizada
// (PLAN_GENEROS etapa 4).
//
// El recorrido de cada ficha: resolver la identidad con varias señales →
// pedir las etiquetas de la fuente → mapearlas contra la taxonomía de CRV →
// dejarlas como SUGERENCIA y mandar a revisión lo dudoso. Nada se publica:
// una sugerencia externa no entra en el catálogo ni en la radio hasta que una
// persona la confirma en la Mesa (etapa 3).
//
//  * `--dry-run` corre entero dentro de una transacción que se deshace, igual
//    que el backfill: el informe describe lo que `--confirm` escribiría.
//  * La MUESTRA (`scope: "sample"`) se mide contra lo que CRV ya confirmó y no
//    escribe sugerencias: sirve para decidir si la fuente merece importarse en
//    volumen, que la ficha solo habilita si alcanza el umbral.
//  * El nivel no se cruza: un género de artista va a `artist_genres` y uno de
//    lanzamiento a `album_genres`, nunca al revés.
import type { PoolClient } from "pg";
import { getEnv } from "../../config/env.js";
import { getPool } from "../../db/client.js";
import { moduleLogger } from "../../logger/index.js";
import type { GenreEntityKind } from "../rules.js";
import { loadTaxonomy, lockGenres } from "../store.js";
import type { Taxonomy } from "../taxonomy.js";
import {
  adapterContextFor, adapterFor, sourceAuthHeaders, type AdapterContext, type ExternalAdapter,
} from "./adapters.js";
import { createRateLimitedFetcher, ExternalFetchError, type FetchContext, type JsonFetcher } from "./http.js";
import {
  resolveAlbumIdentity, resolveArtistIdentity,
  type MatchOutcome, type MatchThresholds,
} from "./identity.js";
import { mapExternalValues, type Agreement, type MappedStatus, type MappingResult } from "./mapping.js";
import {
  ExternalSourceError, insertSuggestion, loadCrvState, loadIdentity, openExternalCase, recordImport,
  requireExternalSource, saveIdentity, type ExternalCase, type ExternalSourceRow,
} from "./store.js";

const log = moduleLogger("genres:external:import");

/** Una importación posterior puede resolver un caso abierto por un intento anterior. */
async function closeResolvedExternalCases(
  client: PoolClient, source: ExternalSourceRow, kind: GenreEntityKind, entityId: number,
  genreCase: "external_ambiguous_identity" | "external_unmapped_term", reason: string,
  unresolvedTerms: string[] = [],
): Promise<void> {
  await client.query(`
    UPDATE ingest.review_queue
       SET status = 'approved', resolved_by = 'system', resolved_at = now(), updated_at = now(),
           resolution_note = $6
     WHERE kind = 'genre_unknown' AND status IN ('open','in_progress')
       AND payload->>'origin' = 'genres-external'
       AND payload->>'externalSource' = $1 AND payload->>'entityKind' = $2
       AND (payload->>'entityId')::bigint = $3 AND payload->>'genreCase' = $4
       AND ($4 <> 'external_unmapped_term' OR NOT (payload->>'rawValue' = ANY($5::text[])))`,
    [source.slug, kind, entityId, genreCase, unresolvedTerms, reason],
  );
}

export type ImportScope = "sample" | "targets" | "pending";

export interface ImportOptions {
  sourceSlug: string;
  level: GenreEntityKind;
  scope: ImportScope;
  confirm: boolean;
  actor: string;
  reason: string;
  limit?: number | undefined;
  entityIds?: number[] | undefined;
  /** Solo caché: no sale nada a la red (repeticiones y pruebas). */
  offline?: boolean | undefined;
  /** Inyectables en pruebas; en producción salen de la ficha y del adaptador. */
  fetcher?: JsonFetcher | undefined;
  adapter?: ExternalAdapter | undefined;
  thresholds?: MatchThresholds | undefined;
}

export interface EntityOutcome {
  kind: GenreEntityKind;
  entityId: number;
  title: string;
  identity: {
    status: MatchOutcome["status"];
    externalId: string | null;
    externalName: string | null;
    score: number;
    signals: string[];
    reason: string;
  };
  /** Valores externos y qué pasó con cada uno. */
  values: Array<{ raw: string; status: MappedStatus; genreSlug: string | null; reason: string }>;
  suggested: string[];
  agreement: Agreement;
  agreementDetail: string;
  casesOpened: ExternalCase[];
  error?: string;
}

export interface ImportReport {
  sourceSlug: string;
  level: GenreEntityKind;
  scope: ImportScope;
  mode: "dry-run" | "confirm";
  runId: number;
  importId: number | null;
  candidates: number;
  identities: Record<"matched" | "ambiguous" | "none", number>;
  suggestions: { inserted: number; skipped: number };
  agreement: Record<Agreement, number>;
  /** Precisión de la muestra: acuerdos sobre lo comparable (§ etapa 4, punto 9). */
  precision: number | null;
  noise: Record<string, number>;
  coverageAdded: number;
  cases: { opened: number; byKind: Record<string, number> };
  network: { requests: number; cacheHits: number };
  entities: EntityOutcome[];
  errors: Array<{ entityId: number; message: string }>;
}

interface ArtistEntity {
  id: number;
  name: string;
  aliases: string[];
  albumTitles: string[];
  memberNames: string[];
}

interface AlbumEntity {
  id: number;
  title: string;
  year: number | null;
  artistId: number;
  trackTitles: string[];
  labelNames: string[];
}

const SCOPE_CONDITION: Record<ImportScope, string> = {
  // La muestra se mide contra lo que CRV ya confirmó: es el terreno conocido.
  sample: "EXISTS (SELECT 1 FROM ingest.%TABLE% g WHERE g.%COLUMN% = e.id AND g.role = 'primary' AND g.status = 'confirmed')",
  pending: "NOT EXISTS (SELECT 1 FROM ingest.%TABLE% g WHERE g.%COLUMN% = e.id AND g.role = 'primary' AND g.status = 'confirmed')",
  targets: "TRUE",
};

function scopeSql(scope: ImportScope, kind: GenreEntityKind): string {
  return SCOPE_CONDITION[scope].replaceAll("%TABLE%", `${kind}_genres`).replaceAll("%COLUMN%", `${kind}_id`);
}

async function loadArtists(client: PoolClient, options: ImportOptions, limit: number): Promise<ArtistEntity[]> {
  const { rows } = await client.query<{ id: string; name: string; aliases: string[]; album_titles: string[]; members: string[] }>(`
    SELECT e.id::text, e.name,
           ARRAY(SELECT a.alias FROM ingest.artist_aliases a WHERE a.artist_id = e.id ORDER BY a.alias) AS aliases,
           ARRAY(SELECT al.title FROM public.albums al WHERE al.artist_id = e.id ORDER BY al.title) AS album_titles,
           ARRAY(SELECT p.name FROM public.artist_members m JOIN public.persons p ON p.id = m.person_id
                  WHERE m.artist_id = e.id ORDER BY p.name) AS members
      FROM public.artists e
     WHERE ($1::bigint[] IS NULL OR e.id = ANY($1::bigint[])) AND ${scopeSql(options.scope, "artist")}
     ORDER BY e.id LIMIT $2`, [options.entityIds ?? null, limit]);
  return rows.map((row) => ({
    id: Number(row.id), name: row.name, aliases: row.aliases ?? [],
    albumTitles: row.album_titles ?? [], memberNames: row.members ?? [],
  }));
}

async function loadAlbums(client: PoolClient, options: ImportOptions, limit: number): Promise<AlbumEntity[]> {
  const { rows } = await client.query<{ id: string; title: string; release_year: number | null; artist_id: string; tracks: string[]; labels: string[] }>(`
    SELECT e.id::text, e.title, e.release_year, e.artist_id::text,
           ARRAY(SELECT t.title FROM public.tracks t WHERE t.album_id = e.id ORDER BY t.disc_number, t.track_number) AS tracks,
           ARRAY(SELECT o.name FROM public.organizations o WHERE o.id = e.label_id) AS labels
      FROM public.albums e
     WHERE ($1::bigint[] IS NULL OR e.id = ANY($1::bigint[])) AND ${scopeSql(options.scope, "album")}
     ORDER BY e.id LIMIT $2`, [options.entityIds ?? null, limit]);
  return rows.map((row) => ({
    id: Number(row.id), title: row.title, year: row.release_year, artistId: Number(row.artist_id),
    trackTitles: row.tracks ?? [], labelNames: row.labels ?? [],
  }));
}

async function loadArtist(client: PoolClient, artistId: number): Promise<ArtistEntity | undefined> {
  const [artist] = await loadArtists(client, {
    sourceSlug: "", level: "artist", scope: "targets", confirm: false, actor: "", reason: "", entityIds: [artistId],
  }, 1);
  return artist;
}

/**
 * Cabeceras de la fuente. MusicBrainz y Discogs bloquean un User-Agent
 * genérico o sin vía de contacto, así que aquí falta el contacto es un error,
 * no un aviso: mejor no salir que salir mal identificado.
 */
function headersFor(source: ExternalSourceRow): Record<string, string> {
  const contact = getEnv().GENRES_EXTERNAL_CONTACT?.trim();
  if (!contact) {
    throw new ExternalSourceError("invalid",
      "GENRES_EXTERNAL_CONTACT está vacío: las fuentes externas exigen un User-Agent con vía de contacto");
  }
  return {
    accept: "application/json",
    "user-agent": `CRV-generos/1.0 ( ${contact} )`,
    ...sourceAuthHeaders(source.slug),
  };
}

function emptyReport(options: ImportOptions, runId: number): ImportReport {
  return {
    sourceSlug: options.sourceSlug, level: options.level, scope: options.scope,
    mode: options.confirm ? "confirm" : "dry-run", runId, importId: null,
    candidates: 0,
    identities: { matched: 0, ambiguous: 0, none: 0 },
    suggestions: { inserted: 0, skipped: 0 },
    agreement: { agree: 0, family_agree: 0, disagree: 0, no_reference: 0 },
    precision: null,
    noise: {},
    coverageAdded: 0,
    cases: { opened: 0, byKind: {} },
    network: { requests: 0, cacheHits: 0 },
    entities: [],
    errors: [],
  };
}

/** Identidad del artista: de la base si ya está resuelta, o contra la fuente. */
async function artistIdentity(
  client: PoolClient, context: AdapterContext, adapter: ExternalAdapter, source: ExternalSourceRow,
  artist: ArtistEntity, thresholds: MatchThresholds, runId: number,
): Promise<{ externalId: string | null; outcome: MatchOutcome | null; cached: boolean }> {
  const known = await loadIdentity(client, "artist", artist.id, source.id);
  if (known) return { externalId: known.externalId, outcome: null, cached: true };
  const candidates = await adapter.searchArtists(context, artist.name);
  const outcome = resolveArtistIdentity(
    { name: artist.name, aliases: artist.aliases, albumTitles: artist.albumTitles, memberNames: artist.memberNames },
    candidates, thresholds);
  if (outcome.best) {
    await saveIdentity(client, {
      kind: "artist", entityId: artist.id, sourceId: source.id,
      externalId: outcome.best.candidate.externalId, externalName: outcome.best.candidate.name,
      externalUrl: outcome.best.candidate.url ?? adapter.urlFor("artist", outcome.best.candidate.externalId),
      score: outcome.best.score, signals: outcome.best.signals,
      status: outcome.status === "matched" ? "matched" : "ambiguous",
      decidedBy: `externa:${source.slug}`, reason: outcome.reason, runId,
    });
  }
  return { externalId: outcome.status === "matched" ? outcome.best!.candidate.externalId : null, outcome, cached: false };
}

function describeIdentity(outcome: MatchOutcome | null, externalId: string | null, cached: boolean): EntityOutcome["identity"] {
  if (cached) {
    return { status: "matched", externalId, externalName: null, score: 1, signals: ["identidad ya resuelta"], reason: "identidad guardada" };
  }
  const best = outcome?.best ?? null;
  return {
    status: outcome?.status ?? "none",
    externalId: best?.candidate.externalId ?? null,
    externalName: best?.candidate.name ?? null,
    score: best?.score ?? 0,
    signals: best?.signals.map((signal) => `${signal.name}${signal.detail ? ` (${signal.detail})` : ""}`) ?? [],
    reason: outcome?.reason ?? "sin candidatos",
  };
}

/** Sugerencias y casos de una ficha ya identificada. */
async function applyMapping(
  client: PoolClient, options: ImportOptions, source: ExternalSourceRow, kind: GenreEntityKind, entityId: number,
  externalId: string, externalUrl: string | null, evidenceUrl: string, fetchedAt: Date,
  mapping: MappingResult, report: ImportReport, outcome: EntityOutcome,
): Promise<void> {
  const write = options.scope !== "sample";
  if (write) {
    await closeResolvedExternalCases(client, source, kind, entityId, "external_unmapped_term",
      "La etiqueta ya tiene equivalencia aprobada o dejó de estar presente en la fuente.", mapping.unmapped);
  }
  const byRaw = new Map(mapping.values.map((value) => [value.genreId, value]));
  for (const proposal of mapping.proposals) {
    if (!write) continue;
    const inserted = await insertSuggestion(client, {
      kind, entityId, genreId: proposal.genreId, sourceId: source.id, sourceSlug: source.slug,
      externalId, externalUrl, rawValue: proposal.raw, tagKind: proposal.kind, tagCount: proposal.count,
      fetchedAt, evidenceUrl,
    });
    if (inserted) {
      report.suggestions.inserted += 1;
      outcome.suggested.push(byRaw.get(proposal.genreId)?.genreSlug ?? String(proposal.genreId));
    } else {
      report.suggestions.skipped += 1;
    }
  }

  const open = async (genreCase: ExternalCase, fingerprint: string, detail: Record<string, unknown>, note: string) => {
    if (!write) return;
    const id = await openExternalCase(client, kind, entityId, {
      genreCase, fingerprint, note,
      detail: { ...detail, externalSourceId: source.id, externalSource: source.slug, externalId, externalUrl },
    });
    if (id === null) return;
    report.cases.opened += 1;
    report.cases.byKind[genreCase] = (report.cases.byKind[genreCase] ?? 0) + 1;
    outcome.casesOpened.push(genreCase);
  };

  // Desacuerdo con CRV: la decisión de CRV manda; el caso lo resuelve una persona.
  if (mapping.agreement === "disagree") {
    await open("external_disagreement", `external:disagree:${source.slug}:${kind}:${entityId}`,
      { rawValue: mapping.values.filter((value) => value.status === "proposed").map((value) => value.raw).join(" · "), detailText: mapping.agreementDetail },
      `género: ${source.slug} discrepa del principal confirmado`);
  }
  // Términos sin equivalencia: no crean género, se proponen a quien administra la taxonomía.
  for (const term of mapping.unmapped) {
    await open("external_unmapped_term", `external:unmapped:${source.slug}:${term.toLowerCase()}`,
      { rawValue: term }, `género: «${term}» de ${source.slug} no tiene equivalencia`);
  }
  // Solo etiquetas demasiado generales: la fuente no aporta precisión.
  if (!mapping.proposals.length
    && !mapping.values.some((value) => value.status === "already_known")
    && mapping.values.some((value) => value.status === "too_generic")) {
    await open("external_too_generic", `external:generic:${source.slug}:${kind}:${entityId}`,
      { rawValue: mapping.values.filter((value) => value.status === "too_generic").map((value) => value.raw).join(" · ") },
      `género: ${source.slug} solo aporta etiquetas generales`);
  }
}

function countNoise(report: ImportReport, mapping: MappingResult): void {
  for (const value of mapping.values) {
    if (value.status === "proposed" || value.status === "already_known") continue;
    report.noise[value.status] = (report.noise[value.status] ?? 0) + 1;
  }
}

async function importArtists(
  client: PoolClient, options: ImportOptions, source: ExternalSourceRow, adapter: ExternalAdapter,
  context: AdapterContext, taxonomy: Taxonomy, thresholds: MatchThresholds, report: ImportReport, limit: number,
): Promise<void> {
  const artists = await loadArtists(client, options, limit);
  report.candidates = artists.length;
  for (const artist of artists) {
    const outcome: EntityOutcome = {
      kind: "artist", entityId: artist.id, title: artist.name,
      identity: { status: "none", externalId: null, externalName: null, score: 0, signals: [], reason: "" },
      values: [], suggested: [], agreement: "no_reference", agreementDetail: "", casesOpened: [],
    };
    try {
      const identity = await artistIdentity(client, context, adapter, source, artist, thresholds, report.runId);
      outcome.identity = describeIdentity(identity.outcome, identity.externalId, identity.cached);
      if (!identity.externalId) {
        report.identities[identity.outcome?.status === "ambiguous" ? "ambiguous" : "none"] += 1;
        if (identity.outcome?.status === "ambiguous" && options.scope !== "sample") {
          await openExternalCase(client, "artist", artist.id, {
            genreCase: "external_ambiguous_identity",
            fingerprint: `external:identity:${source.slug}:artist:${artist.id}`,
            detail: { externalSourceId: source.id, externalSource: source.slug, reason: identity.outcome.reason },
            note: `género: identidad dudosa en ${source.slug}`,
          });
          report.cases.opened += 1;
          report.cases.byKind["external_ambiguous_identity"] = (report.cases.byKind["external_ambiguous_identity"] ?? 0) + 1;
          outcome.casesOpened.push("external_ambiguous_identity");
        }
        report.entities.push(outcome);
        continue;
      }
      report.identities.matched += 1;
      if (options.scope !== "sample") {
        await closeResolvedExternalCases(client, source, "artist", artist.id, "external_ambiguous_identity",
          `Identidad de ${source.slug} confirmada: ${identity.externalId}.`);
      }
      const ficha = await adapter.artistGenres(context, identity.externalId);
      const state = await loadCrvState(client, "artist", artist.id);
      const mapping = mapExternalValues(taxonomy, ficha.values, state, source.tagPolicy);
      outcome.values = mapping.values.map((value) => ({ raw: value.raw, status: value.status, genreSlug: value.genreSlug, reason: value.reason }));
      outcome.agreement = mapping.agreement;
      outcome.agreementDetail = mapping.agreementDetail;
      report.agreement[mapping.agreement] += 1;
      countNoise(report, mapping);
      await applyMapping(client, options, source, "artist", artist.id, identity.externalId,
        adapter.urlFor("artist", identity.externalId), ficha.url, ficha.fetchedAt, mapping, report, outcome);
      if (state.primaryGenreId === null && outcome.suggested.length) report.coverageAdded += 1;
    } catch (error) {
      const message = error instanceof ExternalFetchError ? error.message : error instanceof Error ? error.message : String(error);
      outcome.error = message;
      report.errors.push({ entityId: artist.id, message });
      log.warn({ artistId: artist.id, err: message }, "la ficha externa del artista falló; sigue el resto");
    }
    report.entities.push(outcome);
  }
}

async function importAlbums(
  client: PoolClient, options: ImportOptions, source: ExternalSourceRow, adapter: ExternalAdapter,
  context: AdapterContext, taxonomy: Taxonomy, thresholds: MatchThresholds, report: ImportReport, limit: number,
): Promise<void> {
  const albums = await loadAlbums(client, options, limit);
  report.candidates = albums.length;
  for (const album of albums) {
    const outcome: EntityOutcome = {
      kind: "album", entityId: album.id, title: album.title,
      identity: { status: "none", externalId: null, externalName: null, score: 0, signals: [], reason: "" },
      values: [], suggested: [], agreement: "no_reference", agreementDetail: "", casesOpened: [],
    };
    try {
      const artist = await loadArtist(client, album.artistId);
      if (!artist) throw new Error(`el álbum ${album.id} no tiene artista`);
      // Un lanzamiento solo se identifica bajo un artista ya identificado.
      const artistMatch = await artistIdentity(client, context, adapter, source, artist, thresholds, report.runId);
      if (!artistMatch.externalId) {
        const artistAmbiguous = artistMatch.outcome?.status === "ambiguous";
        outcome.identity = { ...describeIdentity(artistMatch.outcome, null, false), reason: `el artista no está identificado: ${artistMatch.outcome?.reason ?? ""}` };
        // El disco no se identifica porque su artista quedó dudoso: eso es una
        // identidad ambigua, no una ficha sin candidato, y el resumen tiene que
        // decirlo igual que el detalle. El caso se abre sobre el artista y una
        // sola vez (el fingerprint deduplica): resolverlo desbloquea toda su
        // discografía, y abrir uno por disco inundaría la cola con la misma
        // pregunta repetida.
        report.identities[artistAmbiguous ? "ambiguous" : "none"] += 1;
        if (artistAmbiguous && options.scope !== "sample") {
          const opened = await openExternalCase(client, "artist", artist.id, {
            genreCase: "external_ambiguous_identity",
            fingerprint: `external:identity:${source.slug}:artist:${artist.id}`,
            detail: {
              externalSourceId: source.id, externalSource: source.slug,
              reason: artistMatch.outcome?.reason ?? "", blocksAlbums: true,
            },
            note: `género: identidad dudosa en ${source.slug} (bloquea sus discos)`,
          });
          if (opened !== null) {
            report.cases.opened += 1;
            report.cases.byKind["external_ambiguous_identity"] = (report.cases.byKind["external_ambiguous_identity"] ?? 0) + 1;
          }
          outcome.casesOpened.push("external_ambiguous_identity");
        }
        report.entities.push(outcome);
        continue;
      }
      const known = await loadIdentity(client, "album", album.id, source.id);
      let externalId = known?.externalId ?? null;
      let decision: MatchOutcome | null = null;
      if (!externalId) {
        const candidates = await adapter.albumCandidates(context, artistMatch.externalId);
        decision = resolveAlbumIdentity({
          title: album.title, year: album.year, trackTitles: album.trackTitles, labelNames: album.labelNames,
          artistExternalId: artistMatch.externalId,
        }, candidates, thresholds);
        if (decision.best) {
          await saveIdentity(client, {
            kind: "album", entityId: album.id, sourceId: source.id,
            externalId: decision.best.candidate.externalId, externalName: decision.best.candidate.name,
            externalUrl: decision.best.candidate.url ?? adapter.urlFor("album", decision.best.candidate.externalId),
            score: decision.best.score, signals: decision.best.signals,
            status: decision.status === "matched" ? "matched" : "ambiguous",
            decidedBy: `externa:${source.slug}`, reason: decision.reason, runId: report.runId,
          });
        }
        if (decision.status === "matched") externalId = decision.best!.candidate.externalId;
      }
      outcome.identity = describeIdentity(decision, externalId, Boolean(known));
      if (!externalId) {
        report.identities[decision?.status === "ambiguous" ? "ambiguous" : "none"] += 1;
        if (decision?.status === "ambiguous" && options.scope !== "sample") {
          await openExternalCase(client, "album", album.id, {
            genreCase: "external_ambiguous_identity",
            fingerprint: `external:identity:${source.slug}:album:${album.id}`,
            detail: { externalSourceId: source.id, externalSource: source.slug, reason: decision.reason },
            note: `género: identidad dudosa en ${source.slug}`,
          });
          report.cases.opened += 1;
          report.cases.byKind["external_ambiguous_identity"] = (report.cases.byKind["external_ambiguous_identity"] ?? 0) + 1;
          outcome.casesOpened.push("external_ambiguous_identity");
        }
        report.entities.push(outcome);
        continue;
      }
      report.identities.matched += 1;
      if (options.scope !== "sample") {
        await closeResolvedExternalCases(client, source, "album", album.id, "external_ambiguous_identity",
          `Identidad de ${source.slug} confirmada: ${externalId}.`);
      }
      const ficha = await adapter.albumGenres(context, externalId);
      const state = await loadCrvState(client, "album", album.id);
      const mapping = mapExternalValues(taxonomy, ficha.values, state, source.tagPolicy);
      outcome.values = mapping.values.map((value) => ({ raw: value.raw, status: value.status, genreSlug: value.genreSlug, reason: value.reason }));
      outcome.agreement = mapping.agreement;
      outcome.agreementDetail = mapping.agreementDetail;
      report.agreement[mapping.agreement] += 1;
      countNoise(report, mapping);
      await applyMapping(client, options, source, "album", album.id, externalId,
        adapter.urlFor("album", externalId), ficha.url, ficha.fetchedAt, mapping, report, outcome);
      if (state.primaryGenreId === null && outcome.suggested.length) report.coverageAdded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.error = message;
      report.errors.push({ entityId: album.id, message });
      log.warn({ albumId: album.id, err: message }, "la ficha externa del disco falló; sigue el resto");
    }
    report.entities.push(outcome);
  }
}

/** Precisión de la muestra: acuerdos (exactos o de familia) sobre lo comparable. */
export function precisionOf(agreement: Record<Agreement, number>): number | null {
  const comparable = agreement.agree + agreement.family_agree + agreement.disagree;
  return comparable === 0 ? null : Math.round((agreement.agree + agreement.family_agree) / comparable * 1000) / 1000;
}

/**
 * Comprueba que la fuente puede importar lo que se le pide. La base también lo
 * exige; esto lo dice antes de gastar una petición.
 */
function assertAllowed(source: ExternalSourceRow, options: ImportOptions): void {
  if (!getEnv().GENRES_EXTERNAL_ENABLED) {
    throw new ExternalSourceError("not_authorized", "GENRES_EXTERNAL_ENABLED está apagado: ninguna importación externa sale a la red");
  }
  if (source.status !== "authorized") {
    throw new ExternalSourceError("not_authorized", `la fuente ${source.slug} está en estado «${source.status}»: solo una fuente autorizada se consulta`);
  }
  if (options.scope !== "sample" && !source.importEnabled) {
    throw new ExternalSourceError("not_authorized", `la importación de ${source.slug} está apagada: solo se puede medir la muestra`);
  }
  if (source.levels !== "both" && source.levels !== options.level) {
    throw new ExternalSourceError("invalid", `la ficha de ${source.slug} dice que publica géneros de ${source.levels}, no de ${options.level}`);
  }
}

export async function runExternalImport(options: ImportOptions): Promise<ImportReport> {
  const env = getEnv();
  const limit = Math.min(options.limit ?? env.GENRES_EXTERNAL_MAX_ENTITIES, env.GENRES_EXTERNAL_MAX_ENTITIES);
  const thresholds = options.thresholds ?? {
    match: env.GENRES_EXTERNAL_MATCH_THRESHOLD,
    ambiguous: env.GENRES_EXTERNAL_AMBIGUOUS_THRESHOLD,
    margin: env.GENRES_EXTERNAL_MATCH_MARGIN,
  } satisfies MatchThresholds;
  const client = await getPool().connect();
  // La caché de respuestas va por su propia conexión, fuera de la transacción:
  // un `--dry-run` que se deshace no debe tirar a la basura lo que ya se le
  // pidió a la fuente (su límite por minuto es lo caro, no la escritura).
  const cacheClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const source = await requireExternalSource(client, options.sourceSlug);
    assertAllowed(source, options);
    const adapter = options.adapter ?? adapterFor(source.slug);
    if (!adapter) throw new ExternalSourceError("invalid", `no hay adaptador para «${source.slug}»`);
    const taxonomy = await loadTaxonomy(client);
    if (taxonomy.genres.size === 0) throw new Error("la taxonomía está vacía: aplica antes `crv genres taxonomy-apply --confirm`");

    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({
      action: "genres_external_import", source: source.slug, level: options.level, scope: options.scope,
      actor: options.actor, confirm: options.confirm,
    })]);
    const report = emptyReport(options, Number(run.rows[0]!.id));

    const network = { requests: 0, cacheHits: 0 };
    const fetchContext: FetchContext = {
      client: cacheClient, sourceId: source.id, ttlDays: env.GENRES_EXTERNAL_CACHE_TTL_DAYS, stats: network,
      fetcher: options.fetcher ?? createRateLimitedFetcher(source.rateLimitPerMinute),
      headers: headersFor(source),
      ...(options.offline === undefined ? {} : { offline: options.offline }),
    };
    const context = adapterContextFor(fetchContext);

    if (options.level === "artist") {
      await importArtists(client, options, source, adapter, context, taxonomy, thresholds, report, limit);
    } else {
      await importAlbums(client, options, source, adapter, context, taxonomy, thresholds, report, limit);
    }
    report.network = network;
    report.precision = precisionOf(report.agreement);
    report.importId = await recordImport(client, {
      sourceId: source.id, mode: options.scope === "sample" ? "sample" : "bulk", level: options.level,
      dryRun: !options.confirm, actor: options.actor, reason: options.reason, runId: report.runId,
      stats: {
        scope: options.scope, candidates: report.candidates, identities: report.identities,
        suggestions: report.suggestions, agreement: report.agreement, precision: report.precision,
        noise: report.noise, coverageAdded: report.coverageAdded, cases: report.cases, network: report.network,
        errors: report.errors.length,
      },
    });
    await client.query(`UPDATE ingest.scrape_runs SET status=$2::ingest.run_status, finished_at=now() WHERE id=$1`,
      [report.runId, report.errors.length ? "partial" : "ok"]);
    await client.query(options.confirm ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    cacheClient.release();
  }
}
