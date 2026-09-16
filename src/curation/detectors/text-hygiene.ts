// CRV · Nombres sucios: defectos de forma en nombres y títulos.
//
// Casos reales del estudio (2026-09-16): «Umbra Summi Nobis» + U+200F (marca RLM
// invisible), «B.E.T.O.E» con U+200B entre letras (espacios de ancho cero de Bandcamp),
// «SaSaSa (un Cover ahÃ + U+00AD)» (UTF-8 leído como Latin-1), «Green &amp; blue»,
// «Tema interpretado por "Poster» (texto truncado), «Sesión -».
import { ENTITY_NOUN, codePoint, firstSpan, nameFinding, quote, type Detector } from "./shared.js";

const CATEGORY = "nombres_sucios";

/** Invisibles y de control: ancho cero, marcas de dirección, guion blando, NBSP. El unidor de grafemas
 * (U+034F), los rellenos de hangul y las vocales inherentes jemer se combinan con lo anterior: van fuera
 * de la clase para que no se peguen al carácter previo. */
const INVISIBLE = /(?:\u034F|\u115F|\u1160|\u17B4|\u17B5|[\u00A0\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\p{Cc}])/u;

function cleanInvisible(value: string): string {
  return value
    .replace(/\u00A0/gu, " ")
    .replace(new RegExp(INVISIBLE.source, "gu"), "")
    .replace(/\s+/gu, " ")
    .trim();
}

export const invisibleCharacters: Detector = {
  key: "caracteres_invisibles",
  category: CATEGORY,
  label: "Caracteres invisibles",
  description: "Espacios de ancho cero, marcas de dirección, guiones blandos o espacios duros que no se ven pero rompen búsquedas y comparaciones.",
  run({ names }) {
    return names.filter((name) => INVISIBLE.test(name.value)).map((name) => {
      const found = [...new Set([...name.value].filter((char) => INVISIBLE.test(char)))];
      const cleaned = cleanInvisible(name.value);
      return nameFinding(this, name, {
        severity: "medium",
        title: `${found.length === 1 ? "Carácter invisible" : "Caracteres invisibles"} en el ${name.field === "name" ? "nombre" : "título"}: ${found.map(codePoint).join(", ")}`,
        suggestion: `Dejarlo como ${quote(cleaned)}`,
        ...(cleaned ? { suggestedValue: cleaned } : {}),
        evidence: { characters: found.map(codePoint) },
        ...(firstSpan(name.value, INVISIBLE) ? { span: firstSpan(name.value, INVISIBLE)! } : {}),
      });
    });
  },
};

export const irregularSpacing: Detector = {
  key: "espacios_irregulares",
  category: CATEGORY,
  label: "Espacios de más",
  description: "Espacios al principio, al final o repetidos entre palabras.",
  run({ names }) {
    return names
      .filter((name) => !INVISIBLE.test(name.value) && (name.value !== name.value.trim() || / {2,}/u.test(name.value)))
      .map((name) => {
        const cleaned = name.value.replace(/\s+/gu, " ").trim();
        return nameFinding(this, name, {
          severity: "low",
          title: name.value !== name.value.trim() ? "Espacios al principio o al final" : "Espacios repetidos entre palabras",
          suggestion: `Dejarlo como ${quote(cleaned)}`,
          ...(cleaned ? { suggestedValue: cleaned } : {}),
          ...(firstSpan(name.value, /^\s+|\s+$| {2,}/u) ? { span: firstSpan(name.value, /^\s+|\s+$| {2,}/u)! } : {}),
        });
      });
  },
};

const MOJIBAKE = /\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2\u20AC|\uFFFD/u;
/** UTF-8 leído como Windows-1251 deja letras cirílicas dentro de palabras latinas: «manipulaciГіn», «Вel». */
const MIXED_SCRIPT_WORD = /\p{Script=Latin}+\p{Script=Cyrillic}+|\p{Script=Cyrillic}+\p{Script=Latin}+/u;
/** Una letra perdida en la conversión suele quedar como «?» entre letras: «Mar?a». */
const LOST_LETTER = /\p{L}\?\p{L}/u;

function repairMojibake(value: string): string | undefined {
  if (!/[\u0080-\u00FF]/u.test(value) || [...value].some((char) => (char.codePointAt(0) ?? 0) > 0xff)) return undefined;
  const repaired = Buffer.from(value, "latin1").toString("utf8");
  return repaired.includes("\uFFFD") || repaired === value ? undefined : repaired;
}

export const brokenEncoding: Detector = {
  key: "codificacion_rota",
  category: CATEGORY,
  label: "Codificación rota",
  description: "Texto UTF-8 leído con otra codificación («ahÃ» más un guion blando, en lugar de «ahí») o letras perdidas como «?».",
  run({ names }) {
    return names.flatMap((name) => {
      if (MOJIBAKE.test(name.value)) {
        const repaired = repairMojibake(name.value);
        return [nameFinding(this, name, {
          signature: "mojibake", signatureLabel: "UTF-8 leído como Latin-1",
          severity: "high",
          title: "Codificación rota: acentos convertidos en símbolos",
          ...(repaired ? { suggestion: `Probablemente es ${quote(repaired)}`, suggestedValue: repaired } : {}),
          ...(firstSpan(name.value, MOJIBAKE) ? { span: firstSpan(name.value, MOJIBAKE)! } : {}),
        })];
      }
      if (MIXED_SCRIPT_WORD.test(name.value)) {
        return [nameFinding(this, name, {
          signature: "mezcla_de_alfabetos", signatureLabel: "Letras cirílicas dentro de palabras latinas",
          severity: "high",
          title: "Una palabra mezcla letras latinas y cirílicas: codificación rota o letra suplantada",
          span: firstSpan(name.value, MIXED_SCRIPT_WORD)!,
        })];
      }
      if (LOST_LETTER.test(name.value)) {
        return [nameFinding(this, name, {
          signature: "letra_perdida", signatureLabel: "Letra perdida como «?»",
          severity: "medium",
          title: "Un «?» entre letras: probablemente una letra con tilde que se perdió",
          span: firstSpan(name.value, LOST_LETTER)!,
        })];
      }
      return [];
    });
  },
};

const HTML_ENTITY = /&(?:#\d{2,7}|#x[0-9a-f]{2,6}|[a-z][a-z0-9]{1,9});/iu;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " };

function decodeEntities(value: string): string {
  return value.replace(new RegExp(HTML_ENTITY.source, "giu"), (entity) => {
    const body = entity.slice(1, -1).toLowerCase();
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? entity;
  });
}

export const htmlEntities: Detector = {
  key: "entidades_html",
  category: CATEGORY,
  label: "Entidades HTML",
  description: "Restos del HTML de la fuente sin decodificar («&amp;», «&#39;»).",
  run({ names }) {
    return names.filter((name) => HTML_ENTITY.test(name.value)).map((name) => {
      const decoded = decodeEntities(name.value);
      return nameFinding(this, name, {
        severity: "medium",
        title: "Entidad HTML sin decodificar",
        suggestion: `Dejarlo como ${quote(decoded)}`,
        ...(decoded ? { suggestedValue: decoded } : {}),
        span: firstSpan(name.value, HTML_ENTITY)!,
      });
    });
  },
};

const PAIRS: ReadonlyArray<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"], ["«", "»"], ["“", "”"]];

function unbalancedMark(value: string): string | undefined {
  for (const [open, close] of PAIRS) {
    let depth = 0;
    for (const char of value) {
      if (char === open) depth += 1;
      else if (char === close) { depth -= 1; if (depth < 0) return close; }
    }
    if (depth !== 0) return open;
  }
  return (value.match(/"/gu) ?? []).length % 2 === 1 ? "\"" : undefined;
}

export const unbalancedMarks: Detector = {
  key: "signos_sin_cerrar",
  category: CATEGORY,
  label: "Paréntesis o comillas sin cerrar",
  description: "Un paréntesis, corchete o comilla que abre y no cierra (o al revés): casi siempre texto truncado por el extractor.",
  run({ names }) {
    return names.flatMap((name) => {
      const mark = unbalancedMark(name.value);
      if (!mark) return [];
      const index = name.value.lastIndexOf(mark);
      return [nameFinding(this, name, {
        severity: "medium",
        title: `${quote(mark)} sin pareja: el texto parece truncado o cortado en el lugar equivocado`,
        evidence: { mark },
        ...(index >= 0 ? { span: [index, index + mark.length] as [number, number] } : {}),
      })];
    });
  },
};

const DANGLING = /^[\s–—,;:/|•·*-]+(?=\S)|(?<=\S)\s*[–—,;:/|•·-]+\s*$/u;
/** «-en vivo-» envuelve un texto entre guiones: no es un signo suelto. */
const WRAPPED = /(?:^|\s)[–—-][^\s–—-][^–—-]*[–—-]\s*$/u;

export const danglingPunctuation: Detector = {
  key: "signos_colgantes",
  category: CATEGORY,
  label: "Signos colgantes",
  description: "Guiones, comas, barras o dos puntos al principio o al final: resto de un corte en el lugar equivocado («Sesión -»).",
  run({ names }) {
    return names.filter((name) => DANGLING.test(name.value) && !WRAPPED.test(name.value)).map((name) => {
      const cleaned = name.value.replace(new RegExp(DANGLING.source, "gu"), "").trim();
      return nameFinding(this, name, {
        severity: "low",
        title: "Signo suelto al principio o al final",
        suggestion: `Dejarlo como ${quote(cleaned)}`,
        ...(cleaned ? { suggestedValue: cleaned } : {}),
        span: firstSpan(name.value, DANGLING)!,
      });
    });
  },
};

export const lowercaseName: Detector = {
  key: "minusculas",
  category: CATEGORY,
  label: "Nombre todo en minúsculas",
  description: "Personas y organizaciones escritas enteramente en minúsculas («his home studio»): suelen venir de un campo mal extraído.",
  run({ names }) {
    return names
      .filter((name) => (name.kind === "person" || name.kind === "organization")
        && /\p{Ll}{3,}/u.test(name.value) && name.value === name.value.toLocaleLowerCase("es") && !URL_LIKE.test(name.value))
      .map((name) => nameFinding(this, name, {
        severity: "low",
        title: `${ENTITY_NOUN[name.kind]!.replace(/^./u, (char) => char.toUpperCase())} escrita toda en minúsculas`,
      }));
  },
};

const URL_LIKE = /https?:\/\/|www\.|\b[\w-]{2,}\.(?:com|net|org|info|biz|ve|es|co|blogspot|wordpress|bandcamp)\b/iu;

export const urlInName: Detector = {
  key: "url_en_nombre",
  category: CATEGORY,
  label: "Dirección web en el nombre",
  description: "Un dominio o URL ocupa el nombre o el título.",
  run({ names }) {
    return names.filter((name) => URL_LIKE.test(name.value)).map((name) => nameFinding(this, name, {
      severity: "medium",
      title: "El nombre contiene una dirección web",
      span: firstSpan(name.value, URL_LIKE)!,
    }));
  },
};

export const TEXT_HYGIENE_DETECTORS: Detector[] = [
  invisibleCharacters, irregularSpacing, brokenEncoding, htmlEntities, unbalancedMarks, danglingPunctuation, lowercaseName, urlInName,
];
