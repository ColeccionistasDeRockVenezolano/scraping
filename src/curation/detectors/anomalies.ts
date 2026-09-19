// CRV · «Otros»: lo raro que ningún detector específico explica.
//
// No busca un problema conocido: compara cada nombre o título contra el
// perfil de su propio campo (qué signos usa, cuánto mide, cuántas letras
// tiene) y marca lo que se sale. Si un nombre ya tiene un hallazgo de forma
// —sucio, mal segmentado, de otro tipo, incoherente— no se repite aquí; lo que
// queda son conflictos que la taxonomía todavía no tiene, agrupados por su
// firma para que un tipo nuevo se vea como un grupo y no como ruido suelto.
//
// La firma de un signo raro es su CLASE Unicode (puntuación, moneda, símbolo,
// invisible o marca) y el campo, no el carácter: con un subgrupo por carácter
// 156 hallazgos quedaban repartidos en 52 subgrupos (B1). El carácter concreto
// sigue en el título y en la evidencia.
import { letterRatio, signClass, signsOf, type FieldProfile, type NameValue, type SignClass } from "../lexicon.js";
import { OTHER_CATEGORY } from "../taxonomy.js";
import type { Finding } from "../types.js";
import { ENTITY_NOUN, codePoint, nameFinding, quote, type AnalysisContext, type Detector } from "./shared.js";

/**
 * Un signo es infrecuente en un campo si lo usan muy pocos valores: como
 * mucho 3, o 5 por cada 10.000 valores en campos grandes. Por encima de eso
 * el catálogo ya lo usa de forma establecida («#1», «Luna Verde*»).
 */
const RARE_SIGN_PER_VALUE = 0.0005;
const RARE_SIGN_MIN_ALLOWED = 3;
const NON_LATIN_SHARE = 0.01;
const LENGTH_Z = 8;

/** Puntuación rara pero legítima confirmada por el corpus real. */
function legitimateRareSign(name: NameValue, sign: string): boolean {
  if (sign === "," && name.kind === "artist") return true;
  if (sign === "’") {
    const index = name.value.indexOf(sign);
    return index > 0 && /\p{L}/u.test(name.value[index - 1] ?? "") && /\p{L}/u.test(name.value[index + 1] ?? "");
  }
  if (sign === "@" && name.kind === "artist" && name.value.trimStart().startsWith("@")) return true;
  return false;
}

const FIELD_LABEL: Readonly<Record<string, string>> = {
  "artist.name": "nombres de artista", "person.name": "nombres de persona", "organization.name": "nombres de organización",
  "album.title": "títulos de disco", "track.title": "títulos de pista",
};

const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ["griego", /\p{Script=Greek}/u], ["cirílico", /\p{Script=Cyrillic}/u], ["chino/japonés (kanji)", /\p{Script=Han}/u],
  ["japonés (kana)", /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ["coreano", /\p{Script=Hangul}/u], ["árabe", /\p{Script=Arabic}/u],
  ["hebreo", /\p{Script=Hebrew}/u], ["tailandés", /\p{Script=Thai}/u], ["devanagari", /\p{Script=Devanagari}/u],
];

const NON_LATIN_LETTER = /(?![\p{Script=Latin}])\p{L}/u;

const SIGN_CLASS_LABEL: Readonly<Record<SignClass, { one: string; many: string }>> = {
  puntuacion: { one: "Signo de puntuación infrecuente", many: "Signos de puntuación infrecuentes" },
  moneda: { one: "Símbolo de moneda infrecuente", many: "Símbolos de moneda infrecuentes" },
  simbolo: { one: "Símbolo infrecuente", many: "Símbolos infrecuentes" },
  invisible_o_marca: { one: "Carácter invisible o marca infrecuente", many: "Caracteres invisibles o marcas infrecuentes" },
};

function scriptOf(value: string): string {
  return SCRIPTS.find(([, pattern]) => pattern.test(value))?.[0] ?? "otra escritura";
}

function fieldKey(name: NameValue): string {
  return `${name.kind}.${name.field}`;
}

/** Explicado = ya tiene un hallazgo de forma sobre la misma ficha. */
export const TEXT_FORM_CATEGORIES = new Set(["nombres_sucios", "mal_segmentados", "ficha_de_otro_tipo", "datos_incoherentes"]);

export const catalogAnomalies: Detector = {
  key: "anomalia_del_catalogo",
  category: OTHER_CATEGORY,
  label: "Anomalías sin categoría",
  description: "Valores que se salen del perfil de su propio campo (signos infrecuentes, otra escritura, largo o forma atípicos) y que ningún otro detector explica.",
  run(context) {
    return detectAnomalies(this, context, new Set());
  },
};

export function detectAnomalies(detector: Detector, context: AnalysisContext, explained: Set<string>): Finding[] {
  const nonLatinShare = new Map<string, number>();
  for (const name of context.names) {
    if (NON_LATIN_LETTER.test(name.value)) nonLatinShare.set(fieldKey(name), (nonLatinShare.get(fieldKey(name)) ?? 0) + 1);
  }
  const out: Finding[] = [];
  for (const name of context.names) {
    if (explained.has(`${name.kind}:${name.id}`)) continue;
    const profile = context.lexicon.profiles.get(fieldKey(name));
    if (!profile || profile.values < 50) continue;
    const found = anomaliesOf(detector, name, profile, (nonLatinShare.get(fieldKey(name)) ?? 0) / profile.values);
    if (found) out.push(found);
  }
  return out;
}

function anomaliesOf(detector: Detector, name: NameValue, profile: FieldProfile, nonLatinShare: number): Finding | undefined {
  const field = FIELD_LABEL[fieldKey(name)] ?? `${ENTITY_NOUN[name.kind] ?? name.kind}.${name.field}`;
  const rare = [...signsOf(name.value)].filter((sign) => {
    if (legitimateRareSign(name, sign)) return false;
    const docs = profile.signDocs.get(sign) ?? 0;
    return docs <= Math.max(RARE_SIGN_MIN_ALLOWED, Math.floor(profile.values * RARE_SIGN_PER_VALUE));
  });
  if (rare.length) {
    const sign = rare[0]!;
    const index = name.value.indexOf(sign);
    const kind = signClass(sign);
    return nameFinding(detector, name, {
      signature: `signo:${kind}:${fieldKey(name)}`,
      signatureLabel: `${SIGN_CLASS_LABEL[kind].many} en ${field}`,
      severity: "low",
      title: `${SIGN_CLASS_LABEL[kind].one} ${quote(sign)} (${codePoint(sign)}): aparece en ${profile.signDocs.get(sign) ?? 0} de ${profile.values} ${field}`,
      evidence: { signs: rare.map((item) => ({ sign: item, codePoint: codePoint(item), class: signClass(item), values: profile.signDocs.get(item) ?? 0 })), fieldValues: profile.values },
      span: [index, index + sign.length],
    });
  }
  if (NON_LATIN_LETTER.test(name.value) && nonLatinShare < NON_LATIN_SHARE) {
    const script = scriptOf(name.value);
    return nameFinding(detector, name, {
      signature: `escritura:${script}:${fieldKey(name)}`,
      signatureLabel: `Letras en ${script} en ${field}`,
      severity: "low",
      title: `Letras fuera del alfabeto latino (${script}): poco habitual en ${field}`,
      suggestion: "Confirmar si es el nombre original o un error de codificación; si es original, añadir la transliteración como alias",
    });
  }
  const length = [...name.value].length;
  const spread = 1.4826 * Math.max(profile.lengthMad, 1);
  const words = name.value.match(/\p{L}+/gu) ?? [];
  // Un artista de dos palabras puede tener un nombre genuinamente largo; el
  // caso roto del corpus, en cambio, está fragmentado en muchas palabras.
  const plausibleLongArtist = name.kind === "artist" && words.length <= 2;
  if (!plausibleLongArtist && (length - profile.lengthMedian) / spread > LENGTH_Z && length > 2 * profile.lengthMedian) {
    return nameFinding(detector, name, {
      signature: `largo:${fieldKey(name)}`,
      signatureLabel: `Largo atípico en ${field}`,
      severity: "low",
      title: `Mide ${length} caracteres; lo habitual en ${field} es ${Math.round(profile.lengthMedian)}`,
      suggestion: "Confirmar que el campo no arrastra texto de la página (descripción, créditos, notas)",
      evidence: { length, median: profile.lengthMedian },
    });
  }
  const letters = letterRatio(name.value);
  // Nombres de banda numéricos («20/20», «KP9000», «11011») son válidos.
  if (name.kind !== "artist" && profile.letterRatioMedian >= 0.8 && length >= 5 && letters < 0.35) {
    return nameFinding(detector, name, {
      signature: `pocas_letras:${fieldKey(name)}`,
      signatureLabel: `Casi sin letras en ${field}`,
      severity: "low",
      title: `Casi no tiene letras (${Math.round(letters * 100)} %): lo habitual en ${field} es ${Math.round(profile.letterRatioMedian * 100)} %`,
      evidence: { letterRatio: letters, fieldMedian: profile.letterRatioMedian },
    });
  }
  return undefined;
}
