// CRV · Etapa 1 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md):
// el lote de investigación como fuente, en UN run reversible.
//
// Cada hecho de los dos JSON del lote entra como claim de la fuente
// `lote-investigacion-2026-10-02`, con las URLs que el propio lote cita como
// evidencia. Solo se escribe en el core cuando la ficha ya existe con
// identidad firme (tabla de identidades de la etapa 0) y el campo está vacío:
//
//   artista  origin_city, years_active, formed_year, disbanded_year
//   persona  real_name, birth_date, birth_city, death_date, is_deceased,
//            is_venezuelan — solo la persona titular de un solista ya enlazada
//   disco    release_year y album_type (si es `other` sin respaldo)
//
// Un valor igual al del core confirma (claim aceptado). Uno distinto queda en
// `conflict` y va al informe de conflictos; nunca pisa. Todo lo demás (bios,
// géneros, miembros, alias, discos y pistas por crear, personas por nombre)
// queda `candidate` para las etapas 2–4, con `identity_key` estable para
// engancharlo cuando su ficha exista. Los claims `candidate` no alimentan los
// géneros (solo `accepted`/`conflict` lo hacen).
//
//   ./scripts/with-node22.sh tsx scripts/lote-investigacion-2026-10-02.ts [--confirm]
//
// Etapa 2 (`--enganchar-etapa2`): con las fichas que creó
// `lote-investigacion-etapa2.ts` (etapa2-identidades.json), la misma pasada
// engancha a ellas los claims `candidate` del run 11461 (los adopta en vez de
// duplicarlos), rellena sus campos vacíos y deja las obras del lote en las
// notas de las fichas nuevas (plan §2.2: las obras van a notas, no a discos).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { familyOf, resolveGenreValue, type Taxonomy } from "../src/genres/taxonomy.js";
import {
  LOTE_EXTRACTOR, LOTE_EXTRACTOR_VERSION, LOTE_SOURCE_SLUG,
  artistFacts, artistTypeClash, compareKey, contextualGenreText, loteFileSchema, releaseFacts, sameCity, sameName, sameTitle,
  type CoreArtistType, type LoteArtist, type LoteFact,
} from "../src/ingest/lote-investigacion.js";

const DESKTOP = path.join(os.homedir(), "Desktop");
const LOTES = [
  {
    key: "lote1",
    file: path.join(DESKTOP, "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json"),
    cross: "reports/nuevo-lote-2026-10-02",
  },
  {
    key: "lote2",
    file: path.join(DESKTOP, "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json"),
    cross: "reports/nuevo-lote-2026-10-02/lote2",
  },
] as const;
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const KEY_PREFIX = "lote-2026-10-02";

/**
 * Identidades de la etapa 0 que no valen. Simón Díaz cruzó por alias con el
 * artista 1022 «Simón Díaz Remixes», un proyecto de remezclas (investigación
 * de géneros §5): su ficha propia se crea en la etapa 2. Arca, ver abajo
 * (separada después del run 11461 con scripts/lote-investigacion-separar-arca.ts).
 */
const IDENTITY_OVERRIDES: Record<string, "nuevo"> = {
  "simon-diaz": "nuevo",
  // Nuuro (1250) y Arca son proyectos distintos de la misma persona, P2528
  // (Brian, 2026-10-02). Arca es ficha nueva de la etapa 2.
  arca: "nuevo",
};

interface CrossIdentity { lote_id: string; estado: "existe" | "nuevo"; artistas: Array<{ id: number }>; personas_candidatas: Array<{ id: number; nombre: string }> }
interface CrossRelease { lote_id: string; titulo: string; anio: number | null; estado: string; catalogo: { id: number; titulo: string } | null }

interface ConflictRow {
  lote: string; loteId: string; artist: string; target: string; entityId: number; field: string;
  lote_value: unknown; lote_raw: unknown; core_value: unknown; evidence: string;
}

/** Fichas que creó o identificó la etapa 2 (lote_id → artista y titular). */
const STAGE2 = process.argv.includes("--enganchar-etapa2");
const STAGE2_FILE = `${OUT_DIR}/etapa2-identidades.json`;
if (STAGE2 && !existsSync(STAGE2_FILE)) throw new Error(`${STAGE2_FILE} no existe: aplique antes el bloque «nuevos» de la etapa 2`);
const STAGE2_IDENTITIES: Record<string, { artistId: number; personId: number | null; created: boolean }> = STAGE2
  ? (JSON.parse(readFileSync(STAGE2_FILE, "utf8")) as { identities: Record<string, { artistId: number; personId: number | null; created: boolean }> }).identities
  : {};

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const confirm = process.argv.includes("--confirm");

const report = {
  mode: `${STAGE2 ? "etapa2-" : ""}${confirm ? "confirm" : "dry-run"}`,
  runId: 0,
  files: [] as Array<{ lote: string; file: string; sha256: string; artists: number }>,
  artists: { existing: 0, new: 0, withTitularPerson: 0, overridden: [] as string[], appearedSinceStage0: [] as Array<{ loteId: string; name: string; artistIds: number[] }> },
  claims: { inserted: 0, reused: 0, adopted: 0, byStatus: {} as Record<string, number>, byField: {} as Record<string, number> },
  applied: {} as Record<string, number>,
  appliedRows: [] as Array<{ target: string; entityId: number; name: string; field: string; value: unknown }>,
  confirmed: {} as Record<string, number>,
  conflicts: [] as ConflictRow[],
  albums: { attached: 0, variants: 0, pending: 0, missingInCore: 0 },
  genres: {
    claims: 0, gothicContextual: [] as Array<{ loteId: string; raw: string; as: string }>,
    unresolved: {} as Record<string, number>, proposed: {} as Record<string, { estado: string; slug: string | null }>,
  },
};

function bump(map: Record<string, number>, key: string, by = 1): void { map[key] = (map[key] ?? 0) + by; }

async function currentId(client: PoolClient, kind: "artist" | "album" | "person", id: number): Promise<number | null> {
  let current = id;
  for (let hop = 0; hop < 10; hop += 1) {
    const next = await client.query<{ to_id: string }>(
      "SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind=$1::ingest.claim_entity_kind AND from_id=$2 ORDER BY created_at DESC LIMIT 1", [kind, current]);
    if (!next.rowCount) break;
    current = Number(next.rows[0]!.to_id);
  }
  const table = kind === "artist" ? "public.artists" : kind === "album" ? "public.albums" : "public.persons";
  const exists = await client.query(`SELECT 1 FROM ${table} WHERE id=$1`, [current]);
  return exists.rowCount ? current : null;
}

/** Persona titular de un solista ya enlazada: el «Titular del proyecto», o el único miembro. */
async function titularPerson(client: PoolClient, artistId: number): Promise<number | null> {
  const { rows } = await client.query<{ person_id: string; role: string }>(
    "SELECT person_id::text, role FROM public.artist_members WHERE artist_id=$1 ORDER BY id", [artistId]);
  const titular = [...new Set(rows.filter((row) => /^titular/i.test(row.role)).map((row) => row.person_id))];
  if (titular.length === 1) return Number(titular[0]);
  const people = [...new Set(rows.map((row) => row.person_id))];
  return titular.length === 0 && people.length === 1 ? Number(people[0]) : null;
}

async function artistIsMetal(client: PoolClient, taxonomy: Taxonomy, artistId: number | null, artist: LoteArtist): Promise<boolean> {
  const metal = taxonomy.bySlug.get("metal");
  if (!metal) return false;
  const inMetal = (genreId: number) => familyOf(taxonomy, genreId)?.id === metal.id;
  if (artistId !== null) {
    const { rows } = await client.query<{ genre_id: string }>(
      "SELECT genre_id::text FROM ingest.artist_genres WHERE artist_id=$1 AND status IN ('suggested','confirmed')", [artistId]);
    if (rows.some((row) => inMetal(Number(row.genre_id)))) return true;
  }
  for (const term of [...(artist.genres ?? []), ...(artist.subgenres ?? [])]) {
    if (compareKey(term) === "gothic") continue;
    if (resolveGenreValue(taxonomy, term).items.some((item) => item.kind === "genre" && inMetal(item.genreId))) return true;
  }
  return false;
}

/** Artistas que la etapa 0 dio por nuevos y que hoy ya cruzan por nombre o alias exacto. */
async function liveNameMatches(client: PoolClient, name: string): Promise<number[]> {
  const { rows } = await client.query<{ id: string; name: string }>(`
    SELECT a.id::text, a.name FROM public.artists a WHERE lower(a.name) = lower($1)
    UNION SELECT a.id::text, a.name FROM ingest.artist_aliases al JOIN public.artists a ON a.id = al.artist_id
     WHERE lower(al.alias) = lower($1)`, [name]);
  return [...new Set(rows.map((row) => Number(row.id)))];
}

interface InsertInput {
  sourceId: number; target: "artist" | "person" | "album" | "track"; entityId: number | null;
  identityKey: string; secondaryKey?: string | null; identityRaw: string;
  fact: LoteFact; normalized: unknown; status: "accepted" | "candidate" | "conflict"; note?: string | undefined;
}

async function insertClaim(client: PoolClient, input: InsertInput): Promise<number | null> {
  const column = input.entityId === null ? null : `${input.target}_id`;
  const rawValue = input.fact.raw ?? input.fact.value;
  const hash = sha([LOTE_EXTRACTOR, input.identityKey, input.fact.field, input.fact.value, input.fact.note ?? null]);
  const columns = ["source_id", "entity_kind", "field", "raw_value", "normalized_value", "raw_hash", "extractor", "extractor_version",
    "confidence", "status", "created_by", "run_id", "notes", "identity_raw", "identity_key", "identity_secondary_key"];
  const values: unknown[] = [input.sourceId, input.target, input.fact.field, JSON.stringify(rawValue), JSON.stringify(input.normalized),
    hash, LOTE_EXTRACTOR, LOTE_EXTRACTOR_VERSION, "medium", input.status, "ai", report.runId,
    [input.fact.note, input.note].filter(Boolean).join(" · ") || null, input.identityRaw, input.identityKey, input.secondaryKey ?? null];
  if (column) { columns.push(column); values.push(input.entityId); }
  // Un claim del lote que ya existe (run 11461) con la ficha aún sin crear se
  // adopta: recibe la ficha y la decisión de ahora, y conserva su evidencia.
  const prior = await client.query<{ id: string; target: string | null; status: string }>(`
    SELECT id::text, ${input.target}_id::text AS target, status::text FROM ingest.claims
     WHERE source_id=$1 AND entity_kind=$2::ingest.claim_entity_kind AND identity_key=$3 AND field=$4 AND raw_hash=$5
     ORDER BY id LIMIT 1`, [input.sourceId, input.target, input.identityKey, input.fact.field, hash]);
  const previous = prior.rows[0];
  if (previous && (previous.target === null || Number(previous.target) === input.entityId) && input.entityId !== null
    && (previous.target === null || previous.status !== input.status)) {
    await client.query(`
      UPDATE ingest.claims SET ${input.target}_id=$2, status=$3::ingest.claim_status, updated_at=now(),
             identity_secondary_key=COALESCE($4, identity_secondary_key),
             notes=concat_ws(' · ', notes, $5::text)
       WHERE id=$1`, [previous.id, input.entityId, input.status, input.secondaryKey ?? null, `enganchado en la etapa 2 (run ${report.runId})`]);
    bump(report.claims.byStatus, input.status);
    bump(report.claims.byField, `${input.target}.${input.fact.field}`);
    report.claims.adopted += 1;
    return Number(previous.id);
  }
  const placeholders = columns.map((name, index) => {
    const n = `$${index + 1}`;
    if (name === "raw_value" || name === "normalized_value") return `${n}::jsonb`;
    if (name === "entity_kind") return `${n}::ingest.claim_entity_kind`;
    if (name === "confidence") return `${n}::ingest.confidence_level`;
    if (name === "status") return `${n}::ingest.claim_status`;
    if (name === "created_by") return `${n}::ingest.actor_kind`;
    return n;
  });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ingest.claims(${columns.join(",")}) VALUES(${placeholders.join(",")}) ON CONFLICT DO NOTHING RETURNING id::text`, values);
  bump(report.claims.byStatus, input.status);
  bump(report.claims.byField, `${input.target}.${input.fact.field}`);
  const id = inserted.rows[0]?.id;
  if (!id) { report.claims.reused += 1; return null; }
  report.claims.inserted += 1;
  for (const evidence of input.fact.evidence) {
    await client.query(
      "INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,position,evidence_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [id, evidence.url, evidence.excerpt, evidence.position, sha([evidence.url, evidence.excerpt])]);
  }
  return Number(id);
}

async function audit(client: PoolClient, target: string, entityId: number, field: string, oldValue: unknown, newValue: unknown, claimId: number | null, reason: string): Promise<void> {
  const row = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,${target}_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,$2::ingest.claim_entity_kind,$3,$4,$5::jsonb,$6::jsonb,$7,'medium','system') RETURNING id::text`,
  [report.runId, target, entityId, field, JSON.stringify(oldValue ?? null), JSON.stringify(newValue), reason]);
  if (claimId) await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2)", [row.rows[0]!.id, claimId]);
}

const TABLE = { artist: "public.artists", person: "public.persons", album: "public.albums" } as const;

/** Igualdad tolerante (tildes, mayúsculas, puntuación) entre el valor del lote y el del core. */
function sameValue(field: string, lote: unknown, core: unknown): boolean {
  if (core === null || core === undefined) return false;
  if (typeof lote === "number" || typeof lote === "boolean" || field === "birth_date" || field === "death_date") return String(lote) === String(core);
  if (field === "origin_city" || field === "birth_city") return sameCity(String(lote), String(core));
  if (field === "title") return sameTitle(String(lote), String(core));
  if (field === "name" || field === "real_name") return sameName(String(lote), String(core));
  return compareKey(String(lote)) === compareKey(String(core));
}

interface Decision { status: "accepted" | "candidate" | "conflict"; write: boolean; current: unknown }

async function decide(client: PoolClient, target: "artist" | "person" | "album", entityId: number, fact: LoteFact, extra: { personName?: string | undefined; artistAliases?: string[] | undefined }): Promise<Decision> {
  if (fact.policy === "candidate") return { status: "candidate", write: false, current: null };
  // ::text: las fechas no pasan por el Date de node-pg (zona horaria) y todo se compara como texto.
  const { rows } = await client.query<{ value: string | null }>(`SELECT ${fact.field}::text AS value FROM ${TABLE[target]} WHERE id=$1`, [entityId]);
  const current = rows[0]?.value ?? null;
  if (fact.field === "artist_type") {
    const clash = artistTypeClash(fact.value as CoreArtistType, current as CoreArtistType);
    return { status: clash ? "conflict" : "accepted", write: false, current };
  }
  if (fact.field === "name") {
    const names = [String(current ?? ""), ...(extra.artistAliases ?? [])];
    return { status: names.some((name) => sameValue("name", fact.value, name)) ? "accepted" : "conflict", write: false, current };
  }
  if (fact.policy === "compare") return { status: sameValue(fact.field, fact.value, current) ? "accepted" : "conflict", write: false, current };

  // fill
  if (fact.field === "real_name" && current === null && extra.personName && sameValue("name", fact.value, extra.personName)) {
    return { status: "accepted", write: false, current: extra.personName };
  }
  if (fact.field === "album_type") {
    if (current !== "other") return { status: current === fact.value ? "accepted" : "conflict", write: false, current };
    const backed = await client.query(
      "SELECT 1 FROM ingest.claims WHERE album_id=$1 AND field='album_type' AND status='accepted' AND normalized_value #>> '{}' IS DISTINCT FROM 'other' LIMIT 1", [entityId]);
    return backed.rowCount ? { status: "conflict", write: false, current: "other (respaldado por otra fuente)" } : { status: "accepted", write: true, current };
  }
  const empty = current === null || current === "";
  if (empty) return { status: "accepted", write: true, current };
  return { status: sameValue(fact.field, fact.value, current) ? "accepted" : "conflict", write: false, current };
}

async function applyFact(client: PoolClient, sourceId: number, ctx: {
  lote: string; loteId: string; artistName: string; target: "artist" | "person" | "album"; entityId: number | null;
  identityKey: string; secondaryKey?: string | null; fact: LoteFact; normalized?: unknown; personName?: string | undefined; artistAliases?: string[] | undefined; note?: string | undefined;
}): Promise<void> {
  const { fact, target, entityId } = ctx;
  const decision = entityId === null
    ? { status: "candidate" as const, write: false, current: null }
    : await decide(client, target, entityId, fact, { personName: ctx.personName, artistAliases: ctx.artistAliases });
  const claimId = await insertClaim(client, {
    sourceId, target, entityId, identityKey: ctx.identityKey, secondaryKey: ctx.secondaryKey ?? null, identityRaw: ctx.artistName,
    fact, normalized: ctx.normalized ?? fact.value, status: decision.status, note: ctx.note,
  });
  if (entityId === null || decision.status === "candidate") return;
  const label = `${target}.${fact.field}`;
  if (decision.status === "conflict") {
    report.conflicts.push({
      lote: ctx.lote, loteId: ctx.loteId, artist: ctx.artistName, target, entityId, field: fact.field,
      lote_value: fact.value, lote_raw: fact.raw ?? null, core_value: decision.current, evidence: fact.evidence[0]?.url ?? "",
    });
    return;
  }
  if (!decision.write) { bump(report.confirmed, label); return; }
  await client.query(`UPDATE ${TABLE[target]} SET ${fact.field}=$2, updated_at=now() WHERE id=$1`, [entityId, fact.value]);
  const reason = `Lote de investigación 2026-10-02 (${ctx.lote}): rellena un campo vacío; cita ${fact.evidence[0]?.url ?? ""}`;
  await audit(client, target, entityId, fact.field, decision.current, fact.value, claimId, reason);
  bump(report.applied, label);
  report.appliedRows.push({ target, entityId, name: ctx.artistName, field: fact.field, value: fact.value });
}

async function main(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Lote de investigación 2026-10-02 (IA, web abierta)','database','low',false,
             'Dos JSON de investigación hechos con IA sobre la web abierta (~/Desktop/Nuevo lote y Nuevo lote 2), con 1–4 URLs citadas por artista. Solo rellena campos vacíos; nunca pisa el canal, la hoja ni otras fuentes (decisión de Brian, 2026-10-02). Aplicador: scripts/lote-investigacion-2026-10-02.ts. Nunca se raspa.')
      ON CONFLICT (slug) DO NOTHING`, [LOTE_SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [LOTE_SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind, status, source_id, params) VALUES('merge_run','running',$1,$2::jsonb) RETURNING id::text",
      [sourceId, JSON.stringify({ action: "lote_investigacion_claims", stage: STAGE2 ? "1+2" : 1, confirm, files: LOTES.map((lote) => lote.file) })]);
    report.runId = Number(run.rows[0]!.id);
    const taxonomy = await loadTaxonomy(client);

    for (const lote of LOTES) {
      const body = readFileSync(lote.file);
      const parsed = loteFileSchema.parse(JSON.parse(body.toString("utf8")));
      report.files.push({ lote: lote.key, file: lote.file, sha256: createHash("sha256").update(body).digest("hex"), artists: parsed.artists.length });
      const identities = new Map((JSON.parse(readFileSync(path.join(lote.cross, "identidades.json"), "utf8")) as CrossIdentity[]).map((row) => [row.lote_id, row]));
      const releases = JSON.parse(readFileSync(path.join(lote.cross, "discos.json"), "utf8")) as CrossRelease[];
      // Equivalencias propuestas en la etapa 0 para los términos que la taxonomía aún no resuelve.
      const proposals = new Map((JSON.parse(readFileSync(path.join(lote.cross, "generos.json"), "utf8")) as Array<{ termino: string; estado: string; slug: string | null }>)
        .map((row) => [compareKey(row.termino), row]));

      for (const artist of parsed.artists) {
        const identity = identities.get(artist.id);
        if (!identity) throw new Error(`${lote.key}: ${artist.id} no está en la tabla de identidades de la etapa 0`);
        let artistId: number | null = null;
        const stage2 = STAGE2_IDENTITIES[artist.id];
        if (stage2) artistId = await currentId(client, "artist", stage2.artistId);
        else if (IDENTITY_OVERRIDES[artist.id] === "nuevo") report.artists.overridden.push(artist.id);
        else if (identity.estado === "existe") artistId = await currentId(client, "artist", identity.artistas[0]!.id);
        if (artistId === null) {
          report.artists.new += 1;
          const live = await liveNameMatches(client, artist.artist_name);
          if (live.length && !IDENTITY_OVERRIDES[artist.id]) report.artists.appearedSinceStage0.push({ loteId: artist.id, name: artist.artist_name, artistIds: live });
        } else report.artists.existing += 1;

        const personId = artistId === null ? null : await titularPerson(client, artistId);
        if (personId !== null) report.artists.withTitularPerson += 1;
        const personName = personId === null ? undefined
          : (await client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [personId])).rows[0]?.name;
        const artistAliases = artistId === null ? []
          : (await client.query<{ alias: string }>("SELECT alias FROM ingest.artist_aliases WHERE artist_id=$1", [artistId])).rows.map((row) => row.alias);
        const metal = await artistIsMetal(client, taxonomy, artistId, artist);
        const artistKey = `${KEY_PREFIX}:artist:${artist.id}`;
        const personKey = `${KEY_PREFIX}:person:${artist.id}`;
        const personNote = identity.personas_candidatas.length
          ? `personas con ese nombre: ${identity.personas_candidatas.map((person) => `P${person.id} ${person.nombre}`).join(", ")}` : undefined;

        const facts = artistFacts(artist);
        // Obras del lote → notas de las fichas que creó la etapa 2 (solo si están vacías).
        const works = facts.filter((fact) => fact.field === "notable_work");
        if (stage2?.created && works.length) {
          facts.push({
            target: "artist", field: "notes", policy: "fill", evidence: works[0]!.evidence,
            value: `Obras destacadas según el lote de investigación 2026-10-02: ${works.map((fact) => String(fact.value)).join("; ")}.`,
          });
        }

        for (const fact of facts) {
          if (fact.target === "artist" && fact.field === "genre") {
            const contextual = contextualGenreText(String(fact.value), metal);
            const resolution = resolveGenreValue(taxonomy, contextual.text);
            const slugs = resolution.items.flatMap((item) => item.kind === "genre" ? [taxonomy.genres.get(item.genreId)!.slug] : []);
            const unresolved = resolution.items.flatMap((item) => item.kind === "unresolved" ? [item.fragment] : []);
            const proposal = slugs.length ? undefined : proposals.get(compareKey(String(fact.value)));
            for (const term of unresolved) {
              bump(report.genres.unresolved, term);
              if (proposal) report.genres.proposed[term] = { estado: proposal.estado, slug: proposal.slug ?? null };
            }
            if (contextual.contextual) report.genres.gothicContextual.push({ loteId: artist.id, raw: String(fact.value), as: contextual.text });
            report.genres.claims += 1;
            const genreFact: LoteFact = contextual.contextual
              ? { ...fact, value: contextual.text, raw: String(fact.value), note: `${fact.note ?? ""} · «${fact.value}» suelto según contexto (${metal ? "ficha de metal" : "ficha no metal"})` }
              : fact;
            await applyFact(client, sourceId, {
              lote: lote.key, loteId: artist.id, artistName: artist.artist_name, target: "artist", entityId: artistId,
              identityKey: artistKey, fact: genreFact,
              normalized: { slugs, unresolved, notAGenre: resolution.notAGenre, ...(proposal ? { proposed: { estado: proposal.estado, slug: proposal.slug ?? null } } : {}) },
            });
            continue;
          }
          const isPerson = fact.target === "person";
          await applyFact(client, sourceId, {
            lote: lote.key, loteId: artist.id, artistName: artist.artist_name,
            target: isPerson ? "person" : "artist", entityId: isPerson ? personId : artistId,
            identityKey: isPerson ? personKey : artistKey,
            secondaryKey: isPerson && artistId !== null ? `artist:${artistId}` : null,
            fact, personName, artistAliases, note: isPerson && personId === null ? personNote : undefined,
          });
        }

        // Discos: la etapa 0 dijo existe / variante / falta / artista_nuevo.
        const crossFor = releases.filter((row) => row.lote_id === artist.id);
        for (const [index, release] of (artist.discography ?? []).entries()) {
          const cross = crossFor.find((row) => row.titulo === release.title && (row.anio ?? null) === (typeof release.year === "number" ? release.year : row.anio));
          let albumId: number | null = null;
          let variantOf: number | null = null;
          if (artistId !== null && cross?.catalogo) {
            const resolved = await currentId(client, "album", cross.catalogo.id);
            if (resolved === null) report.albums.missingInCore += 1;
            else if (cross.estado === "existe") albumId = resolved;
            else if (cross.estado === "variante") variantOf = resolved;
          }
          if (albumId !== null) {
            const owner = await client.query<{ artist_id: string }>("SELECT artist_id::text FROM public.albums WHERE id=$1", [albumId]);
            if (Number(owner.rows[0]?.artist_id) !== artistId) { variantOf = albumId; albumId = null; }
          }
          if (albumId !== null) report.albums.attached += 1; else if (variantOf !== null) report.albums.variants += 1; else report.albums.pending += 1;
          const albumKey = `${KEY_PREFIX}:album:${artist.id}:${index}`;
          const facts = releaseFacts(artist, release, index);
          for (const fact of facts.album) {
            await applyFact(client, sourceId, {
              lote: lote.key, loteId: artist.id, artistName: artist.artist_name, target: "album", entityId: albumId,
              identityKey: albumKey, secondaryKey: variantOf !== null ? `variante:album:${variantOf}` : artistId !== null ? `artist:${artistId}` : null,
              fact, note: variantOf !== null ? `variante probable del disco ${variantOf}` : undefined,
            });
          }
          for (const track of facts.tracks) {
            for (const fact of track.facts) {
              await insertClaim(client, {
                sourceId, target: "track", entityId: null, identityKey: `${albumKey}:track:${track.key}`,
                secondaryKey: albumId !== null ? `album:${albumId}` : variantOf !== null ? `variante:album:${variantOf}` : null,
                identityRaw: `${artist.artist_name} — ${release.title}`, fact, normalized: fact.value, status: "candidate",
              });
            }
          }
        }
      }
    }

    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1", [report.runId, JSON.stringify({
      claims: report.claims.inserted, reused: report.claims.reused, applied: report.applied, conflicts: report.conflicts.length,
    })]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  writeReports();
  await closeDb();
}

const FIELD_TITLES: Record<string, string> = {
  "artist.artist_type": "Tipo de artista (solistas registrados como banda: corrección de la etapa 2)",
  "artist.name": "Nombre del artista",
  "album.release_year": "Año del disco",
  "album.title": "Título del disco",
  "album.album_type": "Tipo de disco",
};

function conflictSections(fmt: (value: unknown) => string): string[] {
  const groups = new Map<string, ConflictRow[]>();
  for (const row of report.conflicts) {
    const key = `${row.target}.${row.field}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).flatMap(([key, rows]) => [
    `### ${FIELD_TITLES[key] ?? key} (${rows.length})`, "",
    "| Lote | Artista | Ficha | Lote dice | Core tiene | Evidencia |", "|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.lote} | ${fmt(row.artist)} | ${row.target} ${row.entityId} | ${fmt(row.lote_value)}${row.lote_raw && row.lote_raw !== row.lote_value ? ` («${fmt(row.lote_raw)}»)` : ""} | ${fmt(row.core_value)} | ${row.evidence} |`),
    "",
  ]);
}

function writeReports(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `${OUT_DIR}/etapa1-${report.mode}-run${report.runId}`;
  writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2));
  const fmt = (value: unknown) => value === null || value === undefined ? "—" : String(value).replace(/\|/g, "/");
  const lines = [
    `# Etapa 1 — el lote como fuente (${report.mode}, run ${report.runId})`, "",
    `Fuente \`${LOTE_SOURCE_SLUG}\`. Artistas: ${report.artists.existing} existentes y ${report.artists.new} nuevos; ${report.artists.withTitularPerson} con persona titular enlazada.`,
    `Claims: ${report.claims.inserted} nuevos (${report.claims.reused} ya estaban). Por estado: ${JSON.stringify(report.claims.byStatus)}.`,
    `Discos: ${report.albums.attached} enlazados a su ficha, ${report.albums.variants} variantes probables, ${report.albums.pending} por crear (etapa 3).`, "",
    "## Rellenado en el core (solo campos vacíos)", "",
    ...Object.entries(report.applied).sort().map(([field, count]) => `- ${field}: ${count}`), "",
    "## Confirmados (el lote dice lo mismo que el core)", "",
    ...Object.entries(report.confirmed).sort().map(([field, count]) => `- ${field}: ${count}`), "",
    `## Conflictos (${report.conflicts.length}) — el core no se tocó`, "",
    ...conflictSections(fmt), "",
    "## «Gothic» suelto resuelto por contexto", "",
    ...(report.genres.gothicContextual.length ? report.genres.gothicContextual.map((row) => `- ${row.loteId}: «${row.raw}» → ${row.as}`) : ["- ninguno"]), "",
    "## Términos de género sin equivalente en la taxonomía", "",
    "| Término | Usos | Etapa 0 | Propuesta |", "|---|---|---|---|",
    ...Object.entries(report.genres.unresolved).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([term, count]) => {
      const proposal = report.genres.proposed[term];
      return `| ${term} | ${count} | ${proposal?.estado ?? "—"} | ${proposal?.slug ? `\`${proposal.slug}\`` : "—"} |`;
    }), "",
    "## Identidades", "",
    `- Forzados a nuevo: ${report.artists.overridden.join(", ") || "—"}`,
    ...report.artists.appearedSinceStage0.map((row) => `- ${row.loteId} («${row.name}») era nuevo en la etapa 0 y hoy cruza con ${row.artistIds.join(", ")}: se decide en la etapa 2`),
  ];
  writeFileSync(`${stem}.md`, `${lines.join("\n")}\n`);
  console.log(`etapa 1 (${report.mode}, run ${report.runId}): ${report.claims.inserted} claims · rellenados ${JSON.stringify(report.applied)} · ${report.conflicts.length} conflictos → ${stem}.md`);
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
