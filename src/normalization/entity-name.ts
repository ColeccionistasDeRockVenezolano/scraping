/**
 * Normalizacion de identidad en capas.
 *
 * `original` nunca se modifica. `display` solo arregla Unicode/espacios para
 * una eventual presentacion canonica. Las claves comparables son derivadas:
 * la tilde permanece en la clave primaria y solo se elimina en la secundaria.
 */

const LEADING_ARTICLES = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "the", "a", "an",
]);

const CURLY_DOUBLE_QUOTES = /[\u201c\u201d\u201e\u00ab\u00bb]/gu;
const APOSTROPHES = /[\u2018\u2019\u02bc\u02bb\u00b4`]/gu;
const DASHES = /[\u2010-\u2015\u2212]/gu;
const COMBINING_MARKS = /\p{M}+/gu;
const SPACES = /[\p{Z}\s]+/gu;
const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]+/gu;

export interface NormalizedEntityName {
  /** Bytes/texto logico recibido; se conserva para claims y aliases. */
  original: string;
  /** Forma de presentacion segura (NFC + espacios), no una clave de match. */
  display: string;
  /** Clave principal: case/puntuacion/espacios normalizados, con tildes. */
  primaryKey: string;
  /** Senal secundaria: igual que primaryKey, pero sin diacriticos. */
  secondaryKey: string;
  /** Variante previsible sin articulo inicial; nunca reemplaza al original. */
  articlelessPrimaryKey: string;
  articlelessSecondaryKey: string;
  /** Variante auxiliar para diferencias de separadores (AC/DC vs AC DC). */
  compactPrimaryKey: string;
  compactSecondaryKey: string;
  tokens: string[];
}

/**
 * Cruces que las fuentes ponen junto al nombre de quien murió: «Nombre (†)»,
 * «Nombre †», «✝ Nombre». Es una marca, no parte del nombre.
 */
const DECEASED_MARKS = "†✝✞✟☨✙✛✜";
const DECEASED_GROUP = new RegExp(`\\s*[(\\[]\\s*[${DECEASED_MARKS}]+\\s*[)\\]]`, "gu");
const DECEASED_BARE = new RegExp(`\\s*[${DECEASED_MARKS}]+\\s*`, "gu");
const HAS_DECEASED_MARK = new RegExp(`[${DECEASED_MARKS}]`, "u");

export function hasDeceasedMark(value: string): boolean {
  return HAS_DECEASED_MARK.test(value);
}

/** Quita la marca de fallecido del nombre y avisa si la llevaba. */
export function stripDeceasedMark(value: string): { name: string; deceased: boolean } {
  if (!hasDeceasedMark(value)) return { name: value, deceased: false };
  const name = value.replace(DECEASED_GROUP, " ").replace(DECEASED_BARE, " ").replace(/\s+/gu, " ").trim();
  return { name, deceased: true };
}

export function normalizeUnicode(value: string): string {
  return value.normalize("NFC");
}

export function normalizeDisplayName(value: string): string {
  return normalizeUnicode(value).replace(SPACES, " ").trim();
}

function comparisonBase(value: string): string {
  return value
    .normalize("NFKC")
    .replace(CURLY_DOUBLE_QUOTES, '"')
    .replace(APOSTROPHES, "'")
    .replace(DASHES, "-")
    // &/"and" son una variacion editorial frecuente en nombres y sellos.
    // Se normaliza a la conjuncion espanola, sin alterar el valor guardado.
    .replace(/&/gu, " y ")
    .toLocaleLowerCase("es-VE")
    // Apostrofes internos son separadores debiles; las demas comillas y
    // puntuacion pasan a espacios para una clave estable.
    .replace(/'/gu, "")
    .replace(PUNCTUATION_AND_SYMBOLS, " ")
    .replace(SPACES, " ")
    .trim();
}

export function removeDiacritics(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

function withoutLeadingArticle(key: string): string {
  const tokens = key.split(" ").filter(Boolean);
  while (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0] ?? "")) tokens.shift();
  return tokens.join(" ");
}

export function normalizeEntityName(value: string): NormalizedEntityName {
  const original = value;
  const display = normalizeDisplayName(value);
  const primaryKey = comparisonBase(display);
  const secondaryKey = removeDiacritics(primaryKey);
  const articlelessPrimaryKey = withoutLeadingArticle(primaryKey);
  const articlelessSecondaryKey = removeDiacritics(articlelessPrimaryKey);
  return {
    original,
    display,
    primaryKey,
    secondaryKey,
    articlelessPrimaryKey,
    articlelessSecondaryKey,
    compactPrimaryKey: primaryKey.replace(/\s+/gu, ""),
    compactSecondaryKey: secondaryKey.replace(/\s+/gu, ""),
    tokens: primaryKey.split(" ").filter(Boolean),
  };
}

export function predictableNameVariants(value: string): string[] {
  const normalized = normalizeEntityName(value);
  return [...new Set([
    normalized.primaryKey,
    normalized.articlelessPrimaryKey,
    normalized.compactPrimaryKey,
    normalized.secondaryKey,
    normalized.articlelessSecondaryKey,
    normalized.compactSecondaryKey,
  ].filter(Boolean))];
}

/**
 * Solo reconoce aliases declarados explicitamente ("aka", "alias",
 * "conocido como"). Un apodo entre comillas, por si solo, no prueba identidad.
 */
export function splitDeclaredStageName(value: string): { legalOrCanonical: string; stageName: string } | null {
  const match = /^(.+?)\s+(?:a\.?k\.?a\.?|alias|conocid[oa]\s+como)\s+(.+)$/iu.exec(normalizeDisplayName(value));
  const legalOrCanonical = match?.[1]?.trim();
  const stageName = match?.[2]?.replace(/^["']|["']$/gu, "").trim();
  return legalOrCanonical && stageName ? { legalOrCanonical, stageName } : null;
}

/**
 * Apodo entre comillas al final del nombre de una persona: «Tirone González
 * "Canserbero"», «Reynaldo Goitía "Boston Rex"».
 *
 * REGLA DE BRIAN (2026-10-01, caso Canserbero): el nombre de una persona es su
 * nombre, no su nombre más el apodo. El apodo se guarda como alias —la
 * búsqueda ya mira nombres y aliases, así que sigue encontrándose por los dos—
 * y los créditos muestran el nombre («Tirone González», no «Canserbero»).
 *
 * No afirma identidad con nada: solo reparte en dos campos de la MISMA ficha lo
 * que la fuente escribió junto (a diferencia de `splitDeclaredStageName`, que
 * sí necesita un «aka» explícito porque de ahí se cuelgan decisiones de ER).
 *
 * Solo el apodo FINAL y solo con base de dos palabras o más: «Rafael "Pollo"
 * Brito» es la forma en que se lo nombra (apodo intercalado, decisión de Brian:
 * no se toca) y de «Pablo "El Che"» quedaría «Pablo», que no identifica a nadie
 * y choca con otras fichas.
 */
const TRAILING_NICKNAME = /^\s*(.+?)\s*["“”«]([^"“”«»]+)["“”»]\s*$/u;

export function splitTrailingNickname(value: string): { name: string; nicknames: string[] } | null {
  const match = TRAILING_NICKNAME.exec(normalizeDisplayName(value));
  const base = match?.[1]?.trim();
  const nickname = match?.[2]?.trim();
  if (!base || !nickname) return null;
  // La base tiene que ser un nombre que valga por sí solo (nombre + apellido).
  if (base.split(/\s+/u).filter(Boolean).length < 2) return null;
  // Una fuente puede apilar dos apodos en el mismo paréntesis: «Sebas/Grimmode».
  const nicknames = [...new Set(nickname.split("/").map((part) => part.trim()).filter(Boolean))];
  return nicknames.length ? { name: base, nicknames } : null;
}
