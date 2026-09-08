import { load } from "cheerio";
import type { RawRecord } from "./contracts.js";
import { BloggerAdapter } from "./blogger.js";
import { ADAPTER_VERSION, clean, contentImages, excerpt, isPresenceLink, parseReleaseHead } from "./shared.js";

// "Rockzuela" etiqueta cada entrada con su SECCIÓN además de con la banda, y
// esa sección es el dato que decide si el post es una publicación o no:
//
//   Musica  + Rock Nacional   586 entradas  → disco
//   Videos  + Rock Nacional   431 entradas  → una canción en vivo, NO un disco
//   Eventos                    94 entradas  → un concierto, NO un disco
//
// Sin ese canal habría que adivinarlo del título, y no se puede: "Zapato 3 -
// En La Otra Cara (Parte II)" y "Los Paranoias - Leslie Sessions EP (2008)"
// tienen la misma forma y solo la etiqueta dice que el primero es un video.
//
// La banda es la etiqueta que NO pertenece al vocabulario de secciones, y el
// título repite su nombre antes del guion. Las dos versiones difieren en 41
// de 549 entradas y ahí la del título es la buena —lleva las tildes que la
// etiqueta perdió ("Sincrónica" por "Sincronica", "Aérea" por "Aerea")—, así
// que la etiqueta queda como identidad y el título entra como alias: es el
// propio post nombrando a la banda de dos maneras.
//
// Fuera de alcance deliberado: las 24 entradas de Musica sin guion en el
// título son recopilatorios ("Venezuela Ska Vol. II", "Compilado Bandas
// Merida"). El core exige `albums.artist_id NOT NULL` y un recopilatorio no
// tiene un artista único; es la misma decisión de modelo que en Hippito, y no
// se toma dentro de un adapter.

/**
 * Secciones editoriales del blog. Se comparan contra la etiqueta COMPLETA:
 * "Videos" es una sección, pero una banda podría llamarse "Video Killer".
 */
const SECTION = /^(?:rock nacional|m[uú]sica|videos?|eventos?)$/iu;
/** La sección que declara que la entrada es una publicación. */
const RELEASE_SECTION = /^m[uú]sica$/iu;
/** "Banda - Álbum (Año)". El guion va rodeado de espacios: "Dame pa Matala" no se parte. */
const TITLE_LINE = /^(.+?)\s+[-–—]\s+(.+)$/u;
/** "Banda - (1996)": el disco homónimo, que el blog escribe sin repetir el nombre. */
const SELF_TITLED = /^\(\s*([^()]{1,40})\s*\)$/u;
const YEAR = /\b(?:19|20)\d{2}\b/u;

export class RockzuelaAdapter extends BloggerAdapter {
  readonly slug = "rockzuela";

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  protected override extractEntry(html: string, title: string, url: string, labels: readonly string[] = []): RawRecord[] {
    const sections = labels.filter((label) => SECTION.test(label));
    const bands = labels.filter((label) => !SECTION.test(label));
    // Con ninguna etiqueta de banda no hay a quién atribuir el post, y con
    // varias no se adivina cuál: 77 entradas de 1.127, casi todas eventos con
    // cartel compartido.
    if (bands.length === 0) return [];

    const page = load(html);
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }),
    });
    const fromTitle = evidence("entry:title", title);
    const titled = TITLE_LINE.exec(clean(title));
    const titleBand = clean(titled?.[1] ?? "");

    const presence = new Set<string>();
    page("a[href]").each((_, node) => {
      const href = (page(node).attr("href") ?? "").trim();
      if (href && isPresenceLink(href, url)) presence.add(href);
    });

    // Toda etiqueta de banda es el blog afirmando que ese grupo existe, y eso
    // vale igual en un cartel de concierto con ocho nombres que en la ficha de
    // un disco. Lo que necesita una sola banda es ATRIBUIR el disco, no
    // reconocer al artista.
    const records: RawRecord[] = [];
    for (const name of bands) {
      const fields: RawRecord["fields"] = [
        { field: "name", value: name, evidence: evidence("entry:category", name) },
        { field: "source_url", value: url, evidence: evidence("link", url) },
      ];
      if (bands.length === 1 && titleBand && titleBand.toLowerCase() !== name.toLowerCase()) {
        fields.push({ field: "alias", value: titleBand, evidence: fromTitle });
      }
      if (bands.length === 1) for (const href of presence) fields.push({ field: "web_url", value: href, evidence: evidence("a", href) });
      records.push(this.record("artist", name, fields));
    }

    // El artista existe lo diga la sección que lo diga; el disco solo cuando
    // el blog declara que la entrada es una publicación.
    const band = bands.length === 1 ? clean(bands[0] ?? "") : "";
    if (!band || !titled || !sections.some((section) => RELEASE_SECTION.test(section))) return records;

    const rest = clean(titled[2] ?? "");
    const head = parseReleaseHead(rest);
    const selfTitled = SELF_TITLED.exec(rest);
    // Aquí no hace falta exigir año para saber que el post es una ficha —eso
    // ya lo dijo la etiqueta `Musica`—, así que un disco sin año publicado
    // ("Zapato 3 - En Vivo") entra igual, con `release_year` vacío.
    const albumTitle = head?.title ?? (selfTitled ? band : rest);
    const year = head?.year ?? (selfTitled ? YEAR.exec(selfTitled[1] ?? "")?.[0] : undefined);
    if (!albumTitle) return records;

    const albumFields: RawRecord["fields"] = [
      { field: "title", value: albumTitle, evidence: fromTitle },
      { field: "artist_name", value: band, evidence: evidence("entry:category", band) },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ];
    if (year) albumFields.push({ field: "release_year", value: year, evidence: fromTitle });
    if (head?.albumType) albumFields.push({ field: "album_type", value: head.albumType, evidence: fromTitle });
    if (head?.format) albumFields.push({ field: "format", value: head.format, evidence: fromTitle });
    // La entrada es la ficha de ese disco y la imagen encabeza el cuerpo.
    const cover = contentImages(page, url)[0];
    if (cover) albumFields.push({ field: "cover_url", value: cover.url, evidence: evidence("img", cover.alt || cover.url, cover.position) });
    records.push(this.record("album", `${band}::${albumTitle}`, albumFields));

    return records;
  }
}
