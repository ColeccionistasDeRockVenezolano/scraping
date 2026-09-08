import { getEnv } from "../config/env.js";

export interface YouTubeApiResponse<T> { items?: T[]; nextPageToken?: string; }
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class YouTubeDataApi {
  constructor(private readonly apiKey = getEnv().YOUTUBE_API_KEY, private readonly fetcher: FetchLike = fetch) {}

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    if (!this.apiKey) throw new Error("YOUTUBE_API_KEY no está configurada. Configure la clave para ejecutar sincronización live de YouTube.");
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [name, value] of Object.entries({ ...params, key: this.apiKey })) url.searchParams.set(name, value);
    const response = await this.fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`YouTube Data API ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  listVideos(ids: string[]): Promise<YouTubeApiResponse<YouTubeVideoPayload>> {
    if (!ids.length) return Promise.resolve({ items: [] });
    return this.request("videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
  }
  getChannel(id: string): Promise<YouTubeApiResponse<YouTubeChannelPayload>> {
    return this.request("channels", { part: "snippet,contentDetails,status", id });
  }
  listPlaylistItems(playlistId: string, pageToken?: string): Promise<YouTubeApiResponse<YouTubePlaylistItemPayload>> {
    return this.request("playlistItems", { part: "snippet,contentDetails,status", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
  }
}

export interface YouTubeVideoPayload { id: string; snippet?: Record<string, unknown>; contentDetails?: Record<string, unknown>; status?: Record<string, unknown>; [key: string]: unknown; }
export interface YouTubeChannelPayload { id: string; snippet?: Record<string, unknown>; contentDetails?: Record<string, unknown>; status?: Record<string, unknown>; [key: string]: unknown; }
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
