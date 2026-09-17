// CRV · Mal segmentados: un campo que mezcla varios datos.
//
// Casos reales del estudio (2026-09-16): 2.298 títulos de pista con «Artista -
// Título» (955 de un artista que ya tiene ficha), «La noche de Chicago (R.
// Zonteno / M. Landa)», «Ángel 3:30», «Noctambulath (Caracas)», «Yordano
// (Giordano Di Marzo)», «Lyrics: N. Zuleta», «Rick TarboxAdapt: Alejandro
// Page», «Wachiman16) La BambaBonus Tracks».
import { classifyPersonName } from "../../review/person-junk.js";
import { isKnownPlace, keyTokens, nameKey, type NameValue } from "../lexicon.js";
import type { SnapshotArtist } from "../types.js";
import { firstSpan, nameFinding, quote, type AnalysisContext, type Detector } from "./shared.js";

const CATEGORY = "mal_segmentados";

const DASH_SPLIT = /^(.+?)\s+[-–—]\s+(.+)$/u;

function knownArtist(context: AnalysisContext, text: string): SnapshotArtist | undefined {
  const key = nameKey(text);
  return key.length >= 2 ? context.lexicon.artistsByKey.get(key)?.[0] : undefined;
}

/**
 * Un disco cuyas pistas traen casi todas «X - Y» con X distintos es un
 * recopilatorio que escribió al intérprete dentro del título. Se aprende del
 * propio disco, no de una lista de recopilatorios.
 */
function performerInTitlesAlbums(context: AnalysisContext): Set<number> {
  const albums = new Set<number>();
  for (const [albumId, tracks] of context.tracksByAlbum) {
    const lefts = tracks.map((track) => DASH_SPLIT.exec(track.title)?.[1]).filter((left): left is string => left !== undefined);
    if (lefts.length >= 2 && lefts.length / tracks.length >= 0.5 && new Set(lefts.map(nameKey)).size >= 2) albums.add(albumId);
  }
  return albums;
}

export const artistInTrackTitle: Detector = {
  key: "artista_en_titulo_de_pista",
  category: CATEGORY,
  label: "Artista dentro del título de la pista",
  description: "El título de la pista trae «Artista - Título»: el intérprete debería ser un crédito de la pista, no parte del título.",
  run(context) {
    const compilationLike = performerInTitlesAlbums(context);
    // Orientación de cada disco: si sus pistas nombran artistas conocidos más
    // a la izquierda o a la derecha del guion («Artista - Título» o al revés).
    const rightSided = new Set<number>();
    for (const albumId of compilationLike) {
      let left = 0; let right = 0;
      for (const track of context.tracksByAlbum.get(albumId) ?? []) {
        const parts = DASH_SPLIT.exec(track.title);
        if (!parts) continue;
        if (knownArtist(context, parts[1]!)) left += 1;
        if (knownArtist(context, parts[2]!)) right += 1;
      }
      if (right > left) rightSided.add(albumId);
    }
    return context.names.filter((name) => name.kind === "track").flatMap((name) => {
      const match = DASH_SPLIT.exec(name.value);
      if (!match) return [];
      const [, left, right] = match as unknown as [string, string, string];
      const albumId = name.related[0]?.id ?? null;
      const album = albumId === null ? undefined : context.albums.get(albumId);
      const albumArtist = album ? context.artists.get(album.artistId) : undefined;
      const albumArtistKey = albumArtist ? nameKey(albumArtist.name) : "";
      for (const [performer, title] of [[left, right], [right, left]] as const) {
        if (albumArtistKey.length >= 2 && nameKey(performer) === albumArtistKey) {
          return [nameFinding(this, name, {
            signature: "repite_artista_del_disco", signatureLabel: "Repite el artista del disco",
            severity: "medium",
            title: `El título repite el nombre del artista del disco (${quote(albumArtist!.name)})`,
            suggestion: `Dejar el título como ${quote(title)}`,
            span: performer === left ? [0, left.length] : [name.value.length - right.length, name.value.length],
          })];
        }
      }
      const inCompilation = albumId !== null && compilationLike.has(albumId);
      const orientations = albumId !== null && rightSided.has(albumId) ? [[right, left]] as const : [[left, right]] as const;
      for (const [performer, title] of orientations) {
        const artist = knownArtist(context, performer);
        if (artist && artist.id !== albumArtist?.id && (inCompilation || keyTokens(performer).length >= 2)) {
          return [nameFinding(this, name, {
            signature: "artista_con_ficha", signatureLabel: "Artista que ya tiene ficha",
            severity: "medium",
            title: `El intérprete ${quote(artist.name)} está escrito dentro del título`,
            suggestion: `Título ${quote(title)} con crédito de pista al artista ${quote(artist.name)}`,
            related: [{ kind: "artist", id: artist.id, label: artist.name }],
            span: performer === left ? [0, left.length] : [name.value.length - right.length, name.value.length],
          })];
        }
      }
      if (!inCompilation) return [];
      const [performer, title] = albumId !== null && rightSided.has(albumId) ? [right, left] : [left, right];
      return [nameFinding(this, name, {
        signature: "artista_sin_ficha", signatureLabel: "Artista sin ficha en el catálogo",
        severity: "low",
        title: `El título parece traer al intérprete (${quote(performer)}) y el catálogo no tiene esa ficha`,
        suggestion: `Título ${quote(title)} con crédito de pista a ${quote(performer)}`,
        evidence: { reason: "la mayoría de las pistas del disco usan «Intérprete - Título» con intérpretes distintos" },
        span: performer === left ? [0, left.length] : [name.value.length - right.length, name.value.length],
      })];
    });
  },
};

export const artistInAlbumTitle: Detector = {
  key: "artista_en_titulo_de_disco",
  category: CATEGORY,
  label: "Artista dentro del título del disco",
  description: "El título del disco empieza por el nombre de su propio artista («Wismar - BlackHymn»).",
  run(context) {
    return context.names.filter((name) => name.kind === "album").flatMap((name) => {
      const match = /^(.+?)\s*(?:\s[-–—]|:)\s+(.+)$/u.exec(name.value);
      const album = context.albums.get(name.id);
      const artist = album ? context.artists.get(album.artistId) : undefined;
      if (!match || !artist || nameKey(match[1]!) !== nameKey(artist.name) || !nameKey(artist.name)) return [];
      return [nameFinding(this, name, {
        severity: "medium",
        title: `El título repite el nombre del artista (${quote(artist.name)})`,
        suggestion: `Dejar el título como ${quote(match[2]!)}`,
        span: [0, match[1]!.length],
      })];
    });
  },
};

const GROUP = /[([]([^()[\]]+)[)\]]/gu;
const FEATURING = /\b(?:feat\.?|ft\.|featuring)\s+|^\s*con\s+/iu;
const NAME_SHAPED = /^(?:\p{Lu}\.|\p{Lu}[\p{Ll}'’-]+)(?:\s+(?:de|del|la|las|los|y|van|von|da|dos|\p{Lu}\.|\p{Lu}[\p{L}'’-]+)){1,3}$/u;
/** Artículo, parte o numeral al inicio: subtítulo («La Noche Del Erebu», «Parte II»), no un autor. */
const NOT_A_NAME_START = /^(?:el|la|los|las|lo|un|una|the|a|an|parte?|pt|vol|cap[ií]tulo|chapter|[IVXLC]+|\d+)\b|\s(?:[IVXLC]{2,}|\d+)$/iu;
const VERSION_WORDS = /\b(remix|mix|live|en vivo|vivo|directo|version|versión|edit|dub|instrumental|demo|acustic[oa]|acoustic|unplugged|remaster\w*|bonus)\b/iu;

export const creditsInTitle: Detector = {
  key: "creditos_en_titulo",
  category: CATEGORY,
  label: "Créditos dentro del título",
  description: "Autores o invitados escritos en el título («(R. Zonteno / M. Landa)», «(feat. Unco)»): deberían ser créditos de la pista.",
  run(context) {
    return context.names.filter((name) => name.kind === "track").flatMap((name) => {
      for (const match of name.value.matchAll(GROUP)) {
        const inner = match[1]!.trim();
        const span: [number, number] = [match.index, match.index + match[0].length];
        if (FEATURING.test(inner)) {
          const guest = inner.replace(FEATURING, "").trim();
          const artist = knownArtist(context, guest);
          const personIds = context.lexicon.personsByKey.get(nameKey(guest)) ?? [];
          return [nameFinding(this, name, {
            signature: "invitado", signatureLabel: "Invitado en el título",
            severity: "low",
            title: `Invitado escrito en el título: ${quote(guest)}`,
            suggestion: `Crédito de invitado (guest) a ${quote(guest)}`,
            related: [
              ...(artist ? [{ kind: "artist" as const, id: artist.id, label: artist.name }] : []),
              ...personIds.slice(0, 1).map((id) => ({ kind: "person" as const, id, label: context.persons.get(id)?.name ?? guest })),
            ],
            span,
          })];
        }
        if (VERSION_WORDS.test(inner)) continue;
        const segments = inner.split(/\s*[/;,]\s*/u).map((segment) => segment.trim()).filter(Boolean);
        const known = segments.flatMap((segment) => {
          const ids = keyTokens(segment).length >= 2 ? context.lexicon.personsByKey.get(nameKey(segment)) ?? [] : [];
          return ids.slice(0, 1).map((id) => ({ kind: "person" as const, id, label: context.persons.get(id)?.name ?? segment }));
        });
        // Una sola frase entre paréntesis casi siempre es una traducción o un
        // subtítulo («Llamame (Ring Me Up)»), aunque exista una ficha basura
        // con ese nombre: hace falta una lista o una inicial con apellido.
        const initialAndSurname = segments.length === 1 && /^\p{Lu}\.\s*(?:\p{Lu}\.\s*)?\p{Lu}[\p{Ll}'’-]+$/u.test(segments[0]!);
        const personLike = (segment: string): boolean => (NAME_SHAPED.test(segment) && !NOT_A_NAME_START.test(segment))
          || known.some((ref) => nameKey(ref.label) === nameKey(segment));
        if ((segments.length >= 2 && segments.every(personLike))
          || (initialAndSurname && known.length === 1)) {
          return [nameFinding(this, name, {
            signature: "autores", signatureLabel: "Autores en el título",
            severity: known.length ? "medium" : "low",
            title: `Autores escritos en el título: ${segments.map(quote).join(", ")}`,
            suggestion: `Título ${quote(name.value.replace(match[0], "").replace(/\s+/gu, " ").trim())} con créditos de compositor`,
            related: known,
            evidence: { segments, knownPersons: known.length },
            span,
          })];
        }
      }
      return [];
    });
  },
};

const DURATION = /(?<![\d:.])\d{1,2}[:'’´]\d{2}(?![\d:])(?!\s*(?:a\.?\s?m|p\.?\s?m)\b)/iu;

export const durationInTitle: Detector = {
  key: "duracion_en_titulo",
  category: CATEGORY,
  label: "Duración dentro del título",
  description: "El extractor dejó la duración pegada al título («Ángel 3:30»): va en la duración de la pista.",
  run({ names }) {
    return names.filter((name) => (name.kind === "track" || name.kind === "album")
      && DURATION.test(name.value) && /\p{L}{2,}/u.test(name.value.replace(DURATION, ""))).map((name) => {
      const span = firstSpan(name.value, DURATION)!;
      return nameFinding(this, name, {
        severity: "medium",
        title: `Duración ${quote(name.value.slice(span[0], span[1]))} escrita dentro del título`,
        suggestion: `Título ${quote((name.value.slice(0, span[0]) + name.value.slice(span[1])).replace(/\s+/gu, " ").replace(/[\s\-–—.,;:]+$|^[\s\-–—.,;:]+/gu, "").replace(/\s+[-–—]\s+(?=\S+$)/u, " ").trim())} y la duración en su campo`,
        span,
      });
    });
  },
};

const YEAR_IN_GROUP = /[([][^()[\]]*?(?:\b(?:19|20)\d{2}\b|'\d{2}\b)[^()[\]]*[)\]]|\s[-–—]\s(?:19|20)\d{2}\s[-–—]\s/u;

export const yearInTrackTitle: Detector = {
  key: "anio_en_titulo_de_pista",
  category: CATEGORY,
  label: "Año o versión dentro del título",
  description: "Año de grabación o de la versión escrito en el título de la pista («Fronteras (1998)», «Línea De Fuego (Demo 2004)»).",
  run({ names }) {
    return names.filter((name) => name.kind === "track" && YEAR_IN_GROUP.test(name.value)).map((name) => {
      const span = firstSpan(name.value, YEAR_IN_GROUP)!;
      return nameFinding(this, name, {
        severity: "low",
        title: `Dato de grabación dentro del título: ${quote(name.value.slice(span[0], span[1]).trim())}`,
        span,
      });
    });
  },
};

const TRAILING_GROUP = /\s*\(([^()]+)\)\s*$/u;

export const qualifierInArtistName: Detector = {
  key: "aclaracion_en_nombre_de_artista",
  category: CATEGORY,
  label: "Región, alias o aclaración en el nombre del artista",
  description: "Un paréntesis final con la región («Noctambulath (Caracas)»), el nombre real («Yordano (Giordano Di Marzo)») o un segundo nombre («Paro Kardíaco - Paro K»).",
  run(context) {
    return context.names.filter((name) => name.kind === "artist").flatMap((name) => {
      const artist = context.artists.get(name.id)!;
      const trailing = TRAILING_GROUP.exec(name.value);
      if (trailing) {
        const inner = trailing[1]!.trim();
        const base = name.value.slice(0, trailing.index).trim();
        const span: [number, number] = [trailing.index, name.value.length];
        if (isKnownPlace(context.lexicon, inner) || (artist.originCity && nameKey(artist.originCity).includes(nameKey(inner)))) {
          return [nameFinding(this, name, {
            signature: "region", signatureLabel: "Región en el nombre",
            severity: "medium",
            title: `La región ${quote(inner)} está escrita en el nombre`,
            suggestion: `Nombre ${quote(base)}${artist.originCity ? "" : ` y origen ${quote(inner)}`}`,
            evidence: { originCity: artist.originCity },
            span,
          })];
        }
        if (/^(?:19|20)\d{2}$/u.test(inner)) {
          return [nameFinding(this, name, {
            signature: "anio", signatureLabel: "Año en el nombre", severity: "medium",
            title: `El año ${quote(inner)} está escrito en el nombre`,
            suggestion: `Nombre ${quote(base)} y el año en su campo`, span,
          })];
        }
        const personIds = context.lexicon.personsByKey.get(nameKey(inner)) ?? [];
        if (personIds.length || NAME_SHAPED.test(inner)) {
          return [nameFinding(this, name, {
            signature: "nombre_real", signatureLabel: "Nombre real o alias entre paréntesis", severity: "low",
            title: `Nombre real o alias entre paréntesis: ${quote(inner)}`,
            suggestion: `Nombre ${quote(base)} y ${quote(inner)} como alias o persona vinculada`,
            related: personIds.slice(0, 1).map((id) => ({ kind: "person" as const, id, label: context.persons.get(id)?.name ?? inner })),
            span,
          })];
        }
        return [nameFinding(this, name, {
          signature: "aclaracion", signatureLabel: "Aclaración entre paréntesis", severity: "low",
          title: `Aclaración entre paréntesis en el nombre: ${quote(inner)}`,
          suggestion: `Nombre ${quote(base)} y la aclaración como alias o nota`, span,
        })];
      }
      const double = /^(.{2,}?)\s+[-–—/]\s+(.{2,})$/u.exec(name.value);
      if (double) {
        return [nameFinding(this, name, {
          signature: "dos_nombres", signatureLabel: "Dos nombres en uno", severity: "medium",
          title: `Dos nombres en uno: ${quote(double[1]!)} y ${quote(double[2]!)}`,
          suggestion: `Un nombre principal y el otro como alias`,
          span: [double[1]!.length, name.value.length - double[2]!.length],
        })];
      }
      return [];
    });
  },
};

const LABEL = /(?:^|\s)([\p{L}][\p{L}.\s]{1,28}?):\s*(?=\S)/u;
const GUEST_PREFIX = /^\s*(?:featuring|feat\.?|ft\.?)(?=[\s:.]|$)\s*:?\s*/iu;
const GUEST_LABEL = /^(?:featuring|feat|ft)\.?$/iu;

/** Rótulo antes de los dos puntos: la última frase corta, sin lo que va pegado delante («Rick TarboxAdapt» → «Adapt»). */
function labelBefore(text: string): string {
  const piece = text.split(/\s[-–—]\s|[,;]/u).at(-1)!.trim();
  const camel = /\p{Ll}(\p{Lu}[\p{Ll}.]+)$/u.exec(piece);
  if (camel) return camel[1]!;
  return piece.split(/\s+/u).slice(-2).join(" ");
}

export const labelInName: Detector = {
  key: "etiqueta_en_nombre",
  category: CATEGORY,
  label: "Rol o etiqueta dentro del nombre",
  description: "El nombre arrastra el rótulo de la fuente («Lyrics: N. Zuleta», «Banda: Misantropia», «Featuring: Didi Gutman»).",
  run(context) {
    return context.names.filter((name) => name.kind === "person" || name.kind === "artist" || name.kind === "organization").flatMap((name) => {
      if (name.kind === "person" && GUEST_PREFIX.test(name.value)) {
        const rest = name.value.replace(GUEST_PREFIX, "").trim();
        return [nameFinding(this, name, {
          signature: "invitado", signatureLabel: "«feat.» en el nombre", severity: "medium",
          title: "El nombre empieza por «feat.»: es un crédito de invitado, no parte del nombre",
          suggestion: `Nombre ${quote(rest)} y crédito de invitado`,
          span: firstSpan(name.value, GUEST_PREFIX)!,
        })];
      }
      const match = LABEL.exec(name.value);
      if (!match) return [];
      const colon = match.index + match[0].lastIndexOf(":");
      const label = labelBefore(name.value.slice(0, colon));
      if (!label) return [];
      const start = colon - label.length;
      const rest = name.value.slice(colon + 1).trim();
      if (GUEST_LABEL.test(label)) {
        return [nameFinding(this, name, {
          signature: "invitado", signatureLabel: "«feat.» en el nombre", severity: "medium",
          title: "El nombre lleva «feat:»: es un crédito de invitado, no parte del nombre",
          suggestion: `Nombre ${quote(rest)} y crédito de invitado`,
          span: [start, colon + 1],
        })];
      }
      const isRole = keyTokens(label).some((token) => context.lexicon.roleTokens.has(token));
      return [nameFinding(this, name, {
        signature: isRole ? "rol" : "etiqueta",
        signatureLabel: isRole ? "Rol de crédito en el nombre" : "Rótulo con dos puntos en el nombre",
        severity: isRole ? "high" : "medium",
        title: isRole ? `El rol ${quote(label)} está escrito dentro del nombre` : `Rótulo ${quote(label + ":")} dentro del nombre`,
        suggestion: isRole ? `Nombre ${quote(rest)} con el crédito ${quote(label)}` : `Nombre ${quote(rest)}`,
        evidence: { label, learnedRole: isRole },
        span: [start, start + label.length + 1],
      })];
    });
  },
};

/** «Juan Cristóbal Losada (aka Mr. Sonic)», «alias El Chacal», «Aura De Fuenmayor as "Lohan Duff"». */
const ALIAS_IN_NAME = /^(.+?)\s*(?:[([]\s*)?\b(?:aka|a\.k\.a\.?|alias)\s+(.+?)\s*[)\]]?\s*$|^(.+?)\s+as\s+["“«](.+?)["”»]\s*$/iu;

export const severalPeopleInOne: Detector = {
  key: "varias_personas_en_una",
  category: CATEGORY,
  label: "Varias personas en una ficha",
  description: "Una ficha de persona que en realidad es una lista («Eliezer Delgado, Gregory Carrero», «L. Rangel/ E. Sáez/ J.F. Coral») o un nombre con su alias escrito dentro («(aka Mr. Sonic)»).",
  run({ names }) {
    return names.filter((name) => name.kind === "person").flatMap((name) => {
      // Un alias no es otra persona: se separa como alias, no se divide la ficha.
      const alias = ALIAS_IN_NAME.exec(name.value);
      if (alias) {
        const base = (alias[1] ?? alias[3])!.trim();
        const other = (alias[2] ?? alias[4])!.replace(/^["“«]|["”»]$/gu, "").trim();
        if (base && other) {
          return [nameFinding(this, name, {
            signature: "alias_en_nombre", signatureLabel: "Alias escrito dentro del nombre", severity: "medium",
            title: `El alias ${quote(other)} está escrito dentro del nombre: es una persona, no dos`,
            suggestion: `Nombre ${quote(base)} y ${quote(other)} como alias`,
            evidence: { name: base, alias: other },
            span: [base.length, name.value.length],
          })];
        }
      }
      const parts = name.value.split(/\s*(?:[,/&;]|\sy\s)\s*/u).map((part) => part.trim()).filter((part) => part.length > 1);
      if (/\b(?:feat|ft|featuring)\b/iu.test(name.value)) return [];
      const multiple = classifyPersonName(name.value).kind === "multiple_people"
        || (parts.length >= 2 && parts.every((part) => NAME_SHAPED.test(part)) && /[,/&;]/u.test(name.value));
      if (!multiple) return [];
      return [nameFinding(this, name, {
        severity: "high",
        title: parts.length >= 2 ? `Parece una lista de ${parts.length} personas` : "Demasiadas palabras para el nombre de una persona",
        suggestion: parts.length >= 2 ? `Dividir en ${parts.map(quote).join(", ")}` : "Dividir la ficha en las personas que la componen",
        evidence: { parts },
      })];
    });
  },
};

const GLUED = /\p{Ll}{3,}\p{Lu}\p{Ll}{2,}/gu;

function gluedWords(name: NameValue, vocabulary: Set<string>): Array<{ left: string; right: string; index: number; length: number }> {
  const out: Array<{ left: string; right: string; index: number; length: number }> = [];
  for (const token of name.value.matchAll(/\p{L}+/gu)) {
    for (const glued of token[0].matchAll(GLUED)) {
      const boundary = [...glued[0]].findIndex((char, index) => index > 0 && /\p{Lu}/u.test(char));
      const cut = (token.index ?? 0) + (glued.index ?? 0) + boundary;
      const left = /\p{L}+$/u.exec(name.value.slice(0, cut))?.[0] ?? "";
      const right = /^\p{L}+/u.exec(name.value.slice(cut))?.[0] ?? "";
      if (vocabulary.has(nameKey(left)) && vocabulary.has(nameKey(right))) out.push({ left, right, index: cut - left.length, length: left.length + right.length });
    }
  }
  return out;
}

export const gluedWordsDetector: Detector = {
  key: "palabras_pegadas",
  category: CATEGORY,
  label: "Palabras pegadas",
  description: "Dos palabras que el catálogo conoce por separado quedaron unidas sin espacio («BambaBonus», «TarboxAdapt»): el extractor perdió un separador. Un nombre de una sola palabra en camelCase («MoonDub») suele ser estilizado a propósito y va aparte.",
  run({ names, lexicon }) {
    return names.flatMap((name) => {
      const found = gluedWords(name, lexicon.vocabulary);
      if (!found.length) return [];
      const first = found[0]!;
      // Una sola palabra camelCase («RussoMan», «StudioSonica») es casi siempre
      // la grafía elegida por el artista. Excepción: una persona cuyo primer
      // tramo es un nombre de pila («CarlosAcosta») sí perdió el espacio.
      const singleWord = /^\p{L}+$/u.test(name.value.trim());
      const stylized = singleWord && found.length === 1 && !(name.kind === "person" && lexicon.givenNames.has(nameKey(first.left)));
      return [nameFinding(this, name, {
        ...(stylized ? { signature: "posible_estilizado", signatureLabel: "Una sola palabra en camelCase: posible grafía estilizada" } : {}),
        severity: "low",
        title: stylized
          ? `${quote(name.value)} une dos palabras en camelCase: puede ser una grafía estilizada a propósito`
          : `Palabras pegadas: ${found.map((item) => quote(item.left + item.right)).join(", ")}`,
        suggestion: `Separar ${found.map((item) => `${quote(item.left)} y ${quote(item.right)}`).join("; ")}`,
        span: [first.index, first.index + first.length],
      })];
    });
  },
};

export const SEGMENTATION_DETECTORS: Detector[] = [
  artistInTrackTitle, artistInAlbumTitle, creditsInTitle, durationInTitle, yearInTrackTitle,
  qualifierInArtistName, labelInName, severalPeopleInOne, gluedWordsDetector,
];
