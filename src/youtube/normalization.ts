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

/**
 * La hoja maestra es la fuente de los tipos y un disco puede tener varios:
 * "Solo Artist, Studio Album" o "Live Concert, Single" son dos clasificaciones.
 */
export function sheetClassifications(raw: string | null | undefined): string[] {
  return (raw ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

/** Videoclips, conciertos y documentales no suenan en la radio, aunque además tengan otro tipo. */
export function excludedFromRadio(raw: string | null | undefined): boolean {
  return sheetClassifications(raw).some((part) => MEDIA_TYPES[key(part)] !== undefined);
}

const INFERRED_LABELS: Record<NormalizedReleaseType, string> = {
  studio_album: "Studio Album", live_album: "Live Album", ep: "EP", single: "Single", compilation: "Compilation Album",
  demo: "Demos", soundtrack: "Soundtrack", collaboration_album: "Collaboration Album", remix: "Remix Album", other: "Other",
};

/**
 * Tipo de una fila que la hoja dejó vacío. Brian autorizó (2026-09-13) inferirlo
 * del artista y del título, siempre marcado como inferido: en cuanto la hoja
 * traiga el tipo, ese manda.
 */
export function inferSheetType(artist: string | null | undefined, album: string | null | undefined): NormalizedReleaseType | null {
  const artistKey = key(artist ?? ""); const albumKey = key(album ?? "");
  if (!artistKey || !albumKey || artistKey === "empty" || albumKey === "empty") return null;
  if (artistKey === "various artists") return "compilation";
  if (/^eps?$|\beps?$/.test(albumKey)) return "ep";
  if (/^demos?\b|\bdemos?$/.test(albumKey)) return "demo";
  if (/\ben vivo\b|\ben directo\b|\ben concierto\b|\blive\b/.test(albumKey)) return "live_album";
  return "studio_album";
}

export function inferredTypeLabel(type: NormalizedReleaseType): string {
  return INFERRED_LABELS[type];
}

/** Clasifica una fila completa: el tipo escrito manda; vacío, se infiere y se dice. */
export function classifySheetRow(row: { type: string | null | undefined; artistName: string | null | undefined; albumName: string | null | undefined }): ContentClassification {
  const written = key(row.type ?? "");
  if (written && written !== "empty") return classifyContentType(row.type);
  const inferred = inferSheetType(row.artistName, row.albumName);
  if (!inferred) return classifyContentType(row.type);
  return { kind: "release", normalizedType: inferred, reason: `tipo inferido (la hoja no lo trae): ${INFERRED_LABELS[inferred]}` };
}

export function isInferredClassification(reason: string | null | undefined): boolean {
  return (reason ?? "").startsWith("tipo inferido");
}

/**
 * Identidad "artista::título" de un disco. Si la misma fuente publica dos
 * discos con ese nombre y años distintos (Spiteri 1973 y Spiteri 1981), el más
 * antiguo conserva la identidad de siempre y los demás llevan el año: sin eso,
 * el segundo se funde con el primero como si fuera un conflicto de año.
 */
export function releaseIdentity(artist: string, album: string, year: number | null, yearsByRelease: Map<string, Set<number>>): string {
  const years = yearsByRelease.get(key(`${artist}::${album}`));
  const later = year !== null && years !== undefined && years.size > 1 && year !== Math.min(...years);
  return `${artist}::${album}${later ? ` (${year})` : ""}`.slice(0, 250);
}

export function collectReleaseYears(entries: Iterable<{ artist: string; album: string; year: number | null }>): Map<string, Set<number>> {
  const years = new Map<string, Set<number>>();
  for (const entry of entries) {
    if (entry.year === null) continue;
    const releaseKey = key(`${entry.artist}::${entry.album}`);
    const set = years.get(releaseKey) ?? new Set<number>();
    set.add(entry.year);
    years.set(releaseKey, set);
  }
  return years;
}

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
