// CRV · Nombres sucios: defectos de forma en nombres y títulos.
//
// Casos reales del estudio (2026-09-16): «Umbra Summi Nobis» + U+200F (marca RLM
// invisible), «B.E.T.O.E» con U+200B entre letras (espacios de ancho cero de Bandcamp),
// «SaSaSa (un Cover ahÃ + U+00AD)» (UTF-8 leído como Latin-1), «Green &amp; blue»,
// «Tema interpretado por "Poster» (texto truncado), «Sesión -».
import { decodeHTMLStrict } from "entities";
import { replaceCodePoint } from "entities/lib/decode.js";
import { ENTITY_NOUN, URL_LIKE, codePoint, firstSpan, isAllLowercase, isLowercaseNonName, nameFinding, quote, type Detector } from "./shared.js";

const CATEGORY = "nombres_sucios";

/** Invisibles y de control: ancho cero, marcas de dirección, guion blando, NBSP. El unidor de grafemas
 * (U+034F), los rellenos de hangul y las vocales inherentes jemer se combinan con lo anterior: van fuera
 * de la clase para que no se peguen al carácter previo. El unidor de ancho cero (U+200D) solo cuenta
 * fuera de un emoji compuesto: entre dos pictogramas («👨‍🎤») es parte del emoji (B2). */
const INVISIBLE = /(?:\u034F|\u115F|\u1160|\u17B4|\u17B5|[\u00A0\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\p{Cc}]|(?<!\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F)?)\u200D|\u200D(?!\p{Extended_Pictographic}))/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "gu");

/** Exportada para E3 (repository.ts): compone las limpiezas de varios hallazgos sobre la misma ficha en una sola escritura. */
export function cleanInvisible(value: string): string {
  return value
    .replace(/\u00A0/gu, " ")
    .replace(INVISIBLE_ALL, "")
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
      const found = [...new Set([...name.value.matchAll(INVISIBLE_ALL)].map((match) => match[0]))];
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

/**
 * Windows-1252 pone letras y signos donde Latin-1 tiene controles (0x80–0x9F):
 * «â€™» es el «’» UTF-8 leído como Windows-1252. Sin esta tabla, el mojibake con
 * «€» se detectaba y nunca se reparaba (B3).
 */
const CP1252_BYTE: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Deshace «UTF-8 leído como Latin-1 o Windows-1252»: vuelve a los bytes y los
 * lee como UTF-8. Si algún carácter no tiene byte en esas tablas o los bytes no
 * son UTF-8 válido, no hay reparación segura: nada se propone.
 */
export function repairMojibake(value: string): string | undefined {
  if (!/[\u0080-\u00FF]/u.test(value)) return undefined;
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const byte = code <= 0xff ? code : CP1252_BYTE.get(code);
    if (byte === undefined) return undefined;
    bytes.push(byte);
  }
  let repaired: string;
  try {
    repaired = STRICT_UTF8.decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
  // Un control C1 en el resultado es otra capa de daño, no una reparación.
  return repaired === value || /[\u0080-\u009F]/u.test(repaired) ? undefined : repaired;
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

/** Los nombres de la tabla HTML5 llegan a 31 caracteres («&CounterClockwiseContourIntegral;»). */
const HTML_ENTITY = /&(?:#\d{2,7}|#x[0-9a-f]{2,6}|[a-z][a-z0-9]{1,31});/iu;

/**
 * Una referencia de carácter: `known` = es una entidad de verdad (numérica, o
 * con nombre de la tabla HTML5; `&roll;` en «Rock&roll;» no lo es, y los
 * nombres distinguen mayúsculas: `&Aacute;` ≠ `&aacute;`). `replacement` =
 * con qué reemplazarla, o `null` si no se puede hacer con seguridad:
 *  - números fuera de 1..0x10FFFF o surrogates: `String.fromCodePoint` lanzaba
 *    `RangeError` y el detector entero fallaba (C2);
 *  - un carácter invisible o de control: decodificarlo cambiaría un defecto
 *    visible por uno que no se ve. El espacio duro de `&nbsp;` pasa a espacio.
 * Del 128 al 159 las referencias numéricas son Windows-1252 según HTML5
 * (`&#150;` es «–»), igual que las decodifica un navegador.
 */
function decodeReference(entity: string): { known: boolean; replacement: string | null } {
  const body = entity.slice(1, -1);
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    const valid = Number.isInteger(code) && code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return { known: true, replacement: valid ? visibleOrNull(String.fromCodePoint(replaceCodePoint(code))) : null };
  }
  const decoded = decodeHTMLStrict(entity);
  return decoded === entity ? { known: false, replacement: null } : { known: true, replacement: visibleOrNull(decoded) };
}

function visibleOrNull(decoded: string): string | null {
  if (decoded === "\u00A0") return " ";
  return INVISIBLE.test(decoded) ? null : decoded;
}

function decodeEntities(value: string): { decoded: string; span?: [number, number] } {
  let span: [number, number] | undefined;
  const decoded = value.replace(new RegExp(HTML_ENTITY.source, "giu"), (entity: string, offset: number) => {
    const { known, replacement } = decodeReference(entity);
    if (known && !span) span = [offset, offset + entity.length];
    return replacement ?? entity;
  });
  return { decoded, ...(span ? { span } : {}) };
}

/** Exportada para E3 (repository.ts): igual que el detector, pero solo el texto decodificado. */
export function decodeHtmlEntitiesValue(value: string): string {
  return decodeEntities(value).decoded;
}

export const htmlEntities: Detector = {
  key: "entidades_html",
  category: CATEGORY,
  label: "Entidades HTML",
  description: "Restos del HTML de la fuente sin decodificar («&amp;», «&#39;»).",
  run({ names }) {
    return names.filter((name) => HTML_ENTITY.test(name.value)).flatMap((name) => {
      const { decoded, span } = decodeEntities(name.value);
      if (!span) return [];
      // Solo se propone un valor si decodificar cambia algo: una «corrección»
      // idéntica no cierra nunca el hallazgo y deja ruido en la auditoría.
      const fixable = decoded !== name.value && decoded.trim() !== "";
      return [nameFinding(this, name, {
        severity: "medium",
        title: fixable ? "Entidad HTML sin decodificar" : "Entidad HTML que no se puede decodificar sola",
        suggestion: fixable ? `Dejarlo como ${quote(decoded)}` : "Editar a mano: la referencia no corresponde a un carácter visible válido",
        ...(fixable ? { suggestedValue: decoded } : {}),
        span,
      })];
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

/** Exportada para E3 (repository.ts): mismo recorte que el detector, sin la ficha del hallazgo. */
export function trimDanglingPunctuation(value: string): string {
  return value.replace(new RegExp(DANGLING.source, "gu"), "").trim();
}

/** Exportada para E3 (repository.ts): colapsa espacios repetidos y recorta los extremos. */
export function collapseSpaces(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

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
  description: "Personas y organizaciones con nombre escrito enteramente en minúsculas («juan pérez»): suelen venir de un campo mal extraído. Una persona en minúsculas sin ninguna palabra de nombre va a «Persona que no es un nombre».",
  run({ names, lexicon }) {
    return names
      .filter((name) => (name.kind === "person" || name.kind === "organization")
        && isAllLowercase(name.value) && !URL_LIKE.test(name.value) && !isLowercaseNonName(lexicon, name))
      .map((name) => nameFinding(this, name, {
        severity: "low",
        title: `${ENTITY_NOUN[name.kind]!.replace(/^./u, (char) => char.toUpperCase())} escrita toda en minúsculas`,
      }));
  },
};

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
