// CRV · Pruebas unitarias de acciones estructurales de Curaduría (PLAN_CURADURIA E6).
import { describe, expect, it } from "vitest";
import {
  convertirCreandoOrganizacionAction,
  convertirEnArtistaAction,
  convertirEnOrganizacionExistenteAction,
  corregirUnidadesAction,
  dividirPersonaAction,
  extraerAutoresAction,
  extraerInterpreteAction,
  extraerInterpreteCreandoAction,
  extraerInvitadoAction,
  fijarTipoDeDiscoAction,
  fusionarDiscosAction,
  moverDuracionAction,
  retirarConCreditosAction,
  retirarHuerfanaAction,
  retirarPistaDuplicadaAction,
  STRUCTURAL_ACTIONS,
  vaciarAnioAction,
  vaciarDuracionAction,
  vincularComoMiembroAction,
} from "../../src/curation/actions/structural.js";
import type { ActionFinding } from "../../src/curation/actions/types.js";

function mockFinding(overrides: Partial<ActionFinding> = {}): ActionFinding {
  return {
    id: 1,
    detector: "tipo_de_disco_contra_titulo",
    signature: "sin_clasificar",
    status: "open",
    entity: { kind: "album", id: 42, label: "Disco Prueba" },
    field: "title",
    value: "Disco Prueba Demo",
    suggestedValue: null,
    related: [],
    evidence: {},
    title: "Hallazgo de prueba",
    ...overrides,
  };
}

describe("acciones estructurales (E6) — registro y esquemas", () => {
  it("las 20 acciones estructurales están definidas en STRUCTURAL_ACTIONS con claves únicas", () => {
    expect(STRUCTURAL_ACTIONS.length).toBe(20);
    const keys = STRUCTURAL_ACTIONS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fijar_tipo_de_disco: aplica a tipo_de_disco_contra_titulo y valida parámetros", async () => {
    const f = mockFinding({
      detector: "tipo_de_disco_contra_titulo",
      signature: "sin_clasificar",
      evidence: { declaredTypes: ["demo"], wordSource: "semilla" },
    });
    expect(fijarTipoDeDiscoAction.appliesTo(f)).toBe(true);
    expect(fijarTipoDeDiscoAction.levelFor(f, null)).toBe(0);
    const params = await fijarTipoDeDiscoAction.defaultParams(f, {} as never);
    expect(params).toEqual({ albumId: 42, albumType: "demo" });
    expect(fijarTipoDeDiscoAction.paramsSchema.parse(params)).toEqual(params);
  });

  it("vaciar_anio: aplica a anios_imposibles y valida parámetros", async () => {
    const f = mockFinding({
      detector: "anios_imposibles",
      signature: "release_year",
      evidence: { field: "release_year", year: 2099 },
    });
    expect(vaciarAnioAction.appliesTo(f)).toBe(true);
    expect(vaciarAnioAction.levelFor(f, null)).toBe(0);
    const params = await vaciarAnioAction.defaultParams(f, {} as never);
    expect(params).toEqual({ kind: "album", id: 42, field: "release_year" });
    expect(vaciarAnioAction.paramsSchema.parse(params)).toEqual(params);
  });

  it("vaciar_duracion y corregir_unidades: duracion_atipica", async () => {
    const fZero = mockFinding({
      detector: "duracion_atipica",
      signature: "cero",
      entity: { kind: "track", id: 100, label: "Pista 0" },
    });
    expect(vaciarDuracionAction.appliesTo(fZero)).toBe(true);
    expect(vaciarDuracionAction.levelFor(fZero, null)).toBe(0);
    expect(await vaciarDuracionAction.defaultParams(fZero, {} as never)).toEqual({ trackId: 100 });

    const fLong = mockFinding({
      detector: "duracion_atipica",
      signature: "muy_larga",
      entity: { kind: "track", id: 101, label: "Pista Larga" },
      evidence: { durationSeconds: 43601 },
    });
    expect(corregirUnidadesAction.appliesTo(fLong)).toBe(true);
    expect(corregirUnidadesAction.levelFor(fLong, null)).toBe(1);
    expect(await corregirUnidadesAction.defaultParams(fLong, {} as never)).toEqual({ trackId: 101, durationSeconds: 44 });
  });

  it("mover_duracion: extrae duración del título y calcula segundos", async () => {
    const f = mockFinding({
      detector: "duracion_en_titulo",
      entity: { kind: "track", id: 200, label: "Canción 3:30" },
      value: "Canción 3:30",
    });
    expect(moverDuracionAction.appliesTo(f)).toBe(true);
    expect(moverDuracionAction.levelFor(f, null)).toBe(0);
    const params = await moverDuracionAction.defaultParams(f, {} as never);
    expect(params).toEqual({ trackId: 200, cleanTitle: "Canción", durationSeconds: 210 });
    expect(moverDuracionAction.paramsSchema.parse(params)).toEqual(params);
  });

  it("extraer_interprete: artista con ficha existente", async () => {
    const f = mockFinding({
      detector: "artista_en_titulo_de_pista",
      signature: "artista_con_ficha",
      entity: { kind: "track", id: 300, label: "Zapato 3 - Entrada De Bala" },
      value: "Zapato 3 - Entrada De Bala",
      suggestedValue: "Entrada De Bala",
      related: [{ kind: "artist", id: 50, label: "Zapato 3" }],
    });
    expect(extraerInterpreteAction.appliesTo(f)).toBe(true);
    expect(extraerInterpreteAction.levelFor(f, null)).toBe(1);
    const params = await extraerInterpreteAction.defaultParams(f, {} as never);
    expect(params).toEqual({ trackId: 300, cleanTitle: "Entrada De Bala", artistId: 50 });
  });

  it("extraer_interprete_creando: artista sin ficha", async () => {
    const f = mockFinding({
      detector: "artista_en_titulo_de_pista",
      signature: "artista_sin_ficha",
      entity: { kind: "track", id: 301, label: "Banda Nueva - Cancion X" },
      value: "Banda Nueva - Cancion X",
    });
    expect(extraerInterpreteCreandoAction.appliesTo(f)).toBe(true);
    const params = await extraerInterpreteCreandoAction.defaultParams(f, {} as never);
    expect(params).toEqual({ trackId: 301, cleanTitle: "Cancion X", artistName: "Banda Nueva" });
  });

  it("extraer_invitado: feat en el título", async () => {
    const f = mockFinding({
      detector: "creditos_en_titulo",
      signature: "invitado",
      entity: { kind: "track", id: 400, label: "Noche De Rock (feat. Cayayo)" },
      value: "Noche De Rock (feat. Cayayo)",
      related: [{ kind: "person", id: 99, label: "Cayayo" }],
    });
    expect(extraerInvitadoAction.appliesTo(f)).toBe(true);
    const params = await extraerInvitadoAction.defaultParams(f, {} as never);
    expect(params).toEqual({ trackId: 400, cleanTitle: "Noche De Rock", guestName: "Cayayo", guestPersonId: 99 });
  });

  it("extraer_autores: autoría en el título", async () => {
    const f = mockFinding({
      detector: "creditos_en_titulo",
      signature: "autores",
      entity: { kind: "track", id: 500, label: "Tema Uno (R. Zonteno / M. Landa)" },
      value: "Tema Uno (R. Zonteno / M. Landa)",
      evidence: { segments: ["R. Zonteno", "M. Landa"] },
    });
    expect(extraerAutoresAction.appliesTo(f)).toBe(true);
    const params = await extraerAutoresAction.defaultParams(f, {} as never);
    expect(params).toEqual({ trackId: 500, cleanTitle: "Tema Uno", authors: ["R. Zonteno", "M. Landa"] });
  });

  it("convertir_en_organizacion_existente y convertir_creando_organizacion", async () => {
    const fExist = mockFinding({
      detector: "persona_es_organizacion",
      signature: "coincide_con_organizacion",
      entity: { kind: "person", id: 600, label: "Capitol Studios" },
      value: "Capitol Studios",
      related: [{ kind: "organization", id: 77, label: "Capitol Studios" }],
    });
    expect(convertirEnOrganizacionExistenteAction.appliesTo(fExist)).toBe(true);
    expect(await convertirEnOrganizacionExistenteAction.defaultParams(fExist, {} as never)).toEqual({
      personId: 600,
      organizationId: 77,
    });

    const fVocab = mockFinding({
      detector: "persona_es_organizacion",
      signature: "vocabulario_de_organizacion",
      entity: { kind: "person", id: 601, label: "Sonica Records" },
      value: "Sonica Records",
    });
    expect(convertirCreandoOrganizacionAction.appliesTo(fVocab)).toBe(true);
    expect(await convertirCreandoOrganizacionAction.defaultParams(fVocab, {} as never)).toEqual({
      personId: 601,
      organizationName: "Sonica Records",
      organizationType: "record_label",
    });
  });

  it("persona_con_nombre_de_artista: recomendador A/B de vincular vs convertir", async () => {
    const fSolista = mockFinding({
      detector: "persona_con_nombre_de_artista",
      signature: "solista_detras_del_proyecto",
      entity: { kind: "person", id: 700, label: "Angel Rada" },
      value: "Angel Rada",
      related: [{ kind: "artist", id: 88, label: "Angel Rada" }],
    });
    // Para solista, vincular como miembro es nivel 1 (recomendado), convertir es nivel 2
    expect(vincularComoMiembroAction.levelFor(fSolista, null)).toBe(1);
    expect(convertirEnArtistaAction.levelFor(fSolista, null)).toBe(2);

    const fBanda = mockFinding({
      detector: "persona_con_nombre_de_artista",
      signature: "banda_como_persona",
      entity: { kind: "person", id: 701, label: "Los Supersónicos" },
      value: "Los Supersónicos",
      related: [{ kind: "artist", id: 89, label: "Los Supersónicos" }],
    });
    // Para banda, convertir en artista es nivel 1 (recomendado), vincular es nivel 2
    expect(convertirEnArtistaAction.levelFor(fBanda, null)).toBe(1);
    expect(vincularComoMiembroAction.levelFor(fBanda, null)).toBe(2);
  });

  it("dividir_persona: valida destinos y nivel 2", async () => {
    const f = mockFinding({
      detector: "varias_personas_en_una",
      signature: "varias_personas_en_una",
      entity: { kind: "person", id: 800, label: "Eliezer Delgado, Gregory Carrero" },
      value: "Eliezer Delgado, Gregory Carrero",
      evidence: { parts: ["Eliezer Delgado", "Gregory Carrero"] },
    });
    expect(dividirPersonaAction.appliesTo(f)).toBe(true);
    expect(dividirPersonaAction.levelFor(f, null)).toBe(2);
    expect(await dividirPersonaAction.defaultParams(f, {} as never)).toEqual({
      personId: 800,
      into: ["Eliezer Delgado", "Gregory Carrero"],
    });
  });

  it("retirar_con_creditos y retirar_huerfana", async () => {
    const fNotName = mockFinding({
      detector: "persona_no_es_un_nombre",
      signature: "duracion_o_numero",
      entity: { kind: "person", id: 900, label: "3:48" },
      value: "3:48",
    });
    expect(retirarConCreditosAction.appliesTo(fNotName)).toBe(true);
    expect(retirarConCreditosAction.levelFor(fNotName, null)).toBe(1);

    const fOrphan = mockFinding({
      detector: "fichas_sin_vinculos",
      signature: "person",
      entity: { kind: "person", id: 901, label: "Persona Sola" },
    });
    expect(retirarHuerfanaAction.appliesTo(fOrphan)).toBe(true);
    expect(retirarHuerfanaAction.levelFor(fOrphan, null)).toBe(0);
    expect(await retirarHuerfanaAction.defaultParams(fOrphan, {} as never)).toEqual({
      kind: "person",
      id: 901,
    });
  });

  it("fusionar_discos y retirar_pista_duplicada: pares válidos", async () => {
    const fAlbums = mockFinding({
      detector: "discos_repetidos",
      signature: "mismo_titulo",
      evidence: { pair: [10, 20] },
    });
    expect(fusionarDiscosAction.appliesTo(fAlbums)).toBe(true);

    const fTracks = mockFinding({
      detector: "pistas_repetidas",
      signature: "pistas_repetidas",
      evidence: { pair: [100, 200] },
    });
    expect(retirarPistaDuplicadaAction.appliesTo(fTracks)).toBe(true);
  });
});
