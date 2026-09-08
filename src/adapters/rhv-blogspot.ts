import { load } from "cheerio";
import type { RawRecord } from "./contracts.js";
import { BloggerAdapter } from "./blogger.js";
import { ADAPTER_VERSION, clean, contentImages, excerpt, parseReleaseHead } from "./shared.js";

// "RHV Blogspot" es un blog de PRENSA, no un archivo discográfico: reseñas,
// notas y entrevistas. Sus 264 entradas dan poco, y conviene decirlo con el
// número delante: sólo 24 títulos terminan en "(Año)", que es la única forma
// en la que este blog declara una ficha.
//
//   BANDA: Álbum (Año)      PROARESIS: Propios Y Extraños (2022)
//
// Los otros dos canales que sí funcionan en las demás Blogspot aquí no
// existen:
//
//   - LAS ETIQUETAS SON SECCIONES, NO BANDAS. Las 15 del blog son
//     `variedad`, `prensa`, `reseñas`, `noticias`, `lanzamientos`,
//     `criticas`, `eventos`… Ninguna resuelve un artista, al revés que en
//     Rock De Vzla o Rockzuela.
//   - EL CUERPO NO TRAE TRACKLIST. Cero de las 24 fichas lo publican; los
//     temas se nombran dentro de la prosa de la reseña, y de ahí no se sacan.
//
// Se descarta a propósito lo que el blog escribe como SERIE editorial sin
// nombrar banda ("Los Discos de Oro del Rock Hecho en Venezuela Conozca Los
// Impala (1964)"): sin un separador que diga dónde acaba el grupo y empieza
// el disco, partirlo sería adivinar.

/** Prefijo de serie editorial: no es la banda, aunque ocupe su sitio. */
const SERIES = /^(?:los\s+)?discos\s+de\s+oro\s+del\s+rock\s+hecho\s+en\s+venezuela\s*:?\s*/iu;
/** "BANDA: Álbum" y "BANDA - Álbum": el blog usa dos puntos, y guion al citar. */
const COLON = /^([^:]{2,60}):\s*(.+)$/u;
const DASH = /^(.{2,60}?)\s+[-–—]\s+(.+)$/u;
/** 'JUAN MANUEL PONCE "Del Origen A La Transición"': el disco va entrecomillado. */
const QUOTED = /^(.{2,60}?)\s*[«"“]([^«»"“”]{2,})[»"”]\s*$/u;

export interface RhvFicha { artist: string; album: string; year: string }

export function parseRhvTitle(rawTitle: string): RhvFicha | undefined {
  const title = clean(rawTitle);
  // El año al final es lo que distingue una ficha de un titular de prensa.
  // Sin él, "ALTO VOLTAJE: Escucha su nuevo sencillo" sería un disco.
  const head = parseReleaseHead(title);
  if (!head) return undefined;
  const rest = clean(head.title.replace(SERIES, ""));
  if (!rest) return undefined;
  const parts = COLON.exec(rest) ?? DASH.exec(rest) ?? QUOTED.exec(rest);
  if (!parts) return undefined;
  const artist = clean(parts[1] ?? "");
  const album = clean((parts[2] ?? "").replace(/^[«"“]|[»"”]$/gu, ""));
  if (!artist || !album) return undefined;
  return { artist, album, year: head.year };
}

export class RhvBlogspotAdapter extends BloggerAdapter {
  readonly slug = "rhv-blogspot";

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  protected override extractEntry(html: string, title: string, url: string): RawRecord[] {
    const ficha = parseRhvTitle(title);
    if (!ficha) return [];

    const page = load(html);
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }),
    });
    const fromTitle = evidence("entry:title", title);
    const fromLink = evidence("link", url);

    const albumFields: RawRecord["fields"] = [
      { field: "title", value: ficha.album, evidence: fromTitle },
      { field: "artist_name", value: ficha.artist, evidence: fromTitle },
      { field: "release_year", value: ficha.year, evidence: fromTitle },
      { field: "source_url", value: url, evidence: fromLink },
    ];
    // La entrada es la reseña de ese disco y su portada encabeza el cuerpo.
    const cover = contentImages(page, url)[0];
    if (cover) albumFields.push({ field: "cover_url", value: cover.url, evidence: evidence("img", cover.alt || cover.url, cover.position) });

    return [
      this.record("artist", ficha.artist, [
        { field: "name", value: ficha.artist, evidence: fromTitle },
        { field: "source_url", value: url, evidence: fromLink },
      ]),
      this.record("album", `${ficha.artist}::${ficha.album}`, albumFields),
    ];
  }
}
