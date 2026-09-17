// CRV · Datos incoherentes: campos de una ficha que se contradicen.
//
// Casos reales del estudio (2026-09-16): 486 discos cuyo título dice «Demo»,
// «EP» o «En Vivo» y su tipo es otro (casi siempre `other`), «Guaicaipuro de
// Oro 1961» publicado en 1962, cinco discos de Sentimiento Muerto anteriores a
// la formación de la banda, una pista de 43.601 s y 104 discos con huecos en
// la numeración.
import { SEED_ALBUM_TYPE_WORD_SET, keyTokens, nameKey } from "../lexicon.js";
import type { Finding, Severity } from "../types.js";
import { nameFinding, quote, type Detector } from "./shared.js";

const CATEGORY = "datos_incoherentes";

const TYPE_LABEL: Readonly<Record<string, string>> = {
  studio_album: "álbum de estudio", live_album: "en vivo", ep: "EP", single: "sencillo", compilation: "recopilatorio",
  demo: "demo", soundtrack: "banda sonora", collaboration_album: "colaboración / split", remix: "remix", other: "sin clasificar",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

export const albumTypeVsTitle: Detector = {
  key: "tipo_de_disco_contra_titulo",
  category: CATEGORY,
  label: "Tipo de disco contra título",
  description: "El título declara un tipo («Demo», «EP», «En Vivo», y las palabras que el catálogo aprendió de los discos ya clasificados) distinto del tipo guardado.",
  run(context) {
    return context.names.filter((name) => name.kind === "album").flatMap((name) => {
      const album = context.albums.get(name.id)!;
      const key = ` ${nameKey(name.value)} `;
      const declared = new Map<string, string>();
      for (const [word, type] of context.lexicon.albumTypeWords) if (key.includes(` ${word} `)) declared.set(type, word);
      if (!declared.size || declared.has(album.albumType)) return [];
      const [type, word] = [...declared][0]!;
      const unclassified = album.albumType === "other";
      // Solo una palabra semilla y un único tipo declarado permiten corregir sin
      // criterio humano (nivel 0); lo aprendido del catálogo pide confirmación.
      const seedOnly = [...declared.values()].every((item) => SEED_ALBUM_TYPE_WORD_SET.has(item));
      return [nameFinding(this, name, {
        signature: unclassified ? "sin_clasificar" : "contradice",
        signatureLabel: unclassified ? "Tipo sin clasificar y el título lo dice" : "El título contradice el tipo",
        severity: unclassified ? "low" : "medium",
        title: unclassified
          ? `El título dice ${quote(word)} y el disco está sin clasificar`
          : `El título dice ${quote(word)} pero el tipo guardado es ${typeLabel(album.albumType)}`,
        suggestion: `Tipo ${typeLabel(type)}`,
        evidence: { storedType: album.albumType, declaredTypes: [...declared.keys()], words: [...declared.values()], wordSource: seedOnly ? "semilla" : "aprendida" },
      })];
    });
  },
};

const SINGLE_YEAR = /\b(?:19|20)\d{2}\b/gu;
const RANGE = /\b(?:19|20)\d{2}\s*[-–—/]\s*(?:(?:19|20)?\d{2})\b/u;

export const yearTitleVsRelease: Detector = {
  key: "anio_titulo_contra_publicacion",
  category: CATEGORY,
  label: "Año del título contra año de publicación",
  description: "El título nombra un año distinto del año de publicación guardado.",
  run(context) {
    return context.names.filter((name) => name.kind === "album").flatMap((name) => {
      const album = context.albums.get(name.id)!;
      const years = name.value.match(SINGLE_YEAR) ?? [];
      if (years.length !== 1 || RANGE.test(name.value) || album.releaseYear === null || Number(years[0]) === album.releaseYear) return [];
      const index = name.value.indexOf(years[0]!);
      return [nameFinding(this, name, {
        severity: "low",
        title: `El título dice ${years[0]} y el año de publicación guardado es ${album.releaseYear}`,
        suggestion: "Confirmar si el título habla de la grabación y el año guardado es el de la edición",
        evidence: { titleYear: Number(years[0]), releaseYear: album.releaseYear },
        span: [index, index + 4],
      })];
    });
  },
};

export const albumBeforeFormation: Detector = {
  key: "disco_antes_de_formacion",
  category: CATEGORY,
  label: "Disco anterior a la formación",
  description: "El disco se publicó antes del año de formación del artista.",
  run(context) {
    return context.names.filter((name) => name.kind === "album").flatMap((name) => {
      const album = context.albums.get(name.id)!;
      const artist = context.artists.get(album.artistId);
      if (!artist?.formedYear || album.releaseYear === null || album.releaseYear >= artist.formedYear) return [];
      return [nameFinding(this, name, {
        severity: "medium",
        title: `Publicado en ${album.releaseYear}, antes de que ${quote(artist.name)} se formara (${artist.formedYear})`,
        suggestion: "Corregir el año del disco o el año de formación del artista",
        evidence: { releaseYear: album.releaseYear, formedYear: artist.formedYear },
      })];
    });
  },
};

export const impossibleYears: Detector = {
  key: "anios_imposibles",
  category: CATEGORY,
  label: "Años imposibles",
  description: "Años de publicación, formación o separación en el futuro o anteriores a la grabación sonora comercial.",
  run(context) {
    const out: Finding[] = [];
    const bad = (year: number | null): boolean => year !== null && (year > context.currentYear + 1 || year < 1900);
    for (const name of context.names) {
      if (name.kind === "album") {
        const year = context.albums.get(name.id)!.releaseYear;
        if (bad(year)) out.push(nameFinding(this, name, { signature: "release_year", signatureLabel: "Año de publicación", severity: "high", title: `Año de publicación imposible: ${year}`, evidence: { releaseYear: year } }));
      }
      if (name.kind === "artist") {
        const artist = context.artists.get(name.id)!;
        for (const [field, label, year] of [["formed_year", "formación", artist.formedYear], ["disbanded_year", "separación", artist.disbandedYear]] as const) {
          if (bad(year)) out.push(nameFinding(this, name, { signature: field, signatureLabel: `Año de ${label}`, severity: "high", title: `Año de ${label} imposible: ${year}`, evidence: { field, year } }));
        }
      }
    }
    return out;
  },
};

export const atypicalDuration: Detector = {
  key: "duracion_atipica",
  category: CATEGORY,
  label: "Duración atípica",
  description: "Pistas de duración cero o muy lejos de la distribución de duraciones del propio catálogo (escala logarítmica, desviación robusta).",
  run(context) {
    const durations = context.snapshot.tracks.map((track) => track.durationSeconds).filter((value): value is number => value !== null && value > 0);
    if (durations.length < 30) return [];
    const logs = durations.map(Math.log).sort((a, b) => a - b);
    const med = logs[Math.floor(logs.length / 2)]!;
    const mad = [...logs.map((value) => Math.abs(value - med))].sort((a, b) => a - b)[Math.floor(logs.length / 2)]! || 0.1;
    const format = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const durationById = new Map(context.snapshot.tracks.map((track) => [track.id, track.durationSeconds]));
    return context.names.filter((name) => name.kind === "track").flatMap((name) => {
      const duration = durationById.get(name.id) ?? null;
      if (duration === null) return [];
      if (duration === 0) return [nameFinding(this, name, { signature: "cero", signatureLabel: "Duración cero", severity: "medium", title: "Duración guardada en cero" })];
      const z = (Math.log(duration) - med) / (1.4826 * mad);
      if (Math.abs(z) < 5) return [];
      const long = z > 0;
      // «Intro» de 9 s o «Entrevista a …» de medio minuto son cortas por naturaleza.
      if (!long && keyTokens(name.value).some((token) => context.lexicon.briefPieceTokens.has(token))) return [];
      return [nameFinding(this, name, {
        signature: long ? "muy_larga" : "muy_corta", signatureLabel: long ? "Mucho más larga que lo habitual" : "Mucho más corta que lo habitual",
        severity: "low" as Severity,
        title: `Duración ${format(duration)} ${long ? "muy por encima" : "muy por debajo"} de lo habitual en el catálogo (${format(Math.round(Math.exp(med)))})`,
        suggestion: long ? "Confirmar si es la duración del disco completo o un error de unidades" : "Confirmar la duración",
        evidence: { durationSeconds: duration, robustZ: Math.round(z * 10) / 10 },
      })];
    });
  },
};

/** ¿`numbers` son justo los enteros de `from` a `to`? */
function isRun(numbers: Set<number>, from: number, to: number): boolean {
  if (numbers.size !== to - from + 1) return false;
  for (let number = from; number <= to; number += 1) if (!numbers.has(number)) return false;
  return true;
}

export const numberingGaps: Detector = {
  key: "numeracion_con_huecos",
  category: CATEGORY,
  label: "Huecos en la numeración de pistas",
  description: "Faltan números de pista dentro de una cara: pistas que la extracción perdió o numeración mal leída. Una numeración que sigue de una cara a la siguiente (1–5, 6–10) no es un hueco.",
  run(context) {
    const out: Finding[] = [];
    for (const [albumId, tracks] of context.tracksByAlbum) {
      const album = context.albums.get(albumId);
      if (!album) continue;
      const discs = new Map<number, Set<number>>();
      for (const track of tracks) discs.set(track.disc, (discs.get(track.disc) ?? new Set<number>()).add(track.number));
      const order = [...discs.keys()].sort((a, b) => a - b);
      // Numeración continua entre caras o discos: cada uno sigue donde terminó
      // el anterior, sin huecos ni solapes. El disco entero está completo.
      let next = 1;
      const continuous = order.length > 1 && order.every((disc) => {
        const numbers = discs.get(disc)!;
        const to = Math.max(...numbers);
        const ok = isRun(numbers, next, to);
        next = to + 1;
        return ok;
      });
      if (continuous) continue;
      for (const disc of order) {
        const numbers = discs.get(disc)!;
        const max = Math.max(...numbers);
        if (max > 99 || max === numbers.size) continue;
        const missing = Array.from({ length: max }, (_, index) => index + 1).filter((number) => !numbers.has(number));
        const artist = context.artists.get(album.artistId);
        const startsAtTwo = missing.length === 1 && missing[0] === 1;
        const where = discs.size > 1 ? ` del disco ${disc}` : "";
        out.push({
          detector: this.key, category: this.category,
          signature: startsAtTwo ? "empieza_en_2" : this.key,
          ...(startsAtTwo ? { signatureLabel: "La numeración empieza en 2" } : {}),
          severity: "low",
          entity: { kind: "album", id: album.id, label: album.title }, field: "tracks", value: album.title,
          title: startsAtTwo
            ? `La numeración empieza en 2: falta la pista 1${where}`
            : `${missing.length === 1 ? "Falta la pista" : "Faltan las pistas"} ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? "…" : ""}${where}`,
          suggestion: startsAtTwo
            ? "Confirmar en la fuente si falta la primera pista o si la numeración empieza en 2; si no falta nada, renumerar desde 1"
            : "Revisar la fuente y completar o renumerar las pistas",
          related: artist ? [{ kind: "artist", id: artist.id, label: artist.name }] : [],
          evidence: { disc, missing, present: numbers.size, highest: max },
        });
      }
    }
    return out;
  },
};

export const COHERENCE_DETECTORS: Detector[] = [albumTypeVsTitle, yearTitleVsRelease, albumBeforeFormation, impossibleYears, atypicalDuration, numberingGaps];
