// CRV · Fichas repetidas: la misma ficha escrita de otra forma.
//
// Casos reales del estudio (2026-09-16): «Flanders» / «Los Flanders», «Zeta» /
// «The Zeta», «Victor Gámez» / «Víctor Gámez», dos «Regreso Del Abismo» del
// mismo artista, 60 pistas repetidas dentro de un mismo disco.
//
// Las personas ya tienen su detector y su pestaña (Posibles duplicados): aquí
// solo entran los pares de persona que esa herramienta no propuso ni cerró.
// Un par que alguien ya declaró distinto (`ingest.curation_distinct_pairs`)
// tampoco vuelve, sea de artistas, organizaciones, discos, pistas o personas.
//
// TODO SE EMITE POR PARES (PLAN_CURADURIA E2.3). Un hallazgo por grupo tenía
// en su huella a todos los miembros: bastaba que apareciera un tercero para
// que «no es un problema» se perdiera. Un par tiene huella propia (tipo +
// ids menor y mayor) y sobrevive a renombrados y a miembros nuevos.
import { organizationKey } from "../../review/person-names.js";
import { isGenericTitle, titleTokens } from "../../ambiguity/text.js";
import { compactKey, nameKey, type NameValue } from "../lexicon.js";
import type { EntityRef, Finding, Severity } from "../types.js";
import { quote, type AnalysisContext, type Detector } from "./shared.js";

const CATEGORY = "fichas_repetidas";

function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value.length < 2) continue;
    const list = groups.get(value);
    if (list) list.push(item); else groups.set(value, [item]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function pairsOf<T extends { id: number }>(group: T[]): Array<[T, T]> {
  const sorted = [...group].sort((a, b) => a.id - b.id);
  const out: Array<[T, T]> = [];
  for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) out.push([sorted[i]!, sorted[j]!]);
  return out;
}

/** Clave de un par sin orden: la misma que `ingest.curation_distinct_pairs` y la cola. */
export function pairKey(kind: string, a: number, b: number): string {
  return `${kind}:${Math.min(a, b)}-${Math.max(a, b)}`;
}

function pairFinding(
  detector: Detector,
  a: NameValue,
  b: NameValue,
  input: { signature: string; signatureLabel: string; severity: Severity; title: string; suggestion: string; evidence?: Record<string, unknown>; extra?: EntityRef[] },
): Finding {
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  return {
    detector: detector.key, category: detector.category,
    signature: input.signature, signatureLabel: input.signatureLabel, severity: input.severity,
    entity: { kind: first.kind, id: first.id, label: first.label },
    field: first.field, value: first.value,
    title: input.title, suggestion: input.suggestion,
    related: [...first.related, { kind: second.kind, id: second.id, label: second.label }, ...(input.extra ?? [])],
    pair: [first.id, second.id],
    evidence: { values: [first, second].map((member) => ({ id: member.id, value: member.value })), ...(input.evidence ?? {}) },
  };
}

function namesOf(context: AnalysisContext, kind: NameValue["kind"]): NameValue[] {
  return context.names.filter((name) => name.kind === kind);
}

const withoutTrailingGroup = (value: string): string => value.replace(/\s*\([^()]*\)\s*$/u, "");

export const equivalentArtists: Detector = {
  key: "artistas_equivalentes",
  category: CATEGORY,
  label: "Artistas escritos de otra forma",
  description: "Artistas que coinciden al quitar tildes, artículos («Los», «The»), espacios o una aclaración final entre paréntesis.",
  run(context) {
    const artists = namesOf(context, "artist");
    const seen = new Set<string>();
    const out: Finding[] = [];
    const rules: Array<[string, string, (name: NameValue) => string]> = [
      ["misma_clave", "Solo cambian tildes, mayúsculas o signos", (name) => nameKey(name.value)],
      ["sin_articulo_o_espacios", "Solo cambian el artículo o los espacios", (name) => compactKey(name.value)],
      ["con_aclaracion", "Uno lleva una aclaración entre paréntesis", (name) => compactKey(withoutTrailingGroup(name.value))],
    ];
    for (const [signature, signatureLabel, key] of rules) {
      for (const group of groupBy(artists, key)) {
        // Un par se emite una vez, con la regla más estricta que lo junta.
        for (const [a, b] of pairsOf(group)) {
          const pair = pairKey("artist", a.id, b.id);
          if (seen.has(pair) || context.snapshot.handledPairs.has(pair)) continue;
          seen.add(pair);
          out.push(pairFinding(this, a, b, {
            signature, signatureLabel, severity: "medium",
            title: `${quote(a.value)} y ${quote(b.value)} parecen el mismo artista${group.length > 2 ? ` (${group.length} con la misma forma)` : ""}`,
            suggestion: "Comparar las fichas y fusionarlas si son el mismo artista",
            evidence: { groupSize: group.length },
          }));
        }
      }
    }
    return out;
  },
};

export const equivalentOrganizations: Detector = {
  key: "organizaciones_equivalentes",
  category: CATEGORY,
  label: "Organizaciones escritas de otra forma",
  description: "Organizaciones que coinciden al quitar tildes, artículos, espacios o las palabras genéricas de sello y estudio.",
  run(context) {
    const orgs = namesOf(context, "organization");
    const seen = new Set<string>();
    const out: Finding[] = [];
    const rules: Array<[string, string, Severity, (name: NameValue) => string]> = [
      ["sin_articulo_o_espacios", "Solo cambian tildes, artículo o espacios", "medium", (name) => compactKey(name.value)],
      ["sin_palabras_de_sello", "Coinciden sin «Records», «Estudios»…", "low", (name) => {
        const key = organizationKey(name.value).replace(/\s+/gu, "");
        return key.length >= 4 ? key : "";
      }],
    ];
    for (const [signature, signatureLabel, severity, key] of rules) {
      for (const group of groupBy(orgs, key)) {
        for (const [a, b] of pairsOf(group)) {
          const pair = pairKey("organization", a.id, b.id);
          if (seen.has(pair) || context.snapshot.handledPairs.has(pair)) continue;
          seen.add(pair);
          out.push(pairFinding(this, a, b, {
            signature, signatureLabel, severity,
            title: `${quote(a.value)} y ${quote(b.value)} parecen la misma organización${group.length > 2 ? ` (${group.length} con la misma forma)` : ""}`,
            suggestion: "Comparar las fichas y fusionarlas si son la misma organización",
            evidence: { groupSize: group.length },
          }));
        }
      }
    }
    return out;
  },
};

export const repeatedAlbums: Detector = {
  key: "discos_repetidos",
  category: CATEGORY,
  label: "Discos repetidos del mismo artista",
  description: "Dos discos del mismo artista con el mismo título normalizado (números, volúmenes y tildes incluidos). Un par ya declarado distinto no vuelve.",
  run(context) {
    const out: Finding[] = [];
    const albums = namesOf(context, "album");
    const byArtist = new Map<number, NameValue[]>();
    for (const name of albums) {
      const album = context.albums.get(name.id)!;
      const list = byArtist.get(album.artistId);
      if (list) list.push(name); else byArtist.set(album.artistId, [name]);
    }
    for (const [artistId, list] of byArtist) {
      const artistName = context.artists.get(artistId)?.name ?? "";
      for (const group of groupBy(list, (name) => titleTokens(name.value).join(" "))) {
        for (const [a, b] of pairsOf(group)) {
          if (context.snapshot.handledPairs.has(pairKey("album", a.id, b.id))) continue;
          const yearA = context.albums.get(a.id)!.releaseYear;
          const yearB = context.albums.get(b.id)!.releaseYear;
          const generic = isGenericTitle(a.value, artistName);
          const differentYears = yearA !== null && yearB !== null && yearA !== yearB;
          if (generic && differentYears) continue;
          out.push(pairFinding(this, a, b, {
            signature: generic ? "titulo_generico" : "mismo_titulo",
            signatureLabel: generic ? "Mismo título genérico («Demo», «EP»)" : "Mismo título",
            severity: generic || differentYears ? "low" : "medium",
            title: `Dos discos de ${quote(artistName)} con el mismo título ${quote(a.value)}${differentYears ? ` (${yearA} y ${yearB})` : ""}`,
            suggestion: differentYears ? "Confirmar si es una reedición o el mismo disco con otro año" : "Comparar las pistas y fusionar si es el mismo disco",
            evidence: { years: [yearA, yearB] },
          }));
        }
      }
    }
    return out;
  },
};

export const repeatedTracks: Detector = {
  key: "pistas_repetidas",
  category: CATEGORY,
  label: "Pistas repetidas en un disco",
  description: "El mismo título dos o más veces en el mismo disco y la misma cara: pista duplicada por la extracción o versión sin marcar.",
  run(context) {
    const out: Finding[] = [];
    const tracks = new Map(namesOf(context, "track").map((name) => [name.id, name]));
    for (const list of context.tracksByAlbum.values()) {
      const byDisc = new Map<number, NameValue[]>();
      for (const track of list) {
        const discTracks = byDisc.get(track.disc);
        if (discTracks) discTracks.push(tracks.get(track.id)!); else byDisc.set(track.disc, [tracks.get(track.id)!]);
      }
      for (const discTracks of byDisc.values()) {
        for (const group of groupBy(discTracks, (name) => nameKey(name.value).replace(/\s+/gu, ""))) {
          const position = new Map(group.map((name) => [name.id, context.tracks.get(name.id)!.number]));
          for (const [a, b] of pairsOf(group)) {
            if (context.snapshot.handledPairs.has(pairKey("track", a.id, b.id))) continue;
            const positions = [position.get(a.id)!, position.get(b.id)!].sort((x, y) => x - y);
            out.push(pairFinding(this, a, b, {
              signature: this.key, signatureLabel: this.label, severity: "low",
              title: `${quote(a.value)} está repetida: pistas ${positions.join(" y ")}${group.length > 2 ? ` (aparece ${group.length} veces)` : ""}`,
              suggestion: "Retirar la pista duplicada o marcar la versión distinta en el título",
              evidence: { positions, groupPositions: [...position.values()].sort((x, y) => x - y) },
            }));
          }
        }
      }
    }
    return out;
  },
};

export const equivalentPersons: Detector = {
  key: "personas_equivalentes",
  category: CATEGORY,
  label: "Personas escritas de otra forma",
  description: "Personas cuyo nombre solo cambia en tildes, mayúsculas o signos y que el detector de Posibles duplicados no propuso ni cerró.",
  run(context) {
    const out: Finding[] = [];
    for (const group of groupBy(namesOf(context, "person"), (name) => nameKey(name.value))) {
      for (const [a, b] of pairsOf(group)) {
        if (context.snapshot.handledPairs.has(pairKey("person", a.id, b.id))) continue;
        out.push(pairFinding(this, a, b, {
          signature: this.key, signatureLabel: this.label, severity: "medium",
          title: `${quote(a.value)} y ${quote(b.value)} solo cambian en tildes, mayúsculas o signos`,
          suggestion: "Comparar las fichas y fusionarlas si son la misma persona",
        }));
      }
    }
    return out;
  },
};

export const DUPLICATE_DETECTORS: Detector[] = [equivalentArtists, equivalentOrganizations, repeatedAlbums, repeatedTracks, equivalentPersons];
