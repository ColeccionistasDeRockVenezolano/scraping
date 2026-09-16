// CRV · Lo que la ingesta ya dejó pendiente: cola de revisión y conflictos.
//
// La pestaña «Cola de revisión» se retiró de Curaduría: sus casos vivos entran
// aquí como hallazgos, cada uno en la categoría de su tipo. Un tipo que el
// enum `ingest.review_kind` gane mañana y la taxonomía no conozca aparece en
// «Otros» con su nombre, en vez de desaparecer.
import { OTHER_CATEGORY, REVIEW_KIND_CATEGORY, REVIEW_KINDS_WITH_OWN_TAB } from "../taxonomy.js";
import type { EntityRef, Finding, Severity, SnapshotReview } from "../types.js";
import { quote, type AnalysisContext, type Detector } from "./shared.js";

export const REVIEW_KIND_LABEL: Readonly<Record<string, string>> = {
  field_conflict: "Conflicto de campo",
  possible_duplicate: "Posible duplicado",
  ambiguous_alias: "Alias ambiguo",
  album_match: "Coincidencia de disco",
  person_match: "Coincidencia de persona",
  organization_match: "Coincidencia de organización",
  youtube_match: "Coincidencia de YouTube",
  manual_review: "Revisión manual",
  missing_url: "URL faltante",
  seed_incomplete: "Semilla incompleta",
  media_type_no_album: "Medio sin disco",
  genre_unknown: "Género desconocido",
  new_source: "Fuente nueva",
  low_confidence: "Baja confianza",
  ai_biography: "Biografía generada",
  ai_entity_resolution: "Resolución con IA",
};

function severityFor(priority: number): Severity {
  return priority >= 8 ? "high" : priority >= 5 ? "medium" : "low";
}

function refsOf(context: AnalysisContext, review: SnapshotReview): EntityRef[] {
  const out: EntityRef[] = [];
  const add = (kind: EntityRef["kind"], id: number | undefined, label: string | undefined) => {
    if (id !== undefined) out.push({ kind, id, label: label ?? `#${id}` });
  };
  add("artist", review.refs.artistA, context.artists.get(review.refs.artistA ?? -1)?.name);
  add("artist", review.refs.artistB, context.artists.get(review.refs.artistB ?? -1)?.name);
  add("person", review.refs.personA, context.persons.get(review.refs.personA ?? -1)?.name);
  add("person", review.refs.personB, context.persons.get(review.refs.personB ?? -1)?.name);
  add("organization", review.refs.organizationA, context.organizations.get(review.refs.organizationA ?? -1)?.name);
  add("organization", review.refs.organizationB, context.organizations.get(review.refs.organizationB ?? -1)?.name);
  add("album", review.refs.album, context.albums.get(review.refs.album ?? -1)?.title);
  if (review.refs.track !== undefined) {
    const track = context.tracks.get(review.refs.track);
    add("track", review.refs.track, track?.title);
    if (track) add("album", track.albumId, context.albums.get(track.albumId)?.title);
  }
  return out;
}

/** Un payload grande no entra entero en la evidencia: se recorta con aviso. */
function compactPayload(payload: unknown): unknown {
  const text = JSON.stringify(payload ?? null);
  return text.length <= 4000 ? payload : { truncated: true, preview: text.slice(0, 4000) };
}

export const reviewQueueItems: Detector = {
  key: "cola_de_revision",
  category: "revision_de_ingesta",
  label: "Casos de la cola de revisión",
  description: "Revisiones vivas de la cola (open/in_progress), cada una en la categoría de su tipo; un tipo desconocido va a «Otros».",
  run(context) {
    return context.snapshot.reviews.filter((review) => !REVIEW_KINDS_WITH_OWN_TAB.has(review.kind)).map((review): Finding => {
      const category = REVIEW_KIND_CATEGORY[review.kind] ?? OTHER_CATEGORY;
      const kindLabel = REVIEW_KIND_LABEL[review.kind] ?? `Tipo de revisión nuevo: ${review.kind}`;
      return {
        detector: this.key, category,
        signature: `review:${review.kind}`, signatureLabel: kindLabel,
        severity: severityFor(review.priority),
        entity: { kind: "review", id: review.id, label: `${kindLabel} #${review.id}` },
        field: review.kind,
        title: review.notes?.trim() || kindLabel,
        suggestion: "Abrir la revisión y decidir",
        related: refsOf(context, review),
        evidence: { reviewId: review.id, kind: review.kind, status: review.status, priority: review.priority, createdAt: review.createdAt, payload: compactPayload(review.payload) },
      };
    });
  },
};

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export const openConflicts: Detector = {
  key: "conflictos_abiertos",
  category: "valores_en_disputa",
  label: "Conflictos de campo sin revisión viva",
  description: "Conflictos abiertos entre dos claims que no tienen una revisión viva que los lleve a una persona.",
  run(context) {
    const labelOf = (kind: string, id: number | null): string => {
      if (id === null) return "";
      if (kind === "artist") return context.artists.get(id)?.name ?? "";
      if (kind === "person") return context.persons.get(id)?.name ?? "";
      if (kind === "organization") return context.organizations.get(id)?.name ?? "";
      if (kind === "album") return context.albums.get(id)?.title ?? "";
      return "";
    };
    return context.snapshot.conflicts.filter((conflict) => !conflict.hasLiveReview).map((conflict): Finding => {
      const target = ["artist", "person", "organization", "album", "track"].includes(conflict.entityKind) && conflict.targetId !== null
        ? [{ kind: conflict.entityKind as EntityRef["kind"], id: conflict.targetId, label: labelOf(conflict.entityKind, conflict.targetId) || `#${conflict.targetId}` }]
        : [];
      return {
        detector: this.key, category: this.category, signature: `campo:${conflict.field}`, signatureLabel: `Campo ${conflict.field}`,
        severity: "high",
        entity: { kind: "conflict", id: conflict.id, label: `Conflicto #${conflict.id}` },
        field: conflict.field,
        title: `Dos valores para ${quote(conflict.field)}: ${quote(display(conflict.valueA))} y ${quote(display(conflict.valueB))}`,
        suggestion: "Elegir el valor correcto con la evidencia de cada fuente",
        related: target,
        evidence: { conflictId: conflict.id, entityKind: conflict.entityKind, valueA: conflict.valueA, valueB: conflict.valueB },
      };
    });
  },
};

export const QUEUE_DETECTORS: Detector[] = [reviewQueueItems, openConflicts];
