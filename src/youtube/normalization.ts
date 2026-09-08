/** Canonical YouTube identifiers and the conservative seed classification. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function canonicalVideoUrl(videoId: string): string {
  if (!YOUTUBE_VIDEO_ID.test(videoId)) throw new Error(`ID de YouTube inválido: ${videoId}`);
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Returns an ID only for known YouTube URL shapes; query parameters never leak into it. */
export function extractYouTubeVideoId(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value) return null;
  if (YOUTUBE_VIDEO_ID.test(value)) return value;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
  catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  else if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const [kind, candidate] = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live", "v"].includes(kind ?? "")) id = candidate ?? null;
    }
  }
  return id && YOUTUBE_VIDEO_ID.test(id) ? id : null;
}

export type ContentKind = "release" | "media" | "review";
export type NormalizedReleaseType =
  | "studio_album" | "live_album" | "ep" | "single" | "compilation"
  | "demo" | "soundtrack" | "collaboration_album" | "remix" | "other";

export interface ContentClassification {
  kind: ContentKind;
  normalizedType: NormalizedReleaseType | "music_video" | "live_concert" | "documentary" | null;
  reason: string;
}

function key(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

const RELEASE_TYPES: Record<string, NormalizedReleaseType> = {
  "studio album": "studio_album", album: "studio_album", "full album": "studio_album",
  "live album": "live_album", ep: "ep", "extended play": "ep", single: "single",
  "compilation album": "compilation", compilation: "compilation", "greatest hits": "compilation",
  demo: "demo", demos: "demo", soundtrack: "soundtrack", "original soundtrack": "soundtrack",
  "collaboration album": "collaboration_album", "remix album": "remix",
};
const MEDIA_TYPES: Record<string, "music_video" | "live_concert" | "documentary"> = {
  "music video": "music_video", videoclip: "music_video", "video musical": "music_video",
  "live concert": "live_concert", concert: "live_concert", documentary: "documentary", documental: "documentary",
};

export function classifyContentType(raw: string | null | undefined): ContentClassification {
  const normalized = key(raw ?? "");
  if (!normalized || normalized === "empty") return { kind: "review", normalizedType: null, reason: "tipo vacío o incompleto" };
  // These labels can be releases, performances, or compilations; the seed alone is insufficient.
  if (/\bb sides?\b|\bunplugged\b/.test(normalized) || /[+/&]/.test(raw ?? "")) {
    return { kind: "review", normalizedType: null, reason: "B-Sides, Unplugged o tipo compuesto requiere evidencia de publicación independiente" };
  }
  const release = RELEASE_TYPES[normalized];
  if (release) return { kind: "release", normalizedType: release, reason: "tipo de publicación reconocido" };
  const media = MEDIA_TYPES[normalized];
  if (media) return { kind: "media", normalizedType: media, reason: "contenido audiovisual; no crea álbum" };
  return { kind: "review", normalizedType: null, reason: `tipo no verificable automáticamente: ${raw}` };
}
