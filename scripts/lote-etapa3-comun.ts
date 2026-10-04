// CRV · Etapa 3 del nuevo lote: piezas comunes de la cosecha
// (lote-etapa3-cosecha.ts) y del aplicador (lote-etapa3-discos.ts).
import { compareKey } from "../src/ingest/lote-investigacion.js";

/** Compositores y académicos: obras a notas, no discos (plan §2.2). */
export const COMPOSERS_ONLY = new Set([
  "nascuy-linares", "diego-ayala-raffalli", "teresa-carreno", "antonio-lauro", "vicente-emilio-sojo", "modesta-bor",
  "antonio-estevez", "evencio-castellanos", "inocente-carreno", "juan-bautista-plaza", "adina-izarra", "alfredo-rugeles",
  "alfredo-del-monaco", "paul-desenne", "marco-antonio-rivera-useche", "luis-felipe-ramon-rivera",
]);

/** Clave de título sin lo que las plataformas añaden («(Remastered)», «- Single», «[Deluxe]»…). */
export function titleKey(title: string): string {
  return compareKey(title
    .replace(/\s*[([][^)\]]*(remaster|deluxe|edici[oó]n|edition|version|versi[oó]n|expanded|bonus|reissue|aniversario|anniversary)[^)\]]*[)\]]/gi, " ")
    // Invitados y versiones instrumentales o explícitas del mismo lanzamiento.
    .replace(/\s*[([](feat\.?|ft\.|featuring)\s[^)\]]*[)\]]/gi, " ")
    .replace(/\s*[([](instrumental|explicit|expl[ií]cito|clean|a ?capp?ella)[)\]]/gi, " ")
    .replace(/\s+-\s+(single|ep)$/i, " ")
    .replace(/\s*\((single|ep)\)$/i, " "));
}

export interface ReleaseGroup { id: string; title: string; primaryType: string | null; secondaryTypes: string[]; date: string | null; credit: string; soleArtist: boolean }

export interface DeezerAlbum {
  id: number; title: string; recordType: string | null; date: string | null; label: string | null; nbTracks: number | null;
  upc: string | null; link: string; mainArtist: boolean; contributors: string[];
}

export interface CoreAlbum { id: number; title: string; year: number | null; type: string }

/** Números y romanos sueltos del título: «Vol. 2», «Stretch 1», «KICK iii» son discos distintos. */
const numerals = (key: string) => key.split(" ").filter((token) => /^(\d+|[ivx]+)$/.test(token)).join(" ");

export function variantOf(key: string, core: CoreAlbum[]): CoreAlbum | null {
  for (const album of core) {
    const other = titleKey(album.title);
    if (!other || !key) continue;
    if (numerals(key) !== numerals(other)) continue;
    const [short, long] = key.length <= other.length ? [key, other] : [other, key];
    if (short.length >= 6 && (long.startsWith(`${short} `) || long.endsWith(` ${short}`)) && long.length - short.length <= 12) return album;
    if (short.replace(/ /g, "") === long.replace(/ /g, "")) return album;
    if (long.length >= 8 && levenshtein(short, long) <= (long.length >= 16 ? 2 : 1)) return album;
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

