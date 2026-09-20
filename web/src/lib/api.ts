// CRV · Cliente de la API (src/api/*). El navegador solo habla con esta API,
// nunca con PostgreSQL (CONTRACT #20) — cada función de aquí es una llamada
// HTTP directa, sin lógica de negocio propia.
import { getSessionCsrf, setSessionCsrf, type OperatorUser } from "./operator";
import type {
  Alias, AliasWriteResult, AlbumDetail, AlbumListItem, ArtistDetail, ArtistListItem, AuditRow, Claim, EntityWriteResult,
  MergeableKind, OrganizationDetail, OrganizationListItem, Page, PersonDetail, PersonListItem, RelationUpdateResult, RelationWriteResult,
  PersonConversionResult, PersonDuplicateCandidate, PersonMergePreview, PersonMergeResult, RemovalResult, ReviewActionResult,
  ReviewDetail, ReviewListItem, SearchResults, Source, UnmergeResult, VideoDetail, VideoListItem,
  TrackDetail, TrackListItem,
  CurationFinding, CurationFindingStatus, CurationIgnoreReason, CurationPairKind, CurationScan, CurationScanResult,
  CurationSeverity, CurationSummary,
  AlbumMergePreview, AlbumMergeResult, PersonSplitPreview, PersonSplitResult,
  FindingActionsResult, FixBatch, FixBatchSummary, DistinctPair, ConflictResolveResult, ConflictResolveGroupResult,
} from "./types";

/**
 * Dónde vive la API. `VITE_API_BASE_URL` manda si está definida. Si no, un
 * build publicado bajo un prefijo (`build:public` → `/crv/`) habla con la API
 * del mismo origen en `<prefijo>api` (web/server.mjs la reenvía): así no
 * depende de recordar la variable. Sin prefijo (desarrollo) queda la API local.
 *
 * Pasado real (2026-09-15 y 2026-09-16): publicar sin la variable dejó el
 * bundle apuntando a http://127.0.0.1:8080 —el equipo de quien visita, no el
 * servidor— y nadie podía iniciar sesión desde el dominio público.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function apiBaseUrl(): string {
  const configured = (import.meta.env["VITE_API_BASE_URL"] as string | undefined)?.trim();
  const prefix = import.meta.env.BASE_URL;
  const sameOrigin = prefix && prefix !== "/" ? `${prefix.replace(/\/$/u, "")}/api` : null;
  // Una ruta relativa («/crv/api») se resuelve contra el origen de la página.
  const resolved = new URL(configured || sameOrigin || "http://127.0.0.1:8080", window.location.origin);
  // Una página abierta desde un dominio real nunca puede alcanzar una API en
  // loopback (sería el equipo del visitante, y la CSP la bloquea): se usa la
  // del mismo origen aunque el build traiga la dirección local.
  if (sameOrigin && LOOPBACK_HOSTS.has(resolved.hostname) && !LOOPBACK_HOSTS.has(window.location.hostname)) {
    return new URL(sameOrigin, window.location.origin).toString();
  }
  return resolved.toString();
}

const BASE_URL = apiBaseUrl();

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

function buildUrl(path: string, query?: Query): string {
  // La API puede vivir en el origen (desarrollo) o bajo un prefijo detrás de
  // un proxy, por ejemplo /crv/api en Tailscale Funnel. Un path que empieza
  // por / haría que URL descartase ese prefijo, por lo que se normaliza aquí.
  const base = BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`;
  const url = new URL(path.replace(/^\/+/, ""), base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: object;
  body?: unknown;
  /** Esta llamada escribe: exige el token del operador. */
  authenticated?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.authenticated) {
    const csrf = getSessionCsrf();
    if (!csrf) throw new ApiError(401, "missing_session", "Inicia sesión para poder editar.");
    headers["x-crv-csrf"] = csrf;
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: "include",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };
  const response = await fetch(buildUrl(path, options.query as Query | undefined), init);
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
    if (options.authenticated && response.status === 401) {
      setSessionCsrf("");
      window.dispatchEvent(new Event("crv-session-expired"));
    }
    throw new ApiError(response.status, error?.code ?? "unknown", error?.message ?? response.statusText, error?.details);
  }
  return json as T;
}

export interface AuthSession {
  user: OperatorUser;
  csrf: string;
}

export const authApi = {
  me: async () => {
    const session = await request<AuthSession>("/auth/me");
    setSessionCsrf(session.csrf);
    return session;
  },
  login: async (username: string, password: string) => {
    const session = await request<AuthSession>("/auth/login", { method: "POST", body: { username, password } });
    setSessionCsrf(session.csrf);
    return session;
  },
  logout: async () => {
    await request<void>("/auth/logout", { method: "POST", authenticated: true });
    setSessionCsrf("");
  },
};

export interface Paged { limit?: number; offset?: number; }

// ---------- lectura ----------
export const searchApi = {
  search: (q: string, types?: string[], limit = 20) =>
    request<SearchResults>("/search", { query: { q, limit, ...(types?.length ? { types: types.join(",") } : {}) } }),
};

export const artistsApi = {
  list: (params: Paged & { q?: string } = {}) => request<Page<ArtistListItem>>("/artists", { query: params }),
  get: (id: number) => request<ArtistDetail>(`/artists/${id}`),
};

export const albumsApi = {
  list: (params: Paged & { q?: string; artistId?: number } = {}) => request<Page<AlbumListItem>>("/albums", { query: params }),
  get: (id: number) => request<AlbumDetail>(`/albums/${id}`),
};

export const personsApi = {
  list: (params: Paged & { q?: string; hasCredits?: boolean; suspect?: string; sort?: "name" | "credits" } = {}) =>
    request<Page<PersonListItem>>("/persons", { query: params }),
  get: (id: number) => request<PersonDetail>(`/persons/${id}`),
};

// ---------- fusión de personas (E11.3/E11.4/E11.5) ----------
export interface PersonMergeRequest {
  dropId: number;
  previewHash: string;
  fieldChoices?: Partial<Record<string, "keep" | "drop">>;
  keepDropNameAsAlias: boolean;
  note: string;
}

const MERGE_PATHS: Record<MergeableKind, string> = { person: "persons", organization: "organizations", artist: "artists" };

export const entityMergeApi = {
  /** Previsualización de la fusión de dos fichas del mismo kind (E11.3/E11.10). */
  preview: (kind: MergeableKind, keepId: number, dropId: number) =>
    request<PersonMergePreview>(`/${MERGE_PATHS[kind]}/${keepId}/merge-preview`, { query: { with: dropId } }),
  merge: (kind: MergeableKind, keepId: number, body: PersonMergeRequest) =>
    request<PersonMergeResult>(`/${MERGE_PATHS[kind]}/${keepId}/merge`, { method: "POST", authenticated: true, body }),
  duplicateCandidates: (params: Paged & { minScore?: number } = {}) =>
    request<Page<PersonDuplicateCandidate>>("/persons/duplicate-candidates", { query: params }),
  convert: (personId: number, body: {
    to: "organization" | "artist";
    targetId?: number;
    create?: { name: string; organizationType?: string; artistType?: string };
    keepNameAsAlias: boolean;
    note: string;
  }) => request<PersonConversionResult>(`/persons/${personId}/convert`, { method: "POST", authenticated: true, body }),
  undo: (mergeRunId: number, note: string) =>
    request<UnmergeResult>(`/merge-runs/${mergeRunId}/undo`, { method: "POST", authenticated: true, body: { note } }),
};

// ---------- fusión de discos (E6.5; la API ya la ofrecía, la web no) ----------
export interface AlbumMergeRequest {
  dropId: number;
  previewHash: string;
  fieldChoices?: Record<string, "keep" | "drop">;
  keepDropNameAsAlias: boolean;
  note: string;
}

export const albumMergeApi = {
  preview: (keepId: number, dropId: number) =>
    request<AlbumMergePreview>(`/albums/${keepId}/merge-preview`, { query: { with: dropId } }),
  merge: (keepId: number, body: AlbumMergeRequest) =>
    request<AlbumMergeResult>(`/albums/${keepId}/merge`, { method: "POST", authenticated: true, body }),
};

// ---------- división de personas (E6.3) ----------
export const personSplitApi = {
  preview: (personId: number, into: string[]) =>
    request<PersonSplitPreview>(`/persons/${personId}/split-preview`, { query: { into: into.join(",") } }),
  split: (personId: number, into: string[], note: string) =>
    request<PersonSplitResult>(`/persons/${personId}/split`, { method: "POST", authenticated: true, body: { into, note } }),
};

export const organizationsApi = {
  list: (params: Paged & { q?: string } = {}) => request<Page<OrganizationListItem>>("/organizations", { query: params }),
  get: (id: number) => request<OrganizationDetail>(`/organizations/${id}`),
};

/** Lectura de pistas (auditoría #7: el CRUD era asimétrico, sin GET). */
export const tracksApi = {
  list: (params: Paged & { q?: string; albumId?: number } = {}) => request<Page<TrackListItem>>("/tracks", { query: params }),
  get: (id: number) => request<TrackDetail>(`/tracks/${id}`),
};

export const sourcesApi = {
  list: () => request<Source[]>("/sources"),
  get: (id: number) => request<Source & { lastRun: { id: number; kind: string; status: string; startedAt: string; finishedAt: string | null } | null }>(`/sources/${id}`),
};

export const claimsApi = {
  forEntity: (entity: "artist" | "person" | "organization" | "album" | "track", id: number, params: Paged = {}) =>
    request<Page<Claim>>("/claims", { query: { entity, id, ...params } }),
};

export const auditApi = {
  forEntity: (entity: string, id: number, params: Paged = {}) => request<Page<AuditRow>>("/audit", { query: { entity, id, ...params } }),
  run: (id: number) => request<{ id: number; kind: string; status: string; sourceId: number | null; startedAt: string; finishedAt: string | null; params: unknown; counters: unknown; errorLog: string | null }>(`/runs/${id}`),
};

export const youtubeApi = {
  list: (params: Paged & { q?: string } = {}) => request<Page<VideoListItem>>("/youtube/videos", { query: params }),
  get: (id: number) => request<VideoDetail>(`/youtube/videos/${id}`),
};

export const reviewApi = {
  list: (params: Paged & { status?: string; kind?: string } = {}) => request<Page<ReviewListItem>>("/review-queue", { query: params }),
  get: (id: number) => request<ReviewDetail>(`/review-queue/${id}`),
  accept: (id: number, note: string, targetId?: number) =>
    request<ReviewActionResult>(`/review-queue/${id}/accept`, { method: "POST", authenticated: true, body: { note, ...(targetId === undefined ? {} : { targetId }) } }),
  reject: (id: number, note: string) =>
    request<ReviewActionResult>(`/review-queue/${id}/reject`, { method: "POST", authenticated: true, body: { note } }),
  resolveConflict: (id: number, note: string, choice?: string, value?: string | number | boolean | null) =>
    request<ReviewActionResult>(`/review-queue/${id}/resolve-conflict`, {
      method: "POST", authenticated: true,
      body: { note, ...(choice === undefined ? {} : { choice }), ...(value === undefined ? {} : { value }) },
    }),
  setPriority: (id: number, priority: number, note: string) =>
    request<{ reviewId: number; priority: number; runId: number }>(`/review-queue/${id}/priority`, {
      method: "PATCH", authenticated: true, body: { priority, note },
    }),
};

export interface CurationFindingQuery extends Paged {
  category?: string;
  detector?: string;
  signature?: string;
  severity?: CurationSeverity;
  entityKind?: string;
  status?: CurationFindingStatus | "all";
  q?: string;
  scanId?: number;
  chained?: boolean;
}

/** Filtro de una acción de grupo: el mismo que el listado, sin paginar ni estado (siempre `open`). */
export interface CurationFindingGroupFilter {
  category: string;
  detector: string;
  signature?: string;
  severity?: CurationSeverity;
  entityKind?: string;
  q?: string;
  scanId?: number;
  chained?: boolean;
}

/**
 * Filtro de «marcar como revisado» en grupo (E8.7): los mismos filtros de la
 * pantalla, sin exigir categoría ni detector — «Surgidos tras corregir» los
 * cruza todos. `chained` no viaja: la API siempre lo da por cierto.
 */
export interface CurationChainGroupFilter {
  category?: string;
  detector?: string;
  signature?: string;
  severity?: CurationSeverity;
  entityKind?: string;
  status?: CurationFindingStatus | "all";
  q?: string;
  scanId?: number;
}

/** Cuerpo de `POST /curation/fixes/preview` (E4): todo lote nace de una vista previa. */
export interface CurationFixesPreviewRequest {
  mode: "individual" | "selected" | "group";
  findingIds?: number[];
  filter?: CurationFindingGroupFilter;
  actionKey?: string;
  overrides?: {
    params?: Record<string, unknown>;
    byFinding?: Record<string, { actionKey?: string; params?: Record<string, unknown> }>;
  };
}

export const curationApi = {
  summary: () => request<CurationSummary>("/curation/summary"),
  findings: (params: CurationFindingQuery = {}) => request<Page<CurationFinding>>("/curation/findings", { query: params }),
  finding: (id: number) => request<CurationFinding>(`/curation/findings/${id}`),
  /** Acciones de corrección ofrecidas para un hallazgo, con la recomendada primero (E4). */
  findingsActions: (id: number) => request<FindingActionsResult>(`/curation/findings/${id}/actions`),
  scans: (limit = 20) => request<{ data: CurationScan[] }>("/curation/scans", { query: { limit } }),
  scan: () => request<CurationScanResult>("/curation/scan", { method: "POST", authenticated: true }),
  ignore: (id: number, reason: CurationIgnoreReason, note: string) =>
    request<CurationFinding>(`/curation/findings/${id}/ignore`, { method: "POST", authenticated: true, body: note ? { reason, note } : { reason } }),
  reopen: (id: number) => request<CurationFinding>(`/curation/findings/${id}/reopen`, { method: "POST", authenticated: true }),
  // ---- Valores en disputa sin revisión viva (E7.1): resolver un conflicto directo ----
  resolveConflict: (id: number, note: string, choice?: "a" | "b" | "both" | "dismiss", value?: string | number | boolean | null) =>
    request<ConflictResolveResult>(`/curation/findings/${id}/resolve-conflict`, {
      method: "POST", authenticated: true,
      body: { note, ...(choice === undefined ? {} : { choice }), ...(value === undefined ? {} : { value }) },
    }),
  resolveConflictsGroup: (input: CurationFindingGroupFilter & { note: string }) =>
    request<ConflictResolveGroupResult>("/curation/findings/resolve-conflicts-group", { method: "POST", authenticated: true, body: input }),
  ignoreGroup: (input: CurationFindingGroupFilter & { reason: CurationIgnoreReason; note: string }) =>
    request<{ ignored: number }>("/curation/findings/ignore-group", { method: "POST", authenticated: true, body: input }),
  declareDistinct: (input: { kind: CurationPairKind; aId: number; bId: number; note: string }) =>
    request<{ created: boolean }>("/curation/distinct-pairs", { method: "POST", authenticated: true, body: input }),
  distinctPairs: (params: Paged = {}) => request<Page<DistinctPair>>("/curation/distinct-pairs", { query: params }),
  retractDistinct: (id: number) =>
    request<{ pair: DistinctPair }>(`/curation/distinct-pairs/${id}`, { method: "DELETE", authenticated: true }),
  // ---- Lotes de corrección (E4): vista previa → aplicar → deshacer ----
  fixesPreview: (body: CurationFixesPreviewRequest) =>
    request<FixBatch>("/curation/fixes/preview", { method: "POST", authenticated: true, body }),
  fixApply: (batchId: number, input: { previewHash: string; excludeItemIds?: number[]; note: string }) =>
    request<FixBatch>(`/curation/fixes/${batchId}/apply`, { method: "POST", authenticated: true, body: input }),
  fixUndo: (batchId: number, note: string) =>
    request<FixBatch>(`/curation/fixes/${batchId}/undo`, { method: "POST", authenticated: true, body: { note } }),
  /** Historial de lotes (E8.5); sin `status` la API omite las vistas previas que nadie aplicó. */
  fixes: (params: Paged & { mode?: string; status?: string } = {}) =>
    request<Page<FixBatchSummary>>("/curation/fixes", { query: params }),
  fix: (batchId: number, params: Paged & { status?: string } = {}) =>
    request<FixBatch>(`/curation/fixes/${batchId}`, { query: params }),
  // ---- «Surgidos tras corregir» dados por revisados (E8.7) ----
  acknowledgeChain: (id: number) =>
    request<CurationFinding>(`/curation/findings/${id}/acknowledge-chain`, { method: "POST", authenticated: true }),
  acknowledgeChainGroup: (filter: CurationChainGroupFilter) =>
    request<{ acknowledged: number }>("/curation/findings/acknowledge-chain-group", { method: "POST", authenticated: true, body: filter }),
};

// ---------- escritura de entidades del core ----------
export type EntityPath = "artists" | "persons" | "organizations" | "albums" | "tracks";

function entityWriteApi(path: EntityPath) {
  return {
    create: (values: Record<string, unknown>) =>
      request<EntityWriteResult>(`/${path}`, { method: "POST", authenticated: true, body: values }),
    update: (id: number, values: Record<string, unknown>) =>
      request<EntityWriteResult>(`/${path}/${id}`, { method: "PATCH", authenticated: true, body: values }),
    remove: (id: number, note?: string) =>
      request<RemovalResult>(`/${path}/${id}`, { method: "DELETE", authenticated: true, query: note ? { note } : {} }),
  };
}

export const artistWrites = entityWriteApi("artists");
export const personWrites = entityWriteApi("persons");
export const organizationWrites = entityWriteApi("organizations");
export const albumWrites = entityWriteApi("albums");
export const trackWrites = entityWriteApi("tracks");

// ---------- escritura de relaciones puente ----------
export type RelationPath = "artist-members" | "person-organizations" | "album-credits" | "track-credits" | "album-formats";

function relationWriteApi(path: RelationPath) {
  return {
    create: (values: Record<string, unknown>) =>
      request<RelationWriteResult>(`/${path}`, { method: "POST", authenticated: true, body: values }),
    update: (id: number, values: Record<string, unknown>) =>
      request<RelationUpdateResult>(`/${path}/${id}`, { method: "PATCH", authenticated: true, body: values }),
    remove: (id: number, note?: string) =>
      request<RemovalResult>(`/${path}/${id}`, { method: "DELETE", authenticated: true, query: note ? { note } : {} }),
  };
}

export const artistMemberWrites = relationWriteApi("artist-members");
export const personOrganizationWrites = relationWriteApi("person-organizations");
export const albumCreditWrites = relationWriteApi("album-credits");
export const trackCreditWrites = relationWriteApi("track-credits");
export const albumFormatWrites = relationWriteApi("album-formats");

// ---------- escritura de alias ----------
function aliasWriteApi(path: EntityPath) {
  return {
    create: (entityId: number, input: { alias: string; aliasType: string; isPrimary: boolean; note?: string }) =>
      request<AliasWriteResult>(`/${path}/${entityId}/aliases`, { method: "POST", authenticated: true, body: input }),
    update: (entityId: number, aliasId: number, input: Partial<Pick<Alias, "alias" | "aliasType" | "isPrimary">> & { note?: string }) =>
      request<AliasWriteResult>(`/${path}/${entityId}/aliases/${aliasId}`, { method: "PATCH", authenticated: true, body: input }),
    remove: (entityId: number, aliasId: number, note?: string) =>
      request<{ id: number; entityId: number; runId: number }>(`/${path}/${entityId}/aliases/${aliasId}`, {
        method: "DELETE", authenticated: true, query: note ? { note } : {},
      }),
  };
}

export const aliasWrites: Record<EntityPath, ReturnType<typeof aliasWriteApi>> = {
  artists: aliasWriteApi("artists"),
  persons: aliasWriteApi("persons"),
  organizations: aliasWriteApi("organizations"),
  albums: aliasWriteApi("albums"),
  tracks: aliasWriteApi("tracks"),
};
