// CRV · Acciones estructurales de corrección de Curaduría (PLAN_CURADURIA E6).
//
// Acciones que modifican relaciones, convierten o dividen entidades, retiran
// fichas y pistas duplicadas, fusionan álbumes o corrigen datos numéricos y
// de coherencia respetando la integridad referencial y las restricciones únicas.
import { z } from "zod";
import { mergeAlbums, previewAlbumMerge } from "../../merge/album-merge.js";
import { withFieldJournal } from "../../merge/field-undo.js";
import { createEntity, createRelation, deleteEntity, updateEntity } from "../../merge/operator.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "../../merge/specs.js";
import { mergeInto } from "../../review/duplicates.js";
import { convertPerson, splitPerson } from "../../review/person-corrections.js";
import { classifyPersonName } from "../../review/person-junk.js";
import { nameKey } from "../lexicon.js";
import type { ActionFinding, ActionPreview, FixActionDefinition } from "./types.js";

function blockedPreview(
  touched: Array<{ kind: ResolvableClaimKind; id: number }>,
  code: NonNullable<ActionPreview["blocked"]>["code"],
  message: string,
  before: Record<string, unknown> = {},
): ActionPreview {
  return {
    touched,
    before,
    after: {},
    blocked: { code, message },
    collisions: [],
    warnings: [],
    proposal: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Acciones numéricas y de coherencia (E6.6)
// ---------------------------------------------------------------------------

// 1.1 Fijar tipo de disco
const fijarTipoParamsSchema = z.object({
  albumId: z.number().int().positive(),
  albumType: z.string().min(1),
}).strict();

export type FijarTipoParams = z.infer<typeof fijarTipoParamsSchema>;

export const fijarTipoDeDiscoAction: FixActionDefinition<FijarTipoParams> = {
  key: "fijar_tipo_de_disco",
  label: "Fijar tipo de disco",
  description: "Actualiza el tipo del disco según lo declarado en el título (demo, EP, en vivo, etc.).",
  level: 1,
  inverse: "field_restore",
  paramsSchema: fijarTipoParamsSchema,
  appliesTo(finding) {
    return finding.detector === "tipo_de_disco_contra_titulo" && finding.entity.kind === "album" && finding.entity.id !== null;
  },
  levelFor(finding) {
    return finding.evidence["wordSource"] === "semilla" && finding.signature === "sin_clasificar" ? 0 : 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const declared = finding.evidence["declaredTypes"];
    const albumType = Array.isArray(declared) && declared.length > 0 && typeof declared[0] === "string" ? declared[0] : null;
    if (!albumType) return null;
    return { albumId: finding.entity.id, albumType };
  },
  async preconditions(finding, params, ctx) {
    const { rows } = await ctx.client.query<{ album_type: string }>(
      "SELECT album_type::text FROM public.albums WHERE id=$1", [params.albumId],
    );
    if (!rows[0]) return [{ key: "exists", ok: false, code: "not_found", message: `álbum ${params.albumId} inexistente` }];
    if (rows[0].album_type === params.albumType) {
      return [{ key: "changed", ok: false, code: "noop", message: `el álbum ya tiene tipo «${params.albumType}»` }];
    }
    return [{ key: "exists", ok: true }, { key: "changed", ok: true }];
  },
  async preview(finding, params, ctx) {
    const { rows } = await ctx.client.query<{ title: string; album_type: string }>(
      "SELECT title, album_type::text FROM public.albums WHERE id=$1", [params.albumId],
    );
    if (!rows[0]) return blockedPreview([{ kind: "album", id: params.albumId }], "not_found", "álbum no encontrado");
    return {
      touched: [{ kind: "album", id: params.albumId }],
      before: { album_type: rows[0].album_type },
      after: { album_type: params.albumType },
      blocked: rows[0].album_type === params.albumType ? { code: "noop", message: "el tipo ya es el propuesto" } : null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "album", id: params.albumId, fields: ["album_type"] }, async () => {
      await updateEntity(context, "album", params.albumId, { album_type: params.albumType });
    });
    return { after: { album_type: params.albumType } };
  },
};

// 1.2 Vaciar año imposible
const vaciarAnioParamsSchema = z.object({
  kind: z.enum(["album", "artist"]),
  id: z.number().int().positive(),
  field: z.enum(["release_year", "formed_year", "disbanded_year"]),
}).strict();

export type VaciarAnioParams = z.infer<typeof vaciarAnioParamsSchema>;

export const vaciarAnioAction: FixActionDefinition<VaciarAnioParams> = {
  key: "vaciar_anio",
  label: "Vaciar año imposible",
  description: "Elimina un año imposible (en el futuro o anterior a la música grabada) dejando el campo en blanco.",
  level: 0,
  inverse: "field_restore",
  paramsSchema: vaciarAnioParamsSchema,
  appliesTo(finding) {
    return finding.detector === "anios_imposibles" && finding.entity.id !== null;
  },
  levelFor() {
    return 0;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const kind = finding.entity.kind === "album" || finding.entity.kind === "artist" ? finding.entity.kind : null;
    if (!kind) return null;
    const field = (finding.evidence["field"] as VaciarAnioParams["field"]) ?? (kind === "album" ? "release_year" : "formed_year");
    return { kind, id: finding.entity.id, field };
  },
  async preconditions(finding, params, ctx) {
    const table = params.kind === "album" ? "albums" : "artists";
    const { rows } = await ctx.client.query<Record<string, unknown>>(
      `SELECT "${params.field}" FROM public.${table} WHERE id=$1`, [params.id],
    );
    if (!rows[0]) return [{ key: "exists", ok: false, code: "not_found", message: `${params.kind} ${params.id} inexistente` }];
    if (rows[0][params.field] === null) return [{ key: "changed", ok: false, code: "noop", message: "el campo ya está vacío" }];
    return [{ key: "exists", ok: true }, { key: "changed", ok: true }];
  },
  async preview(finding, params, ctx) {
    const table = params.kind === "album" ? "albums" : "artists";
    const { rows } = await ctx.client.query<Record<string, unknown>>(
      `SELECT "${params.field}" FROM public.${table} WHERE id=$1`, [params.id],
    );
    if (!rows[0]) return blockedPreview([{ kind: params.kind, id: params.id }], "not_found", "entidad no encontrada");
    const current = rows[0][params.field];
    return {
      touched: [{ kind: params.kind, id: params.id }],
      before: { [params.field]: current },
      after: { [params.field]: null },
      blocked: current === null ? { code: "noop", message: "el año ya está vacío" } : null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: params.kind, id: params.id, fields: [params.field] }, async () => {
      await updateEntity(context, params.kind, params.id, { [params.field]: null });
    });
    return { after: { [params.field]: null } };
  },
};

// 1.3 Fijar año de formación desde el disco más antiguo
const fijarAnioFormacionParamsSchema = z.object({
  artistId: z.number().int().positive(),
  formedYear: z.number().int().positive(),
}).strict();

export type FijarAnioFormacionParams = z.infer<typeof fijarAnioFormacionParamsSchema>;

export const fijarAnioFormacionAction: FixActionDefinition<FijarAnioFormacionParams> = {
  key: "fijar_anio_formacion",
  label: "Fijar año de formación desde disco más antiguo",
  description: "Actualiza el año de formación de la banda al año de publicación de su disco más antiguo.",
  level: 1,
  inverse: "field_restore",
  paramsSchema: fijarAnioFormacionParamsSchema,
  appliesTo(finding) {
    return finding.detector === "disco_antes_de_formacion" && finding.entity.kind === "album" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding, ctx) {
    if (finding.entity.id === null) return null;
    const album = (await ctx.client.query<{ artist_id: number; release_year: number | null }>(
      "SELECT artist_id, release_year FROM public.albums WHERE id=$1", [finding.entity.id],
    )).rows[0];
    if (!album) return null;
    const oldest = (await ctx.client.query<{ min_year: number | null }>(
      "SELECT min(release_year) AS min_year FROM public.albums WHERE artist_id=$1 AND release_year IS NOT NULL",
      [album.artist_id],
    )).rows[0]?.min_year;
    if (!oldest) return null;
    return { artistId: album.artist_id, formedYear: oldest };
  },
  async preconditions(finding, params, ctx) {
    const artist = (await ctx.client.query<{ formed_year: number | null }>(
      "SELECT formed_year FROM public.artists WHERE id=$1", [params.artistId],
    )).rows[0];
    if (!artist) return [{ key: "exists", ok: false, code: "not_found", message: `artista ${params.artistId} inexistente` }];
    if (artist.formed_year === params.formedYear) return [{ key: "changed", ok: false, code: "noop", message: "el año de formación ya coincide" }];
    return [{ key: "exists", ok: true }, { key: "changed", ok: true }];
  },
  async preview(finding, params, ctx) {
    const artist = (await ctx.client.query<{ name: string; formed_year: number | null }>(
      "SELECT name, formed_year FROM public.artists WHERE id=$1", [params.artistId],
    )).rows[0];
    if (!artist) return blockedPreview([{ kind: "artist", id: params.artistId }], "not_found", "artista no encontrado");
    return {
      touched: [{ kind: "artist", id: params.artistId }],
      before: { formed_year: artist.formed_year },
      after: { formed_year: params.formedYear },
      blocked: artist.formed_year === params.formedYear ? { code: "noop", message: "año ya coincide" } : null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "artist", id: params.artistId, fields: ["formed_year"] }, async () => {
      await updateEntity(context, "artist", params.artistId, { formed_year: params.formedYear });
    });
    return { after: { formed_year: params.formedYear } };
  },
};

// 1.4 Vaciar duración cero
const vaciarDuracionParamsSchema = z.object({
  trackId: z.number().int().positive(),
}).strict();

export type VaciarDuracionParams = z.infer<typeof vaciarDuracionParamsSchema>;

export const vaciarDuracionAction: FixActionDefinition<VaciarDuracionParams> = {
  key: "vaciar_duracion",
  label: "Vaciar duración",
  description: "Elimina la duración en cero de la pista dejándola en NULL.",
  level: 0,
  inverse: "field_restore",
  paramsSchema: vaciarDuracionParamsSchema,
  appliesTo(finding) {
    return finding.detector === "duracion_atipica" && finding.signature === "cero" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 0;
  },
  async defaultParams(finding) {
    return finding.entity.id !== null ? { trackId: finding.entity.id } : null;
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query<{ duration_seconds: number | null }>(
      "SELECT duration_seconds FROM public.tracks WHERE id=$1", [params.trackId],
    )).rows[0];
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    if (track.duration_seconds === null) return [{ key: "changed", ok: false, code: "noop", message: "la duración ya es NULL" }];
    return [{ key: "exists", ok: true }, { key: "changed", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string; duration_seconds: number | null }>(
      "SELECT title, duration_seconds FROM public.tracks WHERE id=$1", [params.trackId],
    )).rows[0];
    if (!track) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista no encontrada");
    return {
      touched: [{ kind: "track", id: params.trackId }],
      before: { duration_seconds: track.duration_seconds },
      after: { duration_seconds: null },
      blocked: track.duration_seconds === null ? { code: "noop", message: "duración ya vacía" } : null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["duration_seconds"] }, async () => {
      await updateEntity(context, "track", params.trackId, { duration_seconds: null });
    });
    return { after: { duration_seconds: null } };
  },
};

// 1.5 Corregir unidades de duración (milisegundos a segundos)
const corregirUnidadesParamsSchema = z.object({
  trackId: z.number().int().positive(),
  durationSeconds: z.number().int().positive(),
}).strict();

export type CorregirUnidadesParams = z.infer<typeof corregirUnidadesParamsSchema>;

export const corregirUnidadesAction: FixActionDefinition<CorregirUnidadesParams> = {
  key: "corregir_unidades",
  label: "Corregir unidades de duración",
  description: "Convierte una duración registrada en milisegundos a segundos.",
  level: 1,
  inverse: "field_restore",
  paramsSchema: corregirUnidadesParamsSchema,
  appliesTo(finding) {
    return finding.detector === "duracion_atipica" && finding.signature === "muy_larga" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding, ctx) {
    if (finding.entity.id === null) return null;
    const dur = typeof finding.evidence["durationSeconds"] === "number"
      ? finding.evidence["durationSeconds"]
      : (await ctx.client.query<{ duration_seconds: number | null }>(
        "SELECT duration_seconds FROM public.tracks WHERE id=$1", [finding.entity.id],
      )).rows[0]?.duration_seconds;
    if (!dur || dur <= 600) return null;
    return { trackId: finding.entity.id, durationSeconds: Math.round(dur / 1000) };
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query<{ duration_seconds: number | null }>(
      "SELECT duration_seconds FROM public.tracks WHERE id=$1", [params.trackId],
    )).rows[0];
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    if (track.duration_seconds === params.durationSeconds) return [{ key: "changed", ok: false, code: "noop", message: "duración ya convertida" }];
    return [{ key: "exists", ok: true }, { key: "changed", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ duration_seconds: number | null }>(
      "SELECT duration_seconds FROM public.tracks WHERE id=$1", [params.trackId],
    )).rows[0];
    if (!track) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista no encontrada");
    return {
      touched: [{ kind: "track", id: params.trackId }],
      before: { duration_seconds: track.duration_seconds },
      after: { duration_seconds: params.durationSeconds },
      blocked: track.duration_seconds === params.durationSeconds ? { code: "noop", message: "duración ya convertida" } : null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["duration_seconds"] }, async () => {
      await updateEntity(context, "track", params.trackId, { duration_seconds: params.durationSeconds });
    });
    return { after: { duration_seconds: params.durationSeconds } };
  },
};

// 1.6 Renumerar consecutivo en dos fases (PLAN_CURADURIA E6.6)
const renumerarParamsSchema = z.object({
  albumId: z.number().int().positive(),
  discNumber: z.number().int().positive(),
}).strict();

export type RenumerarParams = z.infer<typeof renumerarParamsSchema>;

export const renumerarConsecutivoAction: FixActionDefinition<RenumerarParams> = {
  key: "renumerar_consecutivo",
  label: "Renumerar pistas consecutivamente",
  description: "Renumera las pistas de la cara/disco de 1 a N en dos fases (+1000 y asignación final) respetando tracks_position_uk.",
  level: 1,
  inverse: "field_restore",
  paramsSchema: renumerarParamsSchema,
  appliesTo(finding) {
    return finding.detector === "numeracion_con_huecos" && finding.entity.kind === "album" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const discNumber = typeof finding.evidence["disc"] === "number" ? finding.evidence["disc"] : 1;
    return { albumId: finding.entity.id, discNumber };
  },
  async preconditions(finding, params, ctx) {
    const { rows } = await ctx.client.query<{ id: number; track_number: number }>(
      "SELECT id, track_number FROM public.tracks WHERE album_id=$1 AND disc_number=$2 ORDER BY track_number",
      [params.albumId, params.discNumber],
    );
    if (!rows.length) return [{ key: "exists", ok: false, code: "not_found", message: "el disco no tiene pistas" }];
    const alreadyConsecutive = rows.every((r, idx) => r.track_number === idx + 1);
    if (alreadyConsecutive) return [{ key: "changed", ok: false, code: "noop", message: "las pistas ya están numeradas de 1 a N" }];
    return [{ key: "exists", ok: true }, { key: "changed", ok: true }];
  },
  async preview(finding, params, ctx) {
    const { rows } = await ctx.client.query<{ id: number; title: string; track_number: number }>(
      "SELECT id, title, track_number FROM public.tracks WHERE album_id=$1 AND disc_number=$2 ORDER BY track_number",
      [params.albumId, params.discNumber],
    );
    if (!rows.length) return blockedPreview([{ kind: "album", id: params.albumId }], "not_found", "disco sin pistas");
    const beforeList = rows.map((r) => ({ id: r.id, number: r.track_number, title: r.title }));
    const afterList = rows.map((r, idx) => ({ id: r.id, number: idx + 1, title: r.title }));
    const alreadyConsecutive = rows.every((r, idx) => r.track_number === idx + 1);
    return {
      touched: [{ kind: "album", id: params.albumId }],
      before: { tracks: beforeList },
      after: { tracks: afterList },
      blocked: alreadyConsecutive ? { code: "noop", message: "ya numeradas consecutivamente" } : null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const client = context.client;
    // Fase 1: Desplazamiento temporal +1000 (evita colisiones con tracks_position_uk y respeta track_number > 0)
    await client.query(
      "UPDATE public.tracks SET track_number = track_number + 1000 WHERE album_id=$1 AND disc_number=$2",
      [params.albumId, params.discNumber],
    );
    // Fase 2: Asignación final ordenada por el número previo
    const { rows } = await client.query<{ id: number; track_number: number }>(
      "SELECT id, track_number FROM public.tracks WHERE album_id=$1 AND disc_number=$2 ORDER BY track_number",
      [params.albumId, params.discNumber],
    );
    for (let i = 0; i < rows.length; i += 1) {
      await client.query(
        "UPDATE public.tracks SET track_number = $1 WHERE id = $2",
        [i + 1, rows[i]!.id],
      );
    }
    return { after: { renumberedCount: rows.length } };
  },
};

// 1.7 Mover duración pegada al título
const DURATION_RE = /(?<![\d:.])(\d{1,2})[:'’´](\d{2})(?![\d:])(?!\s*(?:a\.?\s?m|p\.?\s?m)\b)/iu;

const moverDuracionParamsSchema = z.object({
  trackId: z.number().int().positive(),
  cleanTitle: z.string().min(1),
  durationSeconds: z.number().int().positive(),
}).strict();

export type MoverDuracionParams = z.infer<typeof moverDuracionParamsSchema>;

export const moverDuracionAction: FixActionDefinition<MoverDuracionParams> = {
  key: "mover_duracion",
  label: "Mover duración al campo de la pista",
  description: "Extrae la duración escrita en el título y la guarda en duration_seconds.",
  level: 0,
  inverse: "field_restore",
  paramsSchema: moverDuracionParamsSchema,
  appliesTo(finding) {
    return finding.detector === "duracion_en_titulo" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 0;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const match = DURATION_RE.exec(finding.value ?? "");
    if (!match) return null;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const durationSeconds = minutes * 60 + seconds;
    const cleanTitle = (finding.value ?? "")
      .replace(DURATION_RE, "")
      .replace(/\s+/gu, " ")
      .replace(/[\s\-–—.,;:]+$|^[\s\-–—.,;:]+/gu, "")
      .trim();
    if (!cleanTitle) return null;
    return { trackId: finding.entity.id, cleanTitle, durationSeconds };
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string }>(
      "SELECT title FROM public.tracks WHERE id=$1", [params.trackId],
    )).rows[0];
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string; duration_seconds: number | null }>(
      "SELECT title, duration_seconds FROM public.tracks WHERE id=$1", [params.trackId],
    )).rows[0];
    if (!track) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista no encontrada");
    return {
      touched: [{ kind: "track", id: params.trackId }],
      before: { title: track.title, duration_seconds: track.duration_seconds },
      after: { title: params.cleanTitle, duration_seconds: params.durationSeconds },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["title", "duration_seconds"] }, async () => {
      await updateEntity(context, "track", params.trackId, { title: params.cleanTitle, duration_seconds: params.durationSeconds });
    });
    return { after: { title: params.cleanTitle, duration_seconds: params.durationSeconds } };
  },
};

// ---------------------------------------------------------------------------
// 2. Acciones compuestas de segmentación (E6.1)
// ---------------------------------------------------------------------------

// 2.1 Extraer intérprete con ficha existente
const extraerInterpreteParamsSchema = z.object({
  trackId: z.number().int().positive(),
  cleanTitle: z.string().min(1),
  artistId: z.number().int().positive(),
}).strict();

export type ExtraerInterpreteParams = z.infer<typeof extraerInterpreteParamsSchema>;

export const extraerInterpreteAction: FixActionDefinition<ExtraerInterpreteParams> = {
  key: "extraer_interprete",
  label: "Extraer intérprete a crédito de pista",
  description: "Limpia el prefijo de artista del título de la pista y crea el crédito de intérprete correspondiente.",
  level: 1,
  inverse: "relation_delete",
  paramsSchema: extraerInterpreteParamsSchema,
  appliesTo(finding) {
    return finding.detector === "artista_en_titulo_de_pista" && finding.signature === "artista_con_ficha" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const artist = finding.related.find((r) => r.kind === "artist");
    if (!artist || artist.id === null) return null;
    const cleanTitle = finding.suggestedValue ?? (finding.value ?? "").replace(/^.+?\s*[-–—]\s*/u, "").trim();
    if (!cleanTitle) return null;
    return { trackId: finding.entity.id, cleanTitle, artistId: artist.id };
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query("SELECT 1 FROM public.tracks WHERE id=$1", [params.trackId])).rowCount;
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    const artist = (await ctx.client.query("SELECT 1 FROM public.artists WHERE id=$1", [params.artistId])).rowCount;
    if (!artist) return [{ key: "artist_exists", ok: false, code: "not_found", message: `artista ${params.artistId} inexistente` }];
    return [{ key: "exists", ok: true }, { key: "artist_exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string }>("SELECT title FROM public.tracks WHERE id=$1", [params.trackId])).rows[0];
    const artist = (await ctx.client.query<{ name: string }>("SELECT name FROM public.artists WHERE id=$1", [params.artistId])).rows[0];
    if (!track || !artist) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista o artista no encontrados");
    return {
      touched: [{ kind: "track", id: params.trackId }, { kind: "artist", id: params.artistId }],
      before: { title: track.title },
      after: { title: params.cleanTitle, credit: { artistId: params.artistId, artistName: artist.name, role: "Intérprete" } },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["title"] }, async () => {
      await updateEntity(context, "track", params.trackId, { title: params.cleanTitle });
    });
    const credit = await createRelation(context, "track_credit", { trackId: params.trackId, artistId: params.artistId }, {
      credit_type: "musician",
      role: "Intérprete",
    });
    return { after: { title: params.cleanTitle, creditId: credit.id } };
  },
};

// 2.2 Extraer intérprete creando ficha de artista
const extraerInterpreteCreandoParamsSchema = z.object({
  trackId: z.number().int().positive(),
  cleanTitle: z.string().min(1),
  artistName: z.string().min(1),
}).strict();

export type ExtraerInterpreteCreandoParams = z.infer<typeof extraerInterpreteCreandoParamsSchema>;

export const extraerInterpreteCreandoAction: FixActionDefinition<ExtraerInterpreteCreandoParams> = {
  key: "extraer_interprete_creando",
  label: "Extraer intérprete creando nuevo artista",
  description: "Crea el artista que no existía en el catálogo, limpia el título de la pista y le asigna el crédito.",
  level: 1,
  inverse: "relation_delete",
  paramsSchema: extraerInterpreteCreandoParamsSchema,
  appliesTo(finding) {
    return finding.detector === "artista_en_titulo_de_pista" && finding.signature === "artista_sin_ficha" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const match = /^(.+?)\s*[-–—]\s*(.+)$/u.exec(finding.value ?? "");
    if (!match) return null;
    return { trackId: finding.entity.id, cleanTitle: match[2]!.trim(), artistName: match[1]!.trim() };
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query("SELECT 1 FROM public.tracks WHERE id=$1", [params.trackId])).rowCount;
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string }>("SELECT title FROM public.tracks WHERE id=$1", [params.trackId])).rows[0];
    if (!track) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista no encontrada");
    return {
      touched: [{ kind: "track", id: params.trackId }],
      before: { title: track.title },
      after: { title: params.cleanTitle, createdArtist: params.artistName },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const artist = await createEntity(context, "artist", { name: params.artistName }, { allowSimilar: true });
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["title"] }, async () => {
      await updateEntity(context, "track", params.trackId, { title: params.cleanTitle });
    });
    const credit = await createRelation(context, "track_credit", { trackId: params.trackId, artistId: artist.id }, {
      credit_type: "musician",
      role: "Intérprete",
    });
    return { after: { title: params.cleanTitle, createdArtistId: artist.id, creditId: credit.id } };
  },
};

// 2.3 Extraer invitado (feat. ...)
const FEAT_REGEX = /\s*[([]\s*(?:feat\.?|ft\.|featuring|con)\s+([^()[\]]+)[)\]]/iu;

const extraerInvitadoParamsSchema = z.object({
  trackId: z.number().int().positive(),
  cleanTitle: z.string().min(1),
  guestName: z.string().min(1),
  guestPersonId: z.number().int().positive().optional(),
}).strict();

export type ExtraerInvitadoParams = z.infer<typeof extraerInvitadoParamsSchema>;

export const extraerInvitadoAction: FixActionDefinition<ExtraerInvitadoParams> = {
  key: "extraer_invitado",
  label: "Extraer invitado a crédito",
  description: "Limpia la mención del artista invitado del título y crea un crédito de invitado (guest).",
  level: 1,
  inverse: "relation_delete",
  paramsSchema: extraerInvitadoParamsSchema,
  appliesTo(finding) {
    return finding.detector === "creditos_en_titulo" && finding.signature === "invitado" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const match = FEAT_REGEX.exec(finding.value ?? "");
    const guestName = match ? match[1]!.trim() : finding.related[0]?.label ?? "";
    if (!guestName) return null;
    const cleanTitle = (finding.value ?? "").replace(FEAT_REGEX, "").trim();
    const guestPerson = finding.related.find((r) => r.kind === "person");
    const out: ExtraerInvitadoParams = {
      trackId: finding.entity.id,
      cleanTitle: cleanTitle || (finding.value ?? ""),
      guestName,
    };
    if (guestPerson && guestPerson.id !== null) {
      out.guestPersonId = guestPerson.id;
    }
    return out;
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query("SELECT 1 FROM public.tracks WHERE id=$1", [params.trackId])).rowCount;
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string }>("SELECT title FROM public.tracks WHERE id=$1", [params.trackId])).rows[0];
    if (!track) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista no encontrada");
    return {
      touched: [{ kind: "track", id: params.trackId }],
      before: { title: track.title },
      after: { title: params.cleanTitle, guest: params.guestName },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    let personId = params.guestPersonId;
    if (!personId) {
      const existing = (await context.client.query<{ id: number }>(
        "SELECT id FROM public.persons WHERE name=$1", [params.guestName],
      )).rows[0];
      if (existing) {
        personId = existing.id;
      } else {
        const created = await createEntity(context, "person", { name: params.guestName }, { allowSimilar: true });
        personId = created.id;
      }
    }
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["title"] }, async () => {
      await updateEntity(context, "track", params.trackId, { title: params.cleanTitle });
    });
    const credit = await createRelation(context, "track_credit", { trackId: params.trackId, personId }, {
      credit_type: "guest",
      role: "Invitado",
    });
    return { after: { title: params.cleanTitle, guestPersonId: personId, creditId: credit.id } };
  },
};

// 2.4 Extraer autores / compositores
const extraerAutoresParamsSchema = z.object({
  trackId: z.number().int().positive(),
  cleanTitle: z.string().min(1),
  authors: z.array(z.string().min(1)).min(1),
}).strict();

export type ExtraerAutoresParams = z.infer<typeof extraerAutoresParamsSchema>;

export const extraerAutoresAction: FixActionDefinition<ExtraerAutoresParams> = {
  key: "extraer_autores",
  label: "Extraer autores a créditos de compositor",
  description: "Limpia la autoría entre paréntesis del título y crea los créditos de compositor correspondientes.",
  level: 1,
  inverse: "relation_delete",
  paramsSchema: extraerAutoresParamsSchema,
  appliesTo(finding) {
    return finding.detector === "creditos_en_titulo" && finding.signature === "autores" && finding.entity.kind === "track" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const authors = finding.evidence["segments"] as string[] | undefined;
    if (!authors || !authors.length) return null;
    const cleanTitle = (finding.value ?? "").replace(/\s*[([]\s*[^()[\]]+\s*[)\]]\s*$/u, "").trim();
    if (!cleanTitle) return null;
    return { trackId: finding.entity.id, cleanTitle, authors };
  },
  async preconditions(finding, params, ctx) {
    const track = (await ctx.client.query("SELECT 1 FROM public.tracks WHERE id=$1", [params.trackId])).rowCount;
    if (!track) return [{ key: "exists", ok: false, code: "not_found", message: `pista ${params.trackId} inexistente` }];
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const track = (await ctx.client.query<{ title: string }>("SELECT title FROM public.tracks WHERE id=$1", [params.trackId])).rows[0];
    if (!track) return blockedPreview([{ kind: "track", id: params.trackId }], "not_found", "pista no encontrada");
    return {
      touched: [{ kind: "track", id: params.trackId }],
      before: { title: track.title },
      after: { title: params.cleanTitle, authors: params.authors },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    await withFieldJournal(context, { kind: "track", id: params.trackId, fields: ["title"] }, async () => {
      await updateEntity(context, "track", params.trackId, { title: params.cleanTitle });
    });
    const creditIds: number[] = [];
    for (const author of params.authors) {
      let personId: number;
      const existing = (await context.client.query<{ id: number }>("SELECT id FROM public.persons WHERE name=$1", [author])).rows[0];
      if (existing) {
        personId = existing.id;
      } else {
        const created = await createEntity(context, "person", { name: author }, { allowSimilar: true });
        personId = created.id;
      }
      const credit = await createRelation(context, "track_credit", { trackId: params.trackId, personId }, {
        credit_type: "composer",
        role: "Compositor",
      });
      creditIds.push(credit.id);
    }
    return { after: { title: params.cleanTitle, creditIds } };
  },
};

// ---------------------------------------------------------------------------
// 3. Conversión y vinculación (E6.2)
// ---------------------------------------------------------------------------

// 3.1 Convertir en organización existente
const convertirOrgExistenteParamsSchema = z.object({
  personId: z.number().int().positive(),
  organizationId: z.number().int().positive(),
}).strict();

export type ConvertirOrgExistenteParams = z.infer<typeof convertirOrgExistenteParamsSchema>;

export const convertirEnOrganizacionExistenteAction: FixActionDefinition<ConvertirOrgExistenteParams> = {
  key: "convertir_en_organizacion_existente",
  label: "Convertir en organización existente",
  description: "Absorbe la persona en la organización existente del mismo nombre pasando su trayectoria.",
  level: 1,
  inverse: "merge_undo",
  paramsSchema: convertirOrgExistenteParamsSchema,
  appliesTo(finding) {
    return finding.detector === "persona_es_organizacion" && finding.signature === "coincide_con_organizacion" && finding.entity.kind === "person" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const org = finding.related.find((r) => r.kind === "organization");
    if (!org || org.id === null) return null;
    return { personId: finding.entity.id, organizationId: org.id };
  },
  async preconditions(finding, params, ctx) {
    const person = (await ctx.client.query("SELECT 1 FROM public.persons WHERE id=$1", [params.personId])).rowCount;
    if (!person) return [{ key: "person_exists", ok: false, code: "not_found", message: `persona ${params.personId} inexistente` }];
    const org = (await ctx.client.query("SELECT 1 FROM public.organizations WHERE id=$1", [params.organizationId])).rowCount;
    if (!org) return [{ key: "org_exists", ok: false, code: "not_found", message: `organización ${params.organizationId} inexistente` }];
    return [{ key: "person_exists", ok: true }, { key: "org_exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const person = (await ctx.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    const org = (await ctx.client.query<{ name: string }>("SELECT name FROM public.organizations WHERE id=$1", [params.organizationId])).rows[0];
    if (!person || !org) return blockedPreview([{ kind: "person", id: params.personId }], "not_found", "persona u organización no encontradas");
    return {
      touched: [{ kind: "person", id: params.personId }, { kind: "organization", id: params.organizationId }],
      before: { personId: params.personId, name: person.name },
      after: { absorbedBy: { kind: "organization", id: params.organizationId, name: org.name } },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const outcome = await convertPerson(
      context.client, params.personId, { kind: "organization", id: params.organizationId },
      true, context.note, context.runId,
    );
    return { after: { status: outcome.status, detail: outcome.detail, credits: outcome.credits } };
  },
};

// 3.2 Inferencia de tipo de organización y creación
function inferOrgType(name: string): "record_label" | "production_company" | "recording_studio" | "distributor" | "management" | "other" {
  const norm = nameKey(name);
  if (/\b(?:estudio|estudios|studio|studios|sound|audio)\b/iu.test(norm)) return "recording_studio";
  if (/\b(?:records|discos|recordings|sello|label|fonografica)\b/iu.test(norm)) return "record_label";
  if (/\b(?:producciones|produccion|entertainment|films|media)\b/iu.test(norm)) return "production_company";
  if (/\b(?:distribuidora|distribucion|distribution)\b/iu.test(norm)) return "distributor";
  if (/\b(?:management|booking|representaciones)\b/iu.test(norm)) return "management";
  return "other";
}

const convertirCreandoOrgParamsSchema = z.object({
  personId: z.number().int().positive(),
  organizationName: z.string().min(1),
  organizationType: z.enum(["record_label", "production_company", "recording_studio", "distributor", "management", "other"]).optional(),
}).strict();

export type ConvertirCreandoOrgParams = z.infer<typeof convertirCreandoOrgParamsSchema>;

export const convertirCreandoOrganizacionAction: FixActionDefinition<ConvertirCreandoOrgParams> = {
  key: "convertir_creando_organizacion",
  label: "Convertir creando organización",
  description: "Crea una organización con el tipo inferido de su vocabulario y absorbe la ficha de persona.",
  level: 1,
  inverse: "merge_undo",
  paramsSchema: convertirCreandoOrgParamsSchema,
  appliesTo(finding) {
    return finding.detector === "persona_es_organizacion" && finding.signature === "vocabulario_de_organizacion" && finding.entity.kind === "person" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const name = finding.value ?? "";
    if (!name) return null;
    return { personId: finding.entity.id, organizationName: name, organizationType: inferOrgType(name) };
  },
  async preconditions(finding, params, ctx) {
    const person = (await ctx.client.query("SELECT 1 FROM public.persons WHERE id=$1", [params.personId])).rowCount;
    if (!person) return [{ key: "exists", ok: false, code: "not_found", message: `persona ${params.personId} inexistente` }];
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const person = (await ctx.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    if (!person) return blockedPreview([{ kind: "person", id: params.personId }], "not_found", "persona no encontrada");
    const type = params.organizationType ?? inferOrgType(params.organizationName);
    return {
      touched: [{ kind: "person", id: params.personId }],
      before: { personId: params.personId, name: person.name },
      after: { createsOrganization: params.organizationName, organizationType: type },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const type = params.organizationType ?? inferOrgType(params.organizationName);
    const org = await createEntity(context, "organization", { name: params.organizationName, organization_type: type }, { allowSimilar: true });
    const outcome = await convertPerson(
      context.client, params.personId, { kind: "organization", id: org.id },
      true, context.note, context.runId,
    );
    return { after: { createdOrgId: org.id, status: outcome.status, detail: outcome.detail } };
  },
};

// 3.3 Convertir en artista
const convertirEnArtistaParamsSchema = z.object({
  personId: z.number().int().positive(),
  artistId: z.number().int().positive().optional(),
  artistName: z.string().optional(),
}).strict();

export type ConvertirEnArtistaParams = z.infer<typeof convertirEnArtistaParamsSchema>;

export const convertirEnArtistaAction: FixActionDefinition<ConvertirEnArtistaParams> = {
  key: "convertir_en_artista",
  label: "Convertir en artista",
  description: "Absorbe la persona en el artista del mismo nombre (reemplazando sus créditos por créditos del artista).",
  level: 1,
  inverse: "merge_undo",
  paramsSchema: convertirEnArtistaParamsSchema,
  appliesTo(finding) {
    return finding.detector === "persona_con_nombre_de_artista" && finding.entity.kind === "person" && finding.entity.id !== null;
  },
  levelFor(finding) {
    // Si parece banda como persona, es opción A (nivel 1); si parece solista, es opción B (nivel 2)
    return finding.signature === "banda_como_persona" ? 1 : 2;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const artist = finding.related.find((r) => r.kind === "artist");
    const out: ConvertirEnArtistaParams = { personId: finding.entity.id };
    if (artist && artist.id !== null) {
      out.artistId = artist.id;
    } else {
      out.artistName = finding.value ?? "";
    }
    return out;
  },
  async preconditions(finding, params, ctx) {
    const person = (await ctx.client.query("SELECT 1 FROM public.persons WHERE id=$1", [params.personId])).rowCount;
    if (!person) return [{ key: "exists", ok: false, code: "not_found", message: `persona ${params.personId} inexistente` }];
    if (params.artistId) {
      const artist = (await ctx.client.query("SELECT 1 FROM public.artists WHERE id=$1", [params.artistId])).rowCount;
      if (!artist) return [{ key: "artist_exists", ok: false, code: "not_found", message: `artista ${params.artistId} inexistente` }];
    }
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const person = (await ctx.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    if (!person) return blockedPreview([{ kind: "person", id: params.personId }], "not_found", "persona no encontrada");
    return {
      touched: [{ kind: "person", id: params.personId }, ...(params.artistId ? [{ kind: "artist" as const, id: params.artistId }] : [])],
      before: { personId: params.personId, name: person.name },
      after: { targetArtist: params.artistId ?? params.artistName },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    let artistId = params.artistId;
    if (!artistId) {
      const name = params.artistName ?? finding.value ?? "";
      const created = await createEntity(context, "artist", { name }, { allowSimilar: true });
      artistId = created.id;
    }
    const outcome = await convertPerson(
      context.client, params.personId, { kind: "artist", id: artistId },
      true, context.note, context.runId,
    );
    return { after: { artistId, status: outcome.status, detail: outcome.detail } };
  },
};

// 3.4 Vincular como miembro
const vincularMiembroParamsSchema = z.object({
  personId: z.number().int().positive(),
  artistId: z.number().int().positive(),
  role: z.string().optional(),
}).strict();

export type VincularMiembroParams = z.infer<typeof vincularMiembroParamsSchema>;

export const vincularComoMiembroAction: FixActionDefinition<VincularMiembroParams> = {
  key: "vincular_como_miembro",
  label: "Vincular como miembro del artista",
  description: "Crea una membresía (artist_members) vinculando a la persona como miembro de la banda o proyecto.",
  level: 1,
  inverse: "relation_delete",
  paramsSchema: vincularMiembroParamsSchema,
  appliesTo(finding) {
    return finding.detector === "persona_con_nombre_de_artista" && finding.entity.kind === "person" && finding.entity.id !== null;
  },
  levelFor(finding) {
    // Si parece solista detrás del proyecto, es opción A (nivel 1); si parece banda, es opción B (nivel 2)
    return finding.signature === "solista_detras_del_proyecto" ? 1 : 2;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const artist = finding.related.find((r) => r.kind === "artist");
    if (!artist || artist.id === null) return null;
    return { personId: finding.entity.id, artistId: artist.id, role: "Miembro" };
  },
  async preconditions(finding, params, ctx) {
    const person = (await ctx.client.query("SELECT 1 FROM public.persons WHERE id=$1", [params.personId])).rowCount;
    if (!person) return [{ key: "person_exists", ok: false, code: "not_found", message: `persona ${params.personId} inexistente` }];
    const artist = (await ctx.client.query("SELECT 1 FROM public.artists WHERE id=$1", [params.artistId])).rowCount;
    if (!artist) return [{ key: "artist_exists", ok: false, code: "not_found", message: `artista ${params.artistId} inexistente` }];
    const existing = (await ctx.client.query(
      "SELECT 1 FROM public.artist_members WHERE person_id=$1 AND artist_id=$2", [params.personId, params.artistId],
    )).rowCount;
    if (existing) return [{ key: "not_linked", ok: false, code: "noop", message: "la persona ya es miembro del artista" }];
    return [{ key: "person_exists", ok: true }, { key: "artist_exists", ok: true }, { key: "not_linked", ok: true }];
  },
  async preview(finding, params, ctx) {
    const person = (await ctx.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    const artist = (await ctx.client.query<{ name: string }>("SELECT name FROM public.artists WHERE id=$1", [params.artistId])).rows[0];
    if (!person || !artist) return blockedPreview([{ kind: "person", id: params.personId }], "not_found", "persona o artista no encontrados");
    const role = params.role ?? "Miembro";
    return {
      touched: [{ kind: "person", id: params.personId }, { kind: "artist", id: params.artistId }],
      before: {},
      after: { membership: { person: person.name, artist: artist.name, role } },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const role = params.role ?? "Miembro";
    const relation = await createRelation(
      context, "artist_membership",
      { personId: params.personId, artistId: params.artistId },
      { role },
    );
    return { after: { membershipId: relation.id, role } };
  },
};

// ---------------------------------------------------------------------------
// 4. División de personas (E6.3)
// ---------------------------------------------------------------------------

const dividirPersonaParamsSchema = z.object({
  personId: z.number().int().positive(),
  into: z.array(z.string().min(1)).min(2),
}).strict();

export type DividirPersonaParams = z.infer<typeof dividirPersonaParamsSchema>;

export const dividirPersonaAction: FixActionDefinition<DividirPersonaParams> = {
  key: "dividir_persona",
  label: "Dividir persona combinada",
  description: "Divide una ficha que contiene varias personas creando fichas individuales y repartiendo la trayectoria.",
  level: 2,
  inverse: "merge_undo",
  paramsSchema: dividirPersonaParamsSchema,
  appliesTo(finding) {
    return finding.detector === "varias_personas_en_una" && finding.signature !== "alias_en_nombre" && finding.entity.kind === "person" && finding.entity.id !== null;
  },
  levelFor() {
    return 2;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const parts = finding.evidence["parts"] as string[] | undefined;
    if (!parts || parts.length < 2) return null;
    return { personId: finding.entity.id, into: parts };
  },
  async preconditions(finding, params, ctx) {
    const person = (await ctx.client.query("SELECT 1 FROM public.persons WHERE id=$1", [params.personId])).rowCount;
    if (!person) return [{ key: "exists", ok: false, code: "not_found", message: `persona ${params.personId} inexistente` }];
    if (params.into.length < 2) return [{ key: "destinations", ok: false, code: "invalid", message: "hacen falta al menos 2 personas destino" }];
    return [{ key: "exists", ok: true }, { key: "destinations", ok: true }];
  },
  async preview(finding, params, ctx) {
    const person = (await ctx.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    if (!person) return blockedPreview([{ kind: "person", id: params.personId }], "not_found", "persona no encontrada");
    return {
      touched: [{ kind: "person", id: params.personId }],
      before: { personId: params.personId, name: person.name },
      after: { splitInto: params.into },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const outcome = await splitPerson(context.client, params.personId, params.into, context.note, context.runId);
    return { after: { status: outcome.status, detail: outcome.detail, targetIds: outcome.targetIds } };
  },
};

// ---------------------------------------------------------------------------
// 5. Retiros y fusiones (E6.4, E6.5)
// ---------------------------------------------------------------------------

// 5.1 Retirar con créditos
const retirarConCreditosParamsSchema = z.object({
  personId: z.number().int().positive(),
}).strict();

export type RetirarConCreditosParams = z.infer<typeof retirarConCreditosParamsSchema>;

export const retirarConCreditosAction: FixActionDefinition<RetirarConCreditosParams> = {
  key: "retirar_con_creditos",
  label: "Retirar persona no válida y transferir datos",
  description: "Transfiere duración o notas al disco/pista correspondiente y retira la persona no válida y sus créditos.",
  level: 1,
  inverse: "entity_restore",
  paramsSchema: retirarConCreditosParamsSchema,
  appliesTo(finding) {
    return finding.detector === "persona_no_es_un_nombre" && finding.entity.kind === "person" && finding.entity.id !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding) {
    return finding.entity.id !== null ? { personId: finding.entity.id } : null;
  },
  async preconditions(finding, params, ctx) {
    const person = (await ctx.client.query("SELECT 1 FROM public.persons WHERE id=$1", [params.personId])).rowCount;
    if (!person) return [{ key: "exists", ok: false, code: "not_found", message: `persona ${params.personId} inexistente` }];
    return [{ key: "exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const person = (await ctx.client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    if (!person) return blockedPreview([{ kind: "person", id: params.personId }], "not_found", "persona no encontrada");
    const trackCredits = (await ctx.client.query<{ count: string }>(
      "SELECT count(*)::text FROM public.track_credits WHERE person_id=$1", [params.personId],
    )).rows[0]?.count ?? "0";
    const albumCredits = (await ctx.client.query<{ count: string }>(
      "SELECT count(*)::text FROM public.album_credits WHERE person_id=$1", [params.personId],
    )).rows[0]?.count ?? "0";
    return {
      touched: [{ kind: "person", id: params.personId }],
      before: { personId: params.personId, name: person.name, trackCredits: Number(trackCredits), albumCredits: Number(albumCredits) },
      after: { retired: true },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const client = context.client;
    const person = (await client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [params.personId])).rows[0];
    if (person) {
      const cls = classifyPersonName(person.name);
      // Si el nombre es una duración, transferir a las pistas que no tengan duración
      if (cls.kind === "duration") {
        const match = DURATION_RE.exec(person.name);
        if (match) {
          const seconds = Number(match[1]) * 60 + Number(match[2]);
          await client.query(`
            UPDATE public.tracks t
               SET duration_seconds = $1
              FROM public.track_credits tc
             WHERE tc.track_id = t.id AND tc.person_id = $2 AND t.duration_seconds IS NULL`,
          [seconds, params.personId]);
        }
      }
    }
    // Desconectar créditos y membresías
    await client.query("DELETE FROM public.track_credits WHERE person_id=$1", [params.personId]);
    await client.query("DELETE FROM public.album_credits WHERE person_id=$1", [params.personId]);
    await client.query("DELETE FROM public.artist_members WHERE person_id=$1", [params.personId]);
    await client.query("DELETE FROM public.person_organizations WHERE person_id=$1", [params.personId]);
    // Retirar entidad de forma auditada
    const removal = await deleteEntity(context, "person", params.personId);
    return { after: { retiredId: removal.id } };
  },
};

// 5.2 Retirar huérfana (re-verificando cero vínculos)
const retirarHuerfanaParamsSchema = z.object({
  kind: z.enum(["person", "organization", "artist"]),
  id: z.number().int().positive(),
}).strict();

export type RetirarHuerfanaParams = z.infer<typeof retirarHuerfanaParamsSchema>;

export const retirarHuerfanaAction: FixActionDefinition<RetirarHuerfanaParams> = {
  key: "retirar_huerfana",
  label: "Retirar ficha huérfana",
  description: "Comprueba que la ficha tenga efectivamente cero vínculos en el catálogo y la elimina de forma auditada.",
  level: 0,
  inverse: "entity_restore",
  paramsSchema: retirarHuerfanaParamsSchema,
  appliesTo(finding) {
    return finding.detector === "fichas_sin_vinculos" && (finding.entity.kind === "person" || finding.entity.kind === "organization" || finding.entity.kind === "artist") && finding.entity.id !== null;
  },
  levelFor() {
    return 0;
  },
  async defaultParams(finding) {
    if (finding.entity.id === null) return null;
    const kind = finding.entity.kind as "person" | "organization" | "artist";
    return { kind, id: finding.entity.id };
  },
  async preconditions(finding, params, ctx) {
    const table = ENTITY_SPECS[params.kind].table;
    const exists = (await ctx.client.query(`SELECT 1 FROM public.${table} WHERE id=$1`, [params.id])).rowCount;
    if (!exists) return [{ key: "exists", ok: false, code: "not_found", message: `${params.kind} ${params.id} inexistente` }];
    // Re-verificar cero dependientes
    let links = 0;
    if (params.kind === "person") {
      const q = (await ctx.client.query<{ count: string }>(`
        SELECT (
          (SELECT count(*) FROM public.album_credits WHERE person_id=$1) +
          (SELECT count(*) FROM public.track_credits WHERE person_id=$1) +
          (SELECT count(*) FROM public.artist_members WHERE person_id=$1) +
          (SELECT count(*) FROM public.person_organizations WHERE person_id=$1)
        )::text AS count`, [params.id])).rows[0];
      links = Number(q?.count ?? 0);
    } else if (params.kind === "organization") {
      const q = (await ctx.client.query<{ count: string }>(`
        SELECT (
          (SELECT count(*) FROM public.albums WHERE label_id=$1) +
          (SELECT count(*) FROM public.album_credits WHERE organization_id=$1) +
          (SELECT count(*) FROM public.track_credits WHERE organization_id=$1) +
          (SELECT count(*) FROM public.person_organizations WHERE organization_id=$1)
        )::text AS count`, [params.id])).rows[0];
      links = Number(q?.count ?? 0);
    } else if (params.kind === "artist") {
      const q = (await ctx.client.query<{ count: string }>(`
        SELECT (
          (SELECT count(*) FROM public.albums WHERE artist_id=$1) +
          (SELECT count(*) FROM public.artist_members WHERE artist_id=$1) +
          (SELECT count(*) FROM public.album_credits WHERE artist_id=$1) +
          (SELECT count(*) FROM public.track_credits WHERE artist_id=$1)
        )::text AS count`, [params.id])).rows[0];
      links = Number(q?.count ?? 0);
    }
    if (links > 0) return [{ key: "zero_links", ok: false, code: "not_applicable", message: `la ficha ya tiene ${links} vínculos` }];
    return [{ key: "exists", ok: true }, { key: "zero_links", ok: true }];
  },
  async preview(finding, params, ctx) {
    const table = ENTITY_SPECS[params.kind].table;
    const row = (await ctx.client.query<{ name: string }>(`SELECT name FROM public.${table} WHERE id=$1`, [params.id])).rows[0];
    if (!row) return blockedPreview([{ kind: params.kind, id: params.id }], "not_found", "entidad no encontrada");
    return {
      touched: [{ kind: params.kind, id: params.id }],
      before: { id: params.id, name: row.name },
      after: { retired: true },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const removal = await deleteEntity(context, params.kind, params.id);
    return { after: { retiredId: removal.id } };
  },
};

// 5.3 Fusión de discos (PLAN_CURADURIA E6.5)
const fusionarDiscosParamsSchema = z.object({
  keepId: z.number().int().positive(),
  dropId: z.number().int().positive(),
  keepDropNameAsAlias: z.boolean().optional(),
}).strict();

export type FusionarDiscosParams = z.infer<typeof fusionarDiscosParamsSchema>;

function albumPairOf(finding: ActionFinding): [number, number] | null {
  const pair = finding.evidence["pair"];
  if (Array.isArray(pair) && pair.length === 2) {
    const [a, b] = pair.map(Number);
    if (Number.isInteger(a) && Number.isInteger(b) && a! > 0 && b! > 0 && a !== b) return [a!, b!];
  }
  return null;
}

export const fusionarDiscosAction: FixActionDefinition<FusionarDiscosParams> = {
  key: "fusionar_discos",
  label: "Fusionar discos repetidos",
  description: "Fusiona dos discos emparejando pistas, unificando créditos y formatos equivalentes y repuntando medios.",
  level: 1,
  inverse: "merge_undo",
  paramsSchema: fusionarDiscosParamsSchema,
  appliesTo(finding) {
    return finding.detector === "discos_repetidos" && albumPairOf(finding) !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding, ctx) {
    const pair = albumPairOf(finding);
    if (!pair) return null;
    const preview = await previewAlbumMerge(ctx.client, pair[0], pair[1]);
    return { keepId: preview.recommendedKeepId, dropId: preview.recommendedKeepId === pair[0] ? pair[1] : pair[0] };
  },
  async preconditions(finding, params, ctx) {
    const keep = (await ctx.client.query("SELECT 1 FROM public.albums WHERE id=$1", [params.keepId])).rowCount;
    if (!keep) return [{ key: "keep_exists", ok: false, code: "not_found", message: `álbum ${params.keepId} inexistente` }];
    const drop = (await ctx.client.query("SELECT 1 FROM public.albums WHERE id=$1", [params.dropId])).rowCount;
    if (!drop) return [{ key: "drop_exists", ok: false, code: "not_found", message: `álbum ${params.dropId} inexistente` }];
    return [{ key: "keep_exists", ok: true }, { key: "drop_exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    try {
      const p = await previewAlbumMerge(ctx.client, params.keepId, params.dropId);
      return {
        touched: [{ kind: "album", id: params.keepId }, { kind: "album", id: params.dropId }],
        before: { keep: { id: p.keep.id, title: p.keep.title }, drop: { id: p.drop.id, title: p.drop.title } },
        after: { keptId: p.keep.id, tracksMerged: p.matchedTracks.length, tracksMoved: p.unmatchedDropTracks.length },
        blocked: null,
        collisions: [],
        warnings: p.warnings,
        proposal: null,
        hashMaterial: p.previewHash,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return blockedPreview([{ kind: "album", id: params.keepId }, { kind: "album", id: params.dropId }], "invalid", msg);
    }
  },
  async apply(context, finding, params, _preview) {
    const p = await previewAlbumMerge(context.client, params.keepId, params.dropId);
    const outcome = await mergeAlbums(context, {
      keepId: params.keepId,
      dropId: params.dropId,
      previewHash: p.previewHash,
      keepDropNameAsAlias: params.keepDropNameAsAlias,
    });
    return { after: { ...outcome } };
  },
};

// 5.4 Retirar pista duplicada
const retirarPistaDuplicadaParamsSchema = z.object({
  keepTrackId: z.number().int().positive(),
  dropTrackId: z.number().int().positive(),
}).strict();

export type RetirarPistaDuplicadaParams = z.infer<typeof retirarPistaDuplicadaParamsSchema>;

function trackPairOf(finding: ActionFinding): [number, number] | null {
  const pair = finding.evidence["pair"];
  if (Array.isArray(pair) && pair.length === 2) {
    const [a, b] = pair.map(Number);
    if (Number.isInteger(a) && Number.isInteger(b) && a! > 0 && b! > 0 && a !== b) return [a!, b!];
  }
  return null;
}

export const retirarPistaDuplicadaAction: FixActionDefinition<RetirarPistaDuplicadaParams> = {
  key: "retirar_pista_duplicada",
  label: "Retirar pista duplicada",
  description: "Fusiona la pista duplicada en la pista principal unificando sus créditos y enlaces.",
  level: 1,
  inverse: "merge_undo",
  paramsSchema: retirarPistaDuplicadaParamsSchema,
  appliesTo(finding) {
    return finding.detector === "pistas_repetidas" && trackPairOf(finding) !== null;
  },
  levelFor() {
    return 1;
  },
  async defaultParams(finding, ctx) {
    const pair = trackPairOf(finding);
    if (!pair) return null;
    const [a, b] = pair;
    const creditsA = (await ctx.client.query<{ c: string }>("SELECT count(*)::text AS c FROM public.track_credits WHERE track_id=$1", [a])).rows[0]?.c ?? "0";
    const creditsB = (await ctx.client.query<{ c: string }>("SELECT count(*)::text AS c FROM public.track_credits WHERE track_id=$1", [b])).rows[0]?.c ?? "0";
    const keepTrackId = Number(creditsA) >= Number(creditsB) ? a : b;
    const dropTrackId = keepTrackId === a ? b : a;
    return { keepTrackId, dropTrackId };
  },
  async preconditions(finding, params, ctx) {
    const keep = (await ctx.client.query("SELECT 1 FROM public.tracks WHERE id=$1", [params.keepTrackId])).rowCount;
    if (!keep) return [{ key: "keep_exists", ok: false, code: "not_found", message: `pista ${params.keepTrackId} inexistente` }];
    const drop = (await ctx.client.query("SELECT 1 FROM public.tracks WHERE id=$1", [params.dropTrackId])).rowCount;
    if (!drop) return [{ key: "drop_exists", ok: false, code: "not_found", message: `pista ${params.dropTrackId} inexistente` }];
    return [{ key: "keep_exists", ok: true }, { key: "drop_exists", ok: true }];
  },
  async preview(finding, params, ctx) {
    const keep = (await ctx.client.query<{ title: string; track_number: number }>("SELECT title, track_number FROM public.tracks WHERE id=$1", [params.keepTrackId])).rows[0];
    const drop = (await ctx.client.query<{ title: string; track_number: number }>("SELECT title, track_number FROM public.tracks WHERE id=$1", [params.dropTrackId])).rows[0];
    if (!keep || !drop) return blockedPreview([{ kind: "track", id: params.keepTrackId }], "not_found", "pistas no encontradas");
    return {
      touched: [{ kind: "track", id: params.keepTrackId }, { kind: "track", id: params.dropTrackId }],
      before: { keep: { id: params.keepTrackId, title: keep.title, number: keep.track_number }, drop: { id: params.dropTrackId, title: drop.title, number: drop.track_number } },
      after: { keptId: params.keepTrackId, merged: true },
      blocked: null,
      collisions: [],
      warnings: [],
      proposal: null,
    };
  },
  async apply(context, finding, params) {
    const outcome = await mergeInto(context.client, "track", params.keepTrackId, params.dropTrackId, context.note, context.runId, { alias: false });
    return { after: { moved: outcome.moved, discarded: outcome.discarded, auditId: outcome.auditId } };
  },
};

// ---------------------------------------------------------------------------
// Lista consolidada de acciones estructurales
// ---------------------------------------------------------------------------

// El registro heterogéneo la ensancha con `erase` (registry.ts); aquí se fija
// el genérico por defecto para que la inferencia de la unión no se pierda.
export const STRUCTURAL_ACTIONS: readonly FixActionDefinition[] = [
  fijarTipoDeDiscoAction,
  vaciarAnioAction,
  fijarAnioFormacionAction,
  vaciarDuracionAction,
  corregirUnidadesAction,
  renumerarConsecutivoAction,
  moverDuracionAction,
  extraerInterpreteAction,
  extraerInterpreteCreandoAction,
  extraerInvitadoAction,
  extraerAutoresAction,
  convertirEnOrganizacionExistenteAction,
  convertirCreandoOrganizacionAction,
  convertirEnArtistaAction,
  vincularComoMiembroAction,
  dividirPersonaAction,
  retirarConCreditosAction,
  retirarHuerfanaAction,
  fusionarDiscosAction,
  retirarPistaDuplicadaAction,
];
