import logoDimensions from "../generated/logo-dimensions.json";

export type LogoAspect = "square" | "near-square" | "wide";

const knownDimensions: Record<string, readonly number[]> = logoDimensions;
const dimensionsByArtistId = new Map<number, readonly number[]>();
for (const [filename, dimensions] of Object.entries(knownDimensions)) {
  const id = Number(filename.match(/^(\d+)-logo\./)?.[1]);
  if (Number.isInteger(id)) dimensionsByArtistId.set(id, dimensions);
}

/** Clasifica el lienzo del logo; los formatos compactos comparten una miniatura cuadrada. */
export function classifyLogoAspect(width: number, height: number): LogoAspect {
  if (width <= 0 || height <= 0) return "wide";
  const ratio = width / height;
  if (ratio <= 1.2) return "square";
  if (ratio <= 2.2) return "near-square";
  return "wide";
}

/** Los logos locales ya tienen sus dimensiones en el bundle: no esperan a `img.onload`. */
export function knownLogoAspect(src: string, artistId?: number): LogoAspect | null {
  const path = src.split(/[?#]/, 1)[0] ?? "";
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dimensions = knownDimensions[filename] ?? (artistId === undefined ? undefined : dimensionsByArtistId.get(artistId));
  return dimensions?.length === 2 ? classifyLogoAspect(dimensions[0]!, dimensions[1]!) : null;
}
