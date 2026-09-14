import { getEnv } from "../config/env.js";

export interface YouTubeApiResponse<T> { items?: T[]; nextPageToken?: string; }
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_RETRIES = 3;

/** Costo en unidades de cuota de cada método usado (tabla oficial de YouTube Data API v3). */
export const QUOTA_COST = { videos: 1, channels: 1, playlistItems: 1, search: 100 } as const;
/** Techo de resultados de una búsqueda dirigida: search.list admite 50, aquí nunca se pide más. */
export const SEARCH_MAX_RESULTS = 25;

export interface YouTubeSearchItem { id?: { kind?: string; videoId?: string }; snippet?: Record<string, unknown>; }
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export class YouTubeDataApi {
  constructor(private readonly apiKey = getEnv().YOUTUBE_API_KEY, private readonly fetcher: FetchLike = fetch) {}

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    if (!this.apiKey) throw new Error("YOUTUBE_API_KEY no está configurada. Configure la clave para ejecutar sincronización live de YouTube.");
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [name, value] of Object.entries({ ...params, key: this.apiKey })) url.searchParams.set(name, value);
    // Un 5xx o un 429 aislado no debe costar un barrido entero. La cuota
    // agotada y la clave inválida (403/400) son terminales: reintentarlas
    // solo gasta tiempo y, si hubiera cuota, la gastaría también.
    let last = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      const response = await this.fetcher(url, { headers: { accept: "application/json" } });
      if (response.ok) return response.json() as Promise<T>;
      last = `HTTP ${response.status} ${await response.text()}`;
      if (response.status !== 429 && response.status < 500) break;
    }
    throw new Error(`YouTube Data API ${path}: ${last}`);
  }

  listVideos(ids: string[]): Promise<YouTubeApiResponse<YouTubeVideoPayload>> {
    if (!ids.length) return Promise.resolve({ items: [] });
    return this.request("videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
  }
  getChannel(id: string): Promise<YouTubeApiResponse<YouTubeChannelPayload>> {
    // `statistics` trae videoCount: la cifra declarada del canal, que es el
    // contraste contra lo que el barrido del playlist llega a ver.
    return this.request("channels", { part: "snippet,contentDetails,statistics,status", id });
  }
  listPlaylistItems(playlistId: string, pageToken?: string): Promise<YouTubeApiResponse<YouTubePlaylistItemPayload>> {
    return this.request("playlistItems", { part: "snippet,contentDetails,status", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
  }
  /**
   * Búsqueda dirigida DENTRO de un canal (100 unidades por llamada). Nunca se
   * busca en todo YouTube: el canal del proyecto es la verdad (regla 1) y un
   * video ajeno no puede proponerse como enlace de un disco.
   */
  searchChannelVideos(channelId: string, query: string, maxResults = 10): Promise<YouTubeApiResponse<YouTubeSearchItem>> {
    if (!channelId.trim() || !query.trim()) throw new Error("searchChannelVideos exige canal y consulta");
    const limit = Math.min(Math.max(Math.trunc(maxResults), 1), SEARCH_MAX_RESULTS);
    return this.request("search", { part: "snippet", channelId, q: query, type: "video", maxResults: String(limit) });
  }
}

export interface YouTubeVideoPayload { id: string; snippet?: Record<string, unknown>; contentDetails?: Record<string, unknown>; status?: Record<string, unknown>; [key: string]: unknown; }
export interface YouTubeChannelPayload { id: string; snippet?: Record<string, unknown>; contentDetails?: Record<string, unknown>; statistics?: Record<string, unknown>; status?: Record<string, unknown>; [key: string]: unknown; }
export interface YouTubePlaylistItemPayload { id?: string; snippet?: Record<string, unknown>; contentDetails?: Record<string, unknown>; status?: Record<string, unknown>; [key: string]: unknown; }

export function iso8601DurationToSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function youtubePublicationStatus(status: Record<string, unknown> | undefined): "published" | "unlisted" | "unpublished" | "copyright_blocked" | "unknown" {
  if (status?.["uploadStatus"] === "rejected" || status?.["rejectionReason"] === "copyright") return "copyright_blocked";
  switch (status?.["privacyStatus"]) { case "public": return "published"; case "unlisted": return "unlisted"; case "private": return "unpublished"; default: return "unknown"; }
}
