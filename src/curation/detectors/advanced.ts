// CRV · Detectores de cobertura profunda (PLAN_CURADURIA E11).
//
// E11 mezcla detectores LOCALES y GLOBALES. Los cuatro que dependen solo de la
// ficha y su vecindad (tipo/nombre de organización, disco/pistas y mayúsculas)
// participan en la verificación dirigida de E9. Los siete relacionales siguen
// siendo globales porque necesitan créditos, membresías, aliases, redirecciones
// o enlaces de medios del catálogo entero.
import { capitalizeSpanish } from "./text-hygiene.js";
import { nameKey } from "../lexicon.js";
import type {
  EntityRef, Finding, SnapshotCredit, SnapshotMediaLink, SnapshotRedirect,
} from "../types.js";
import { quote, type AnalysisContext, type Detector } from "./shared.js";

const COHERENCE = "datos_incoherentes";
const DUPLICATES = "fichas_repetidas";
const DIRTY = "nombres_sucios";
const ORPHANS = "fichas_sin_vinculos";

function entity(context: AnalysisContext, kind: "artist" | "person" | "organization" | "album" | "track", id: number): EntityRef {
  const label =
    kind === "artist" ? context.artists.get(id)?.name
      : kind === "person" ? context.persons.get(id)?.name
        : kind === "organization" ? context.organizations.get(id)?.name
          : kind === "album" ? context.albums.get(id)?.title
            : context.tracks.get(id)?.title;
  return { kind, id, label: label ?? `#${id}` };
}

function creditTarget(credit: SnapshotCredit): { kind: "person" | "artist" | "organization"; id: number } | null {
  if (credit.personId !== null) return { kind: "person", id: credit.personId };
  if (credit.artistId !== null) return { kind: "artist", id: credit.artistId };
  if (credit.organizationId !== null) return { kind: "organization", id: credit.organizationId };
  return null;
}

function parentRef(context: AnalysisContext, credit: SnapshotCredit): EntityRef {
  return credit.parentKind === "album" ? entity(context, "album", credit.parentId) : entity(context, "track", credit.parentId);
}

const roleKey = (role: string): string => nameKey(role).replace(/\s+/gu, " ").trim();

export const duplicateCredits: Detector = {
  key: "creditos_duplicados",
  category: COHERENCE,
  label: "Créditos duplicados",
  description: "Dos o más filas repiten exactamente el mismo crédito, destino, tipo y rol sobre el mismo disco o pista.",
  run(context) {
    const groups = new Map<string, SnapshotCredit[]>();
    for (const credit of context.snapshot.credits ?? []) {
      const target = creditTarget(credit);
      if (!target) continue;
      const key = [credit.parentKind, credit.parentId, target.kind, target.id, credit.creditType, roleKey(credit.role)].join(":");
      const list = groups.get(key);
      if (list) list.push(credit); else groups.set(key, [credit]);
    }
    const out: Finding[] = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const first = rows[0]!;
      const target = creditTarget(first)!;
      out.push({
        detector: this.key, category: this.category, signature: first.parentKind,
        signatureLabel: first.parentKind === "album" ? "Crédito de disco repetido" : "Crédito de pista repetido",
        severity: "medium", entity: parentRef(context, first), field: "credits", value: first.role,
        title: `${rows.length} créditos idénticos: ${quote(first.role)} (${first.creditType})`,
        suggestion: "Conservar una sola fila después de confirmar que no son créditos distintos con el mismo texto",
        related: [entity(context, target.kind, target.id)],
        evidence: { creditIds: rows.map((row) => row.id), creditType: first.creditType, role: first.role, target },
      });
    }
    return out;
  },
};

const ROLE_EXPECTATIONS: Array<{ pattern: RegExp; types: readonly string[]; label: string }> = [
  { pattern: /\b(?:productor(?:a)?|producer|produccion|producción)\b/iu, types: ["producer"], label: "producción" },
  { pattern: /\b(?:mezcla|mix|mixing)\b/iu, types: ["mixing"], label: "mezcla" },
  { pattern: /\b(?:master(?:ing|izacion|ización)?)\b/iu, types: ["mastering"], label: "mastering" },
  { pattern: /\b(?:fotografia|fotografía|photo|photography)\b/iu, types: ["photography"], label: "fotografía" },
  { pattern: /\b(?:arte|artwork|diseno|diseño|portada)\b/iu, types: ["artwork"], label: "arte" },
  { pattern: /\b(?:compositor(?:a)?|composer|composicion|composición)\b/iu, types: ["composer"], label: "composición" },
  { pattern: /\b(?:autor(?:a)?|letra|lyrics?|writer)\b/iu, types: ["writer"], label: "autoría" },
  { pattern: /\b(?:grabacion|grabación|recording|ingenier[oa])\b/iu, types: ["recording"], label: "grabación" },
  { pattern: /\b(?:guitarr|baj|bateri|teclad|piano|voz|vocal|sax|trompet|percusi|musico|músico)\w*/iu, types: ["musician", "guest"], label: "interpretación" },
];

export const roleVsCreditType: Detector = {
  key: "rol_contra_tipo_de_credito",
  category: COHERENCE,
  label: "Rol contra tipo de crédito",
  description: "El texto del rol declara con claridad una clase de trabajo distinta del credit_type almacenado.",
  run(context) {
    const out: Finding[] = [];
    for (const credit of context.snapshot.credits ?? []) {
      // Un rol compuesto ("Guitarra / Mezcla") puede pertenecer a varias
      // familias legítimas. Solo señalamos cuando el texto apunta a UNA clase
      // inequívoca y el tipo guardado no pertenece a ella.
      const matches = ROLE_EXPECTATIONS.filter((item) => item.pattern.test(credit.role));
      if (matches.length !== 1) continue;
      const expected = matches[0]!;
      if (expected.types.includes(credit.creditType)) continue;
      const target = creditTarget(credit);
      out.push({
        detector: this.key, category: this.category, signature: expected.types.join("_o_"),
        signatureLabel: `Rol de ${expected.label}`, severity: "medium",
        entity: parentRef(context, credit), field: "credit_type", value: credit.creditType,
        title: `El rol ${quote(credit.role)} parece de ${expected.label}, pero está clasificado como ${credit.creditType}`,
        suggestion: `Revisar el tipo de crédito; esperado: ${expected.types.join(" o ")}`,
        related: target ? [entity(context, target.kind, target.id)] : [],
        evidence: { creditId: credit.id, role: credit.role, storedType: credit.creditType, expectedTypes: expected.types },
      });
    }
    return out;
  },
};

export const impossibleMembershipPeriod: Detector = {
  key: "periodo_de_membresia_imposible",
  category: COHERENCE,
  label: "Período de membresía imposible",
  description: "Una membresía termina antes de empezar, está marcada como actual con fecha de fin, cae en el futuro o precede la formación del artista.",
  run(context) {
    const out: Finding[] = [];
    for (const membership of context.snapshot.memberships ?? []) {
      const artist = context.artists.get(membership.artistId);
      const person = context.persons.get(membership.personId);
      const reasons: string[] = [];
      if (membership.fromYear !== null && membership.toYear !== null && membership.fromYear > membership.toYear) reasons.push("empieza después de terminar");
      if (membership.isCurrent && membership.toYear !== null) reasons.push("está marcada como actual pero tiene año de fin");
      if ((membership.fromYear ?? 0) > context.currentYear + 1 || (membership.toYear ?? 0) > context.currentYear + 1) reasons.push("usa un año futuro");
      if (artist?.formedYear && membership.fromYear !== null && membership.fromYear < artist.formedYear) reasons.push(`empieza antes de la formación del artista (${artist.formedYear})`);
      if (!reasons.length) continue;
      out.push({
        detector: this.key, category: this.category, signature: reasons[0]!.replace(/\W+/gu, "_"),
        severity: "medium", entity: person ? { kind: "person", id: person.id, label: person.name } : entity(context, "person", membership.personId),
        field: "membership_period", value: `${membership.fromYear ?? "?"}–${membership.toYear ?? (membership.isCurrent ? "actual" : "?")}`,
        title: `Período incoherente en ${artist?.name ?? `artista #${membership.artistId}`}: ${reasons.join("; ")}`,
        suggestion: "Corregir las fechas o el indicador de membresía actual usando evidencia de la fuente",
        related: [entity(context, "artist", membership.artistId)],
        evidence: { membershipId: membership.id, role: membership.role, fromYear: membership.fromYear, toYear: membership.toYear, isCurrent: membership.isCurrent, reasons },
      });
    }
    return out;
  },
};

const ORG_TYPE_EQUIVALENTS: Readonly<Record<string, string>> = {
  studio: "recording_studio",
  label: "record_label",
  production: "production_company",
  producer: "production_company",
  distribution: "distributor",
};

const ORG_MARKERS: Array<{ type: string; pattern: RegExp; label: string }> = [
  { type: "recording_studio", pattern: /\b(?:estudio|estudios|studio|studios)\b/iu, label: "estudio de grabación" },
  { type: "production_company", pattern: /\b(?:productora|producciones|production|productions)\b/iu, label: "productora" },
  { type: "distributor", pattern: /\b(?:distribuidora|distribucion|distribución|distribution)\b/iu, label: "distribuidora" },
  { type: "management", pattern: /\b(?:management|representacion|representación)\b/iu, label: "management" },
  // "record" singular ("Record Plant") y "grabaciones" son ambiguos: también
  // aparecen en estudios. Solo marcadores inequívocos de sello.
  { type: "record_label", pattern: /\b(?:records|discos?|label)\b/iu, label: "sello discográfico" },
];

export const organizationTypeVsName: Detector = {
  key: "tipo_de_organizacion_contra_nombre",
  category: COHERENCE,
  label: "Tipo de organización contra nombre",
  description: "El nombre contiene un marcador fuerte de estudio, productora, distribuidora, management o sello que contradice el tipo guardado.",
  run(context) {
    return context.snapshot.organizations.flatMap((org) => {
      // Nombres con dos marcadores ("Records Studio") son ambiguos: no
      // inferimos un único tipo a partir del texto.
      const markers = ORG_MARKERS.filter((item) => item.pattern.test(org.name));
      // Un nombre no basta para contradecir una clasificación ya curada:
      // "X Records" puede ser también el nombre legal de un estudio. Este
      // detector solo completa "other" cuando hay UN marcador inequívoco.
      if (markers.length !== 1 || org.type !== "other") return [];
      const marker = markers[0]!;
      return [{
        detector: this.key, category: this.category,
        signature: "sin_clasificar",
        signatureLabel: "Organización sin clasificar",
        severity: "low",
        entity: { kind: "organization" as const, id: org.id, label: org.name }, field: "organization_type", value: org.type,
        title: `${quote(org.name)} parece ${marker.label}, pero está sin clasificar`,
        suggestion: `Revisar el tipo de organización; el nombre sugiere ${marker.type}`,
        related: [], evidence: { storedType: org.type, suggestedType: marker.type, marker: marker.label },
      }];
    });
  },
};

export const labelIsArtist: Detector = {
  key: "sello_que_es_artista",
  category: DUPLICATES,
  label: "Sello que coincide con un artista",
  description: "Una organización usada como sello tiene el mismo nombre normalizado que una ficha de artista.",
  run(context) {
    const artistByName = new Map<string, number[]>();
    for (const artist of context.snapshot.artists) {
      const key = nameKey(artist.name);
      artistByName.set(key, [...(artistByName.get(key) ?? []), artist.id]);
    }
    const albumsByLabel = new Map<number, number[]>();
    for (const album of context.snapshot.albums) {
      if (album.labelId === null || album.labelId === undefined) continue;
      albumsByLabel.set(album.labelId, [...(albumsByLabel.get(album.labelId) ?? []), album.id]);
    }
    const out: Finding[] = [];
    for (const [labelId, albumIds] of albumsByLabel) {
      const org = context.organizations.get(labelId);
      if (!org) continue;
      const artists = artistByName.get(nameKey(org.name)) ?? [];
      for (const artistId of artists) {
        out.push({
          detector: this.key, category: this.category, signature: "nombre_identico", signatureLabel: "Nombre idéntico",
          severity: "medium", entity: { kind: "organization", id: org.id, label: org.name }, field: "name", value: org.name,
          title: `El sello ${quote(org.name)} coincide exactamente con una ficha de artista`,
          suggestion: "Confirmar si el sello es realmente una organización separada o una clasificación equivocada",
          related: [entity(context, "artist", artistId), ...albumIds.slice(0, 5).map((id) => entity(context, "album", id))],
          evidence: { artistId, albumIds },
        });
      }
    }
    return out;
  },
};

export const albumWithoutTracks: Detector = {
  key: "disco_sin_pistas",
  category: ORPHANS,
  actionability: "informational",
  label: "Disco sin pistas",
  description: "Un disco canónico no tiene ninguna pista asociada.",
  run(context) {
    return context.snapshot.albums.flatMap((album) => context.tracksByAlbum.has(album.id) ? [] : [{
      detector: this.key, category: this.category, signature: this.key, severity: "low",
      entity: { kind: "album" as const, id: album.id, label: album.title }, field: "tracks", value: album.title,
      title: "El disco no tiene ninguna pista",
      suggestion: "Completar el tracklist o confirmar que la ficha debe permanecer sin pistas",
      related: [entity(context, "artist", album.artistId)], evidence: { artistId: album.artistId },
    }]);
  },
};

export const missingDurationsInTimedAlbum: Detector = {
  key: "pistas_sin_duracion_en_disco_con_duraciones",
  category: COHERENCE,
  label: "Duraciones incompletas dentro del disco",
  description: "Un mismo disco mezcla pistas con duración conocida y pistas sin duración.",
  run(context) {
    const out: Finding[] = [];
    for (const [albumId, tracks] of context.tracksByAlbum) {
      const withDuration = tracks.filter((track) => track.durationSeconds !== null);
      const missing = tracks.filter((track) => track.durationSeconds === null);
      if (!withDuration.length || !missing.length) continue;
      const album = context.albums.get(albumId);
      if (!album) continue;
      out.push({
        detector: this.key, category: this.category, signature: "mezcla_con_y_sin_duracion",
        severity: "low", entity: { kind: "album", id: album.id, label: album.title }, field: "duration_seconds", value: album.title,
        title: `${missing.length} de ${tracks.length} pistas no tienen duración aunque otras del mismo disco sí`,
        suggestion: "Completar las duraciones faltantes desde la misma fuente cuando estén disponibles",
        related: missing.slice(0, 12).map((track) => entity(context, "track", track.id)),
        evidence: { missingTrackIds: missing.map((track) => track.id), timedTrackIds: withDuration.map((track) => track.id) },
      });
    }
    return out;
  },
};

function sustainedUpper(value: string): boolean {
  const letters = [...value].filter((char) => /\p{L}/u.test(char));
  if (letters.length < 6) return false;
  const cased = letters.filter((char) => char.toLocaleLowerCase("es") !== char.toLocaleUpperCase("es"));
  if (cased.length < 6 || value !== value.toLocaleUpperCase("es")) return false;

  // Una palabra en mayúsculas puede ser una identidad de marca/banda ("DIESEL",
  // "MARSHALL") y las formas con puntos o barras suelen ser siglas. Solo
  // proponemos normalizar frases claras; ante ambigüedad, el detector calla.
  if (/[./\\-]/u.test(value)) return false;
  const words = value.match(/\p{L}+/gu) ?? [];
  return words.length >= 3 && words.filter((word) => [...word].length >= 4).length >= 2;
}

export const sustainedUppercase: Detector = {
  key: "mayusculas_sostenidas",
  category: DIRTY,
  label: "Mayúsculas sostenidas",
  description: "Nombres y títulos largos escritos enteramente en mayúsculas; se excluyen siglas cortas.",
  actions: { "*": ["capitalizar"] },
  run(context) {
    return context.names.flatMap((name) => {
      if (!sustainedUpper(name.value)) return [];
      const suggested = capitalizeSpanish(name.value);
      if (!suggested || suggested === name.value) return [];
      return [{
        detector: this.key, category: this.category, signature: this.key, severity: "low",
        entity: { kind: name.kind, id: name.id, label: name.label }, field: name.field, value: name.value,
        title: `Mayúsculas sostenidas: ${quote(name.value)}`,
        suggestion: `Normalizar la capitalización a ${quote(suggested)}`, suggestedValue: suggested,
        related: name.related, evidence: { suggested },
      }];
    });
  },
};

function canonicalByKind(context: AnalysisContext): Map<string, Map<string, number[]>> {
  const result = new Map<string, Map<string, number[]>>();
  const add = (kind: string, id: number, value: string) => {
    const byName = result.get(kind) ?? new Map<string, number[]>();
    const key = nameKey(value);
    byName.set(key, [...(byName.get(key) ?? []), id]);
    result.set(kind, byName);
  };
  for (const row of context.snapshot.artists) add("artist", row.id, row.name);
  for (const row of context.snapshot.persons) add("person", row.id, row.name);
  for (const row of context.snapshot.organizations) add("organization", row.id, row.name);
  for (const row of context.snapshot.albums) add("album", row.id, row.title);
  for (const row of context.snapshot.tracks) add("track", row.id, row.title);
  return result;
}

export const aliasCollidesWithEntity: Detector = {
  key: "alias_que_choca_con_otra_ficha",
  category: DUPLICATES,
  label: "Alias que choca con otra ficha",
  description: "Un alias normaliza al nombre canónico de otra ficha del mismo tipo.",
  run(context) {
    const canon = canonicalByKind(context);
    const out: Finding[] = [];
    for (const alias of context.snapshot.aliases ?? []) {
      const hits = (canon.get(alias.kind)?.get(nameKey(alias.alias)) ?? []).filter((id) => id !== alias.entityId);
      if (!hits.length) continue;
      out.push({
        detector: this.key, category: this.category, signature: alias.kind, signatureLabel: `Alias de ${alias.kind}`,
        severity: "medium", entity: entity(context, alias.kind, alias.entityId), field: "alias", value: alias.alias,
        title: `El alias ${quote(alias.alias)} coincide con otra ficha`,
        suggestion: "Confirmar si las fichas son distintas; si son la misma, fusionarlas",
        related: hits.slice(0, 8).map((id) => entity(context, alias.kind, id)),
        evidence: { aliasId: alias.id, normalizedAlias: alias.normalizedAlias, collidingIds: hits },
      });
    }
    return out;
  },
};

function redirectMap(rows: readonly SnapshotRedirect[]): Map<string, SnapshotRedirect> {
  return new Map(rows.map((row) => [`${row.kind}:${row.fromId}`, row]));
}

export const redirectChain: Detector = {
  key: "redireccion_en_cadena",
  category: COHERENCE,
  label: "Redirección en cadena",
  description: "Una redirección apunta a un id que también redirige; las fusiones deberían dejar la cadena comprimida al destino final.",
  run(context) {
    const rows = context.snapshot.redirects ?? [];
    const byFrom = redirectMap(rows);
    return rows.flatMap((row) => {
      const next = byFrom.get(`${row.kind}:${row.toId}`);
      if (!next) return [];
      return [{
        detector: this.key, category: this.category, signature: row.kind, signatureLabel: `Cadena de ${row.kind}`,
        severity: "medium", entity: entity(context, row.kind, next.toId), field: "redirect",
        value: `${row.fromId}->${row.toId}->${next.toId}`,
        title: `La redirección ${row.fromId} → ${row.toId} no está comprimida; ${row.toId} → ${next.toId}`,
        suggestion: `Reapuntar ${row.fromId} directamente a ${next.toId}`,
        related: [], evidence: { fromId: row.fromId, viaId: row.toId, finalId: next.toId },
      }];
    });
  },
};

function linkedId(link: SnapshotMediaLink): { kind: SnapshotRedirect["kind"]; id: number } | null {
  if (link.artistId !== null) return { kind: "artist", id: link.artistId };
  if (link.personId !== null) return { kind: "person", id: link.personId };
  if (link.organizationId !== null) return { kind: "organization", id: link.organizationId };
  if (link.albumId !== null) return { kind: "album", id: link.albumId };
  return null;
}

export const mediaLinkToMergedEntity: Detector = {
  key: "enlace_de_medio_a_ficha_fusionada",
  category: COHERENCE,
  label: "Enlace de medio a ficha fusionada",
  description: "Un media_link conserva un id antiguo que ya fue redirigido por una fusión.",
  run(context) {
    const redirects = redirectMap(context.snapshot.redirects ?? []);
    const out: Finding[] = [];
    for (const link of context.snapshot.mediaLinks ?? []) {
      const target = linkedId(link);
      if (!target) continue;
      const redirected = redirects.get(`${target.kind}:${target.id}`);
      if (!redirected) continue;
      out.push({
        detector: this.key, category: this.category, signature: target.kind,
        signatureLabel: `Enlace a ${target.kind} fusionado`, severity: "high",
        entity: entity(context, target.kind, redirected.toId), field: `media_link:${link.id}`, value: link.url,
        title: `El enlace de medio #${link.id} todavía apunta al id fusionado ${target.id}`,
        suggestion: `Reapuntar el enlace al id vivo ${redirected.toId}`,
        related: [], evidence: { mediaLinkId: link.id, mediaType: link.mediaType, fromId: target.id, toId: redirected.toId, url: link.url },
      });
    }
    return out;
  },
};

/** Detectores E11 verificables con la vecindad que ya carga E9. */
export const E11_LOCAL_DETECTORS: readonly Detector[] = [
  organizationTypeVsName,
  albumWithoutTracks,
  missingDurationsInTimedAlbum,
  sustainedUppercase,
];

/** Detectores E11 que necesitan relaciones del catálogo entero. */
export const E11_GLOBAL_DETECTORS: readonly Detector[] = [
  duplicateCredits,
  roleVsCreditType,
  impossibleMembershipPeriod,
  labelIsArtist,
  aliasCollidesWithEntity,
  redirectChain,
  mediaLinkToMergedEntity,
];

export const E11_DETECTORS: readonly Detector[] = [
  duplicateCredits,
  roleVsCreditType,
  impossibleMembershipPeriod,
  organizationTypeVsName,
  labelIsArtist,
  albumWithoutTracks,
  missingDurationsInTimedAlbum,
  sustainedUppercase,
  aliasCollidesWithEntity,
  redirectChain,
  mediaLinkToMergedEntity,
];
