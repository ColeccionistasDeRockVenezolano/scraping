// CRV · Piezas comunes de los detectores.
import { keyTokens, type Lexicon, type NameValue } from "../lexicon.js";
import type {
  CatalogSnapshot, DetectorDefinition, EntityRef, Finding, Severity,
  SnapshotAlbum, SnapshotArtist, SnapshotOrganization, SnapshotPerson, SnapshotTrack,
} from "../types.js";

export interface AnalysisContext {
  snapshot: CatalogSnapshot;
  lexicon: Lexicon;
  names: NameValue[];
  artists: Map<number, SnapshotArtist>;
  persons: Map<number, SnapshotPerson>;
  organizations: Map<number, SnapshotOrganization>;
  albums: Map<number, SnapshotAlbum>;
  tracks: Map<number, SnapshotTrack>;
  tracksByAlbum: Map<number, SnapshotTrack[]>;
  currentYear: number;
}

export interface Detector extends DetectorDefinition {
  run(context: AnalysisContext): Finding[];
}

export const ENTITY_NOUN: Readonly<Record<string, string>> = {
  artist: "artista", person: "persona", organization: "organización", album: "disco", track: "pista",
};

export interface NameFindingInput {
  signature?: string;
  signatureLabel?: string;
  severity: Severity;
  title: string;
  suggestion?: string;
  /** Reemplazo determinista de `name.value` que la herramienta de corrección puede aplicar de un clic. */
  suggestedValue?: string;
  related?: EntityRef[];
  evidence?: Record<string, unknown>;
  /** Tramo problemático dentro del valor, en unidades de código (String#slice). */
  span?: [number, number];
}

/** Hallazgo sobre el nombre o título de una ficha. */
export function nameFinding(detector: DetectorDefinition, name: NameValue, input: NameFindingInput): Finding {
  return {
    detector: detector.key,
    category: detector.category,
    signature: input.signature ?? detector.key,
    ...(input.signatureLabel === undefined ? {} : { signatureLabel: input.signatureLabel }),
    severity: input.severity,
    entity: { kind: name.kind, id: name.id, label: name.label },
    field: name.field,
    value: name.value,
    title: input.title,
    ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion }),
    ...(input.suggestedValue === undefined ? {} : { suggestedValue: input.suggestedValue }),
    related: [...name.related, ...(input.related ?? [])],
    evidence: { ...(input.evidence ?? {}), ...(input.span ? { span: input.span } : {}) },
  };
}

export const URL_LIKE = /https?:\/\/|www\.|\b[\w-]{2,}\.(?:com|net|org|info|biz|ve|es|co|blogspot|wordpress|bandcamp)\b/iu;

export function isAllLowercase(value: string): boolean {
  return /\p{Ll}{3,}/u.test(value) && value === value.toLocaleLowerCase("es");
}

/**
 * Persona escrita toda en minúsculas sin una sola palabra que el catálogo use
 * en nombres de persona («baile de las abejas», «version»): es un fragmento de
 * texto cargado como persona, no un nombre al que le faltan mayúsculas. Va a
 * «Persona que no es un nombre», no a «Nombre todo en minúsculas».
 */
export function isLowercaseNonName(lexicon: Lexicon, name: NameValue): boolean {
  return name.kind === "person" && isAllLowercase(name.value) && !URL_LIKE.test(name.value)
    && !keyTokens(name.value).some((token) => lexicon.personNameTokens.has(token));
}

export function firstSpan(value: string, pattern: RegExp): [number, number] | undefined {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const match = new RegExp(pattern.source, flags).exec(value);
  return match ? [match.index, match.index + match[0].length] : undefined;
}

export function codePoint(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

export function quote(value: string): string {
  return `«${value}»`;
}
