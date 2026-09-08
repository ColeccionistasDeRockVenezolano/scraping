import { load } from "cheerio";
import type { RawRecord } from "./contracts.js";
import { BloggerAdapter } from "./blogger.js";
import { ADAPTER_VERSION, clean, contentImages, DOWNLOAD_LINK, excerpt, isPresenceLink, parseReleaseHead, type ReleaseHead } from "./shared.js";

// "Rock De Vzla" es un archivo discográfico de 1.113 entradas con una
// convención de maquetado fija. Nada de eso está en el texto corrido: cada
// dato vive en un canal propio, y leer el post como prosa daba cero.
//
//   - LA BANDA ES LA ETIQUETA DEL FEED. 1.110 de las 1.113 entradas traen el
//     título VACÍO y exactamente una etiqueta, que es el nombre del grupo.
//     Sin `entry.category` no hay artista al que colgar nada; por eso
//     BloggerAdapter.extractEntry pasa ahora las etiquetas.
//   - EL TAMAÑO DE FUENTE SEPARA ENCABEZADO DE FICHA. `x-large` rotula el
//     nombre de la banda; `large` rotula la línea de cada disco, con la forma
//       Título (Tipo Año)   ·   Título (Año)
//     Es el mismo caso que el gris de Hippito o el directorio de Sincopa:
//     semántica codificada fuera del texto.
//   - UNA LÍNEA DE GUIONES CIERRA LA DISCOGRAFÍA. Debajo van los videos, y
//     ahí `large` rotula CANCIONES, no discos: "Reflector" seguido de
//     "(En Vivo El Teatro Bar, 2010)". Sin ese corte, ocho actuaciones en
//     vivo entraban al catálogo como si fueran publicaciones.
//
// Fuera de alcance deliberado: los enlaces de descarga (MediaFire, Megaupload)
// no se extraen. Y las membresías: solo 17 entradas escriben "Integrantes:",
// y de esas la mayoría lo hace dentro de una frase en prosa ("por Néstor
// Rosales (voz líder), …"), que es justo lo que este proyecto no infiere.

const XLARGE = /font-size:\s*x-large\b/i;
const LARGE = /font-size:\s*large\b/i;
const SEPARATOR = /^-{8,}$/u;
const TRACK_LINE = /^(\d{1,3})\s*[.\-)]\s*(.+)$/u;

export class RockDeVzlaAdapter extends BloggerAdapter {
  readonly slug = "rock-de-vzla";

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  protected override extractEntry(html: string, _title: string, url: string, labels: readonly string[] = []): RawRecord[] {
    // Una sola etiqueta es la banda. Con ninguna no hay a quién atribuir el
    // post, y con varias no se adivina cuál: 3 entradas de 1.113.
    const band = labels.length === 1 ? clean(labels[0] ?? "") : "";
    if (!band) return [];

    const page = load(html);
    const nodes = page("*").toArray();
    const at = (index: number) => page(nodes[index]);
    const tagAt = (index: number) => String(at(index).prop("tagName") ?? "").toLowerCase();
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }),
    });

    // Las líneas visuales del post en orden de lectura. Un bloque hoja puede
    // contener varias separadas solo por <br>: leerlo como una sola cadena
    // escondía 410 pistas en 52 entradas. El orden se guarda como índice
    // fraccionario (nodo.línea) para que los tramos de cada ficha sigan
    // comparándose con un simple `<`.
    const lines: Array<{ at: number; text: string; tag: string; href: string }> = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const element = at(index);
      if (element.children().filter((_, child) => String(page(child).prop("tagName") ?? "").toLowerCase() !== "br").length > 0) continue;
      const tag = tagAt(index);
      // El enlace se busca hacia arriba: el bloque hoja de "DESCARGAR" suele
      // ser el <span> de dentro del <a>, y preguntarle a él por el href no
      // devuelve nada.
      const href = element.closest("a").attr("href") ?? "";
      (element.html() ?? "").split(/<br\s*\/?>/i).forEach((chunk, ordinal) => {
        const text = clean(page(`<div>${chunk}</div>`).text());
        if (text) lines.push({ at: index + ordinal / 1_000, text, tag, href });
      });
    }

    // La línea de guiones cierra la discografía; lo que sigue son videos, y
    // ahí el mismo marcado rotula canciones en vez de discos.
    const end = lines.find((line) => SEPARATOR.test(line.text))?.at ?? nodes.length;

    // Las fichas van rotuladas con `large`. 82 entradas no lo aplican, y ahí
    // se cae a la línea suelta con la misma forma — pero SOLO cuando la regla
    // estricta no encontró nada en el post: como criterio general recogería
    // cualquier paréntesis con año del cuerpo.
    type Head = ReleaseHead & { at: number; line: string; selector: string };
    const marked: Head[] = [];
    for (let index = 0; index < nodes.length && index < end; index += 1) {
      const element = at(index);
      if (!LARGE.test(element.attr("style") ?? "")) continue;
      // Solo el `large` más interno: un contenedor con estilo repetiría el
      // texto de sus hijos y se llevaría el post entero como título.
      if (element.find("[style]").filter((_, child) => LARGE.test(page(child).attr("style") ?? "")).length > 0) continue;
      const line = clean(element.text());
      const head = parseReleaseHead(line);
      if (head) marked.push({ ...head, at: index, line, selector: tagAt(index) });
    }
    const heads: Head[] = marked.length > 0 ? marked : lines
      .filter((line) => line.at < end)
      .flatMap((line) => {
        const head = parseReleaseHead(line.text);
        return head ? [{ ...head, at: line.at, line: line.text, selector: line.tag }] : [];
      });

    const records: RawRecord[] = [];
    let heading = -1;
    for (let index = 0; index < nodes.length && index < end; index += 1) {
      if (XLARGE.test(at(index).attr("style") ?? "") && clean(at(index).text()) !== "") { heading = index; break; }
    }

    // Lo que hay entre el nombre grande de la banda y la primera ficha es su
    // descripción: dos marcas explícitas la delimitan. En las 41 entradas
    // donde ninguna ficha va rotulada no hay marca de cierre y el tramo se
    // extendía sobre la discografía entera, así que se corta también en lo
    // primero que ya sabemos leer como discografía: una línea de ficha, una
    // pista numerada o un enlace de descarga. La palabra "descargar" en prosa
    // ("podrán descargar su demo") no cuenta: corta el href, no el texto.
    const biographyParts: string[] = [];
    for (const line of lines) {
      if (line.at <= heading) continue;
      if (line.at >= (heads[0]?.at ?? end)) break;
      if (parseReleaseHead(line.text) || TRACK_LINE.test(line.text)) break;
      if (DOWNLOAD_LINK.test(line.href)) break;
      if (!biographyParts.includes(line.text)) biographyParts.push(line.text);
    }
    const biography = clean(biographyParts.join(" ")).slice(0, 4_000);

    const artistFields: RawRecord["fields"] = [
      { field: "name", value: band, evidence: evidence("entry:category", band) },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ];
    // El nombre grande del post no se emite como alias: coincide con la
    // etiqueta salvo en 67 entradas, y en esas tanto acierta ("Pa'luego Es
    // Tarde" por "Paluegoestarde") como recoge basura ("1. Batalla"). La
    // etiqueta es el canal con el que el propio blog agrupa; un alias necesita
    // una fuente que lo afirme, no un encabezado que a veces se descuadra.
    if (biography.length >= 40) artistFields.push({ field: "biography", value: biography, evidence: evidence("div", biography) });
    const presence = new Set<string>();
    for (let index = 0; index < nodes.length && index < end; index += 1) {
      if (tagAt(index) !== "a") continue;
      const href = (at(index).attr("href") ?? "").trim();
      if (href && isPresenceLink(href, url)) presence.add(href);
    }
    for (const href of presence) artistFields.push({ field: "web_url", value: href, evidence: evidence("a", href) });
    records.push(this.record("artist", band, artistFields));

    // Se reutiliza el filtro de adorno ya verificado: la portada del bloque es
    // la primera imagen de contenido que cae dentro de sus límites.
    const content = new Map(contentImages(page, url).map((image) => [image.url, image]));
    for (const [order, head] of heads.entries()) {
      const to = heads[order + 1]?.at ?? end;
      const where = evidence(head.selector, head.line, order);
      const albumFields: RawRecord["fields"] = [
        { field: "title", value: head.title, evidence: where },
        { field: "artist_name", value: band, evidence: where },
        { field: "release_year", value: head.year, evidence: where },
        { field: "source_url", value: url, evidence: evidence("link", url) },
      ];
      if (head.albumType) albumFields.push({ field: "album_type", value: head.albumType, evidence: where });
      if (head.format) albumFields.push({ field: "format", value: head.format, evidence: where });
      for (let index = Math.floor(head.at) + 1; index < nodes.length && index < to; index += 1) {
        if (tagAt(index) !== "img") continue;
        let absolute: string;
        try { absolute = new URL((at(index).attr("src") ?? "").trim(), url).toString(); } catch { continue; }
        const cover = content.get(absolute);
        if (!cover) continue;
        albumFields.push({ field: "cover_url", value: cover.url, evidence: evidence("img", cover.alt || cover.url, cover.position) });
        break;
      }
      records.push(this.record("album", `${band}::${head.title}`, albumFields));

      let position = 0;
      for (const line of lines) {
        if (line.at <= head.at) continue;
        if (line.at >= to) break;
        const match = TRACK_LINE.exec(line.text);
        if (!match) continue;
        const trackTitle = clean(match[2] ?? "");
        if (!trackTitle) continue;
        const where2 = evidence(line.tag, line.text, position);
        records.push(this.record("track", `${band}::${head.title}::${trackTitle}`, [
          { field: "title", value: trackTitle, evidence: where2 },
          { field: "track_number", value: match[1]!, evidence: where2 },
          { field: "album_title", value: head.title, evidence: where2 },
          { field: "artist_name", value: band, evidence: where2 },
        ]));
        position += 1;
      }
    }
    return records;
  }
}
