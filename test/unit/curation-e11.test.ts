import { describe, expect, it } from "vitest";
import { buildContext, isLocalDetector } from "../../src/curation/analyze.js";
import { E11_DETECTORS } from "../../src/curation/detectors/advanced.js";
import type { CatalogSnapshot } from "../../src/curation/types.js";

function snapshot(): CatalogSnapshot {
  return {
    takenAt: new Date("2026-09-20T12:00:00Z"),
    artists: [
      { id: 1, name: "BANDA TOTAL CARACAS", originCity: null, formedYear: 2010, disbandedYear: null },
      { id: 2, name: "Sello Falso", originCity: null, formedYear: 2000, disbandedYear: null },
    ],
    persons: [
      { id: 20, name: "Ana Música" },
      { id: 50, name: "Persona Antigua" },
      { id: 51, name: "Persona Intermedia" },
      { id: 52, name: "Persona Final" },
    ],
    organizations: [
      { id: 10, name: "Sello Falso", type: "record_label" },
      { id: 11, name: "Estudios Caracas", type: "other" },
      { id: 12, name: "Alias Clash", type: "other" },
    ],
    albums: [
      { id: 100, artistId: 1, title: "DISCO VACIO", releaseYear: 2020, albumType: "studio_album", labelId: 10 },
      { id: 101, artistId: 1, title: "Album Parcial", releaseYear: 2021, albumType: "studio_album", labelId: null },
    ],
    tracks: [
      { id: 1001, albumId: 101, disc: 1, number: 1, title: "Pista Uno", durationSeconds: 180 },
      { id: 1002, albumId: 101, disc: 1, number: 2, title: "Pista Dos", durationSeconds: null },
    ],
    creditRoles: [],
    credits: [
      { id: 1, parentKind: "album", parentId: 101, personId: 20, artistId: null, organizationId: null, creditType: "musician", role: "Guitarra" },
      { id: 2, parentKind: "album", parentId: 101, personId: 20, artistId: null, organizationId: null, creditType: "musician", role: "Guitarra" },
      { id: 3, parentKind: "track", parentId: 1001, personId: 20, artistId: null, organizationId: null, creditType: "mixing", role: "Productor" },
    ],
    memberships: [
      { id: 1, artistId: 1, personId: 20, role: "Guitarra", fromYear: 2025, toYear: 2020, isCurrent: true },
    ],
    aliases: [
      { id: 1, kind: "organization", entityId: 11, alias: "Alias Clash", normalizedAlias: "alias clash" },
    ],
    redirects: [
      { kind: "person", fromId: 50, toId: 51 },
      { kind: "person", fromId: 51, toId: 52 },
    ],
    mediaLinks: [
      { id: 1, entityKind: "person", artistId: null, personId: 50, organizationId: null, albumId: null, url: "https://example.test/persona", mediaType: "website" },
    ],
    personArtists: new Map([[20, new Set([1])]]),
    personLinks: new Map([[20, 1]]),
    organizationLinks: new Map([[10, 1], [11, 1], [12, 1]]),
    artistLinks: new Map([[1, 2], [2, 1]]),
    reviews: [],
    conflicts: [],
    handledPairs: new Set(),
    distinctPairs: new Set(),
  };
}

describe("PLAN_CURADURIA E11", () => {
  it("registra los once detectores nuevos con claves estables", () => {
    expect(E11_DETECTORS.map((detector) => detector.key)).toEqual([
      "creditos_duplicados",
      "rol_contra_tipo_de_credito",
      "periodo_de_membresia_imposible",
      "organizacion_sin_clasificar",
      "sello_que_es_artista",
      "disco_sin_pistas",
      "pistas_sin_duracion_en_disco_con_duraciones",
      "mayusculas_sostenidas",
      "alias_que_choca_con_otra_ficha",
      "redireccion_en_cadena",
      "enlace_de_medio_a_ficha_fusionada",
    ]);
  });

  it("cada detector encuentra su caso de aceptación en una foto sintética", () => {
    const context = buildContext(snapshot());
    const emitted = new Set(E11_DETECTORS.flatMap((detector) => detector.run(context)).map((finding) => finding.detector));
    expect([...emitted].sort()).toEqual(E11_DETECTORS.map((detector) => detector.key).sort());
  });

  it("los cuatro detectores de vecindad participan en la verificación dirigida", () => {
    for (const key of [
      "organizacion_sin_clasificar",
      "disco_sin_pistas",
      "pistas_sin_duracion_en_disco_con_duraciones",
      "mayusculas_sostenidas",
    ]) expect(isLocalDetector(key), key).toBe(true);
    for (const key of [
      "creditos_duplicados", "rol_contra_tipo_de_credito", "periodo_de_membresia_imposible",
      "sello_que_es_artista", "alias_que_choca_con_otra_ficha", "redireccion_en_cadena",
      "enlace_de_medio_a_ficha_fusionada",
    ]) expect(isLocalDetector(key), key).toBe(false);
  });

  it("no infiere por nombres ambiguos ni rompe marcas escritas deliberadamente en mayúsculas", () => {
    const base = snapshot();
    base.organizations.push(
      { id: 90, name: "Grabaciones Silvestres", type: "recording_studio" },
      { id: 91, name: "Record Plant", type: "recording_studio" },
    );
    base.artists.push(
      { id: 90, name: "DIESEL", originCity: null, formedYear: null, disbandedYear: null },
      { id: 91, name: "MARSHALL", originCity: null, formedYear: null, disbandedYear: null },
    );
    const findings = E11_DETECTORS.flatMap((detector) => detector.run(buildContext(base)));
    expect(findings.some((finding) => finding.entity.id === 90 && finding.value === "DIESEL")).toBe(false);
    expect(findings.some((finding) => finding.entity.id === 91 && finding.value === "MARSHALL")).toBe(false);
    expect(findings.some((finding) => finding.entity.id === 90 && finding.entity.kind === "organization")).toBe(false);
    expect(findings.some((finding) => finding.entity.id === 91 && finding.entity.kind === "organization")).toBe(false);
  });

  it("un rol compuesto no contradice el tipo guardado", () => {
    // Medido contra la foto real: sin esta regla, «Recorded & Mixed by»
    // clasificado como `mixing` producía 48 de cada 49 hallazgos falsos.
    const base = snapshot();
    base.credits!.push(
      { id: 10, parentKind: "album", parentId: 101, personId: 20, artistId: null, organizationId: null, creditType: "mixing", role: "Recorded & Mixed by" },
      { id: 11, parentKind: "album", parentId: 101, personId: 20, artistId: null, organizationId: null, creditType: "mastering", role: "Recorded, Mixed & Mastered at" },
      { id: 12, parentKind: "album", parentId: 101, personId: 20, artistId: null, organizationId: null, creditType: "recording", role: "Vocals Recorded by" },
    );
    const roles = E11_DETECTORS.flatMap((detector) => detector.run(buildContext(base)))
      .filter((finding) => finding.detector === "rol_contra_tipo_de_credito");
    expect(roles.map((finding) => (finding.evidence as { role: string }).role)).toEqual(["Productor"]);
  });

  it("el alias no acusa homónimos de otro padre, pares ya tratados ni desambiguaciones entre paréntesis", () => {
    const base = snapshot();
    base.albums.push(
      { id: 200, artistId: 1, title: "Renacer", releaseYear: 2001, albumType: "studio_album", labelId: null },
      { id: 201, artistId: 2, title: "Renacer", releaseYear: 2002, albumType: "studio_album", labelId: null },
    );
    base.artists.push(
      { id: 30, name: "Nemesis", originCity: null, formedYear: null, disbandedYear: null },
      { id: 31, name: "Nemesis (Lara)", originCity: null, formedYear: null, disbandedYear: null },
      { id: 40, name: "Par Tratado A", originCity: null, formedYear: null, disbandedYear: null },
      { id: 41, name: "Par Tratado A", originCity: null, formedYear: null, disbandedYear: null },
    );
    base.aliases!.push(
      // Homónimo de otro artista: normal en el catálogo.
      { id: 2, kind: "album", entityId: 200, alias: "Renacer", normalizedAlias: "renacer" },
      // El paréntesis ES la desambiguación.
      { id: 3, kind: "artist", entityId: 31, alias: "Nemesis", normalizedAlias: "nemesis" },
      // Par ya fusionado o declarado distinto.
      { id: 4, kind: "artist", entityId: 41, alias: "Par Tratado A", normalizedAlias: "par tratado a" },
    );
    base.handledPairs = new Set(["artist:40-41"]);
    const alias = E11_DETECTORS.flatMap((detector) => detector.run(buildContext(base)))
      .filter((finding) => finding.detector === "alias_que_choca_con_otra_ficha");
    expect(alias.map((finding) => finding.value)).toEqual(["Alias Clash"]);
  });
});
