import { describe, expect, it } from "vitest";
import { buildLayaPilotCase } from "../../src/genres/laya-pilot.js";
import { buildTaxonomy } from "../../src/genres/taxonomy.js";
import type { TagPolicy } from "../../src/genres/external/mapping.js";

const taxonomy = buildTaxonomy([
  { id: 1, slug: "rock", name: "Rock", level: "family", parentId: null, active: true, replacedById: null },
  { id: 2, slug: "pop-rock", name: "Pop rock", level: "genre", parentId: 1, active: true, replacedById: null },
  { id: 3, slug: "fusion-latina", name: "Fusión latina", level: "family", parentId: null, active: true, replacedById: null },
], [
  ["rock", { kind: "genre", genreId: 1 }], ["pop rock", { kind: "genre", genreId: 2 }],
  ["latin", { kind: "genre", genreId: 3 }], ["independent", { kind: "not_a_genre" }],
]);

const discogsPolicy: TagPolicy = {
  acceptKinds: ["editorial_genre"], minTagCount: 1, maxValues: 3,
  ignore: ["latin"], buckets: { rock: ["rock", "metal", "punk"] },
};

describe("piloto Laya de géneros", () => {
  it("un álbum solo usa claims de álbum y conserva la referencia de evidencia", () => {
    const result = buildLayaPilotCase({
      kind: "album", entityId: 42, title: "Disco", categories: ["compound"], taxonomy,
      sources: [
        { claimId: 7, level: "album", status: "accepted", rawValue: "Pop-Rock", sourceSlug: "sincopa", evidence: [] },
        { claimId: 8, level: "artist", status: "accepted", rawValue: "Rock", sourceSlug: "sincopa", evidence: [] },
      ],
      assignments: [],
      biographies: [{ claimId: 9, sourceSlug: "blog", text: "Fusión latina", url: null }],
    });
    expect(result?.candidates.map((candidate) => candidate.slug)).toEqual(["pop-rock", "rock"]);
    expect(result?.evidence.map((evidence) => evidence.ref)).toEqual(["claim:7"]);
  });

  it("un snapshot cotejado conserva su referencia propia sin fingir un claim", () => {
    const result = buildLayaPilotCase({
      kind: "album", entityId: 42, title: "Disco", categories: ["snapshot_evidence"], taxonomy,
      sources: [{ claimId: 0, ref: "snapshot:sincopa:abc:42", level: "album", status: "accepted",
        rawValue: "Pop-Rock", sourceSlug: "sincopa", evidence: [{ url: "https://sincopa.com/disco.htm" }] }],
      assignments: [],
    });
    expect(result?.evidence).toEqual([{ ref: "snapshot:sincopa:abc:42", kind: "genre_source_snapshot",
      source: "sincopa", text: "Pop-Rock", url: "https://sincopa.com/disco.htm" }]);
    expect(result?.candidates[0]?.evidenceRefs).toEqual(["snapshot:sincopa:abc:42"]);
  });

  it("no inventa género cuando no hay evidencia útil", () => {
    const result = buildLayaPilotCase({
      kind: "album", entityId: 3, title: "Sin género", categories: ["unclassified"], taxonomy,
      sources: [{ claimId: 1, level: "album", status: "accepted", rawValue: "Independent", sourceSlug: "sincopa", evidence: [] }],
      assignments: [],
    });
    expect(result).toBeNull();
  });

  it("no asigna un género de artista al contenedor de compilados", () => {
    const result = buildLayaPilotCase({
      kind: "artist", entityId: 9, title: "Various Artists", categories: ["unclassified"], taxonomy,
      sources: [], assignments: [],
      biographies: [{ claimId: 5, sourceSlug: "blog", text: "Una recopilación de rock", url: null }],
    });
    expect(result).toBeNull();
  });

  it("excluye etiquetas que la política vigente de la fuente ignora o usa como cajón", () => {
    const result = buildLayaPilotCase({
      kind: "album", entityId: 4, title: "Disco", categories: ["external_suggestion"], taxonomy,
      sources: [],
      assignments: [
        { id: 11, role: "secondary", status: "suggested", sourceKind: "external", rawValue: "Latin",
          genre: { slug: "fusion-latina", active: true }, evidence: [{ sourceSlug: "discogs", externalId: "master:1", tagKind: "editorial_genre" }] },
        { id: 12, role: "secondary", status: "suggested", sourceKind: "external", rawValue: "Rock",
          genre: { slug: "rock", active: true }, evidence: [{ sourceSlug: "discogs", externalId: "master:1", tagKind: "editorial_genre" }] },
        { id: 13, role: "secondary", status: "suggested", sourceKind: "external", rawValue: "Pop Rock",
          genre: { slug: "pop-rock", active: true }, evidence: [{ sourceSlug: "discogs", externalId: "master:1", tagKind: "editorial_genre" }] },
      ],
      externalIdentities: [{ sourceSlug: "discogs", externalId: "master:1", status: "matched" }],
      externalPolicies: new Map([["discogs", discogsPolicy]]),
    });
    expect(result?.candidates.map((candidate) => candidate.slug)).toEqual(["pop-rock"]);
    expect(result?.evidence.map((evidence) => evidence.ref)).toEqual(["assignment:13"]);
  });

  it("respeta el principal confirmado pero permite secundarios confirmados pendientes de principal", () => {
    const common = {
      kind: "album" as const, entityId: 5, title: "Disco", categories: ["disagreement"], taxonomy,
      sources: [{ claimId: 6, level: "album" as const, status: "conflict", rawValue: "Rock", sourceSlug: "sincopa", evidence: [] }],
    };
    const assignment = { id: 20, status: "confirmed", sourceKind: "catalog_source", rawValue: "Rock",
      genre: { slug: "rock", active: true }, evidence: [] };
    expect(buildLayaPilotCase({ ...common, assignments: [{ ...assignment, role: "primary" }] })).toBeNull();
    expect(buildLayaPilotCase({ ...common, assignments: [{ ...assignment, role: "secondary" }] })?.candidates[0]?.slug).toBe("rock");
  });

  it("ignora una sugerencia externa cuya identidad dejó de estar confirmada", () => {
    const result = buildLayaPilotCase({
      kind: "album", entityId: 10, title: "Disco", categories: ["external_suggestion"], taxonomy,
      sources: [], biographies: [],
      assignments: [{ id: 30, role: "secondary", status: "suggested", sourceKind: "external", rawValue: "Pop Rock",
        genre: { slug: "pop-rock", active: true }, evidence: [{ sourceSlug: "discogs", externalId: "master:7", tagKind: "editorial_genre" }] }],
      externalIdentities: [{ sourceSlug: "discogs", externalId: "master:7", status: "ambiguous" }],
      externalPolicies: new Map([["discogs", discogsPolicy]]),
    });
    expect(result).toBeNull();
  });
});
