import { describe, expect, it } from "vitest";
import { DeepSeekGateway, MemoryDeepSeekRunStore, MockDeepSeekTransport } from "../../src/ai/gateway.js";
import { analyzeAlbumPair, guardAlbumClusters, type AlbumSide } from "../../src/ambiguity/albums.js";
import { DeepSeekArbiter, FileArbiter, applyArbiterPolicy } from "../../src/ambiguity/arbiter.js";
import { analyzePersonPair, buildPersonIndex, findCompetitors, type PersonPairInput, type PersonSide } from "../../src/ambiguity/persons.js";
import { parsePersonName, personRelation, titleRelation, trackTitlesEquivalent } from "../../src/ambiguity/text.js";
import { assertGrounded, type QuestionOutcome } from "../../src/ambiguity/types.js";
import { analyzeYouTubeReview, outOfOrderPositions, type YtAlbum, type YtReviewInput } from "../../src/ambiguity/youtube.js";
import { planReconciliation, type ReconcileSnapshot } from "../../src/youtube/reconcile.js";

// Los casos salen de la base de desarrollo del 2026-09-14 (pares que dejó el
// cierre de F2–F5 y las 15 revisiones de yt:reconcile), reducidos a lo que
// cada regla mira.

const outcomes: QuestionOutcome[] = [];
const keep = <T extends QuestionOutcome | QuestionOutcome[]>(value: T): T => { outcomes.push(...(Array.isArray(value) ? value : [value])); return value; };

const album = (id: number, title: string, year: number | null, type: string, tracks: string[], extra: Partial<AlbumSide> = {}): AlbumSide => ({
  id, artistId: 1, artistName: "Luz Verde", title, year, type, classifications: [], primaryVideoId: null, sources: ["sincopa"],
  tracks: tracks.map((trackTitle, index) => ({ id: id * 100 + index, disc: 1, number: index + 1, title: trackTitle })), ...extra,
});
const pairOf = (a: AlbumSide, b: AlbumSide, reviewId = 1) => keep(analyzeAlbumPair({ reviewId, a, b }));
const songs = (count: number, prefix = "Canción"): string[] => Array.from({ length: count }, (_, index) => `${prefix} ${String.fromCharCode(65 + index)} del disco`);

describe("E10 · texto", () => {
  it("reconoce variantes de título sin confundir recopilatorios", () => {
    expect(titleRelation("Cinema 0", "Cinema Cero", "Luz Verde")).toBe("equal");
    expect(titleRelation("3 Casas", "Tres Casas", "Famasloop")).toBe("equal");
    expect(titleRelation("Azúcar Cacao y Leche Vol. II", "Volumen 2", "Azúcar, Cacao & Leche")).toBe("equal");
    expect(titleRelation("Éxodo", "Ep", "Éxodo")).toBe("generic");
    expect(titleRelation("El Nuevo Beat Del Tambor", "El Beat del Tambor", "Mango Funk")).toBe("contains");
    expect(titleRelation("Acústico En Bits Session", "Bitsessions", "Candy66")).toBe("unrelated");
  });

  it("una pista con otra grabación entre paréntesis no es la misma pista; una errata sí", () => {
    expect(trackTitlesEquivalent("Ceniza", "Cenizas")).toBe(true);
    expect(trackTitlesEquivalent("Todo Está Bien (Radio Cut)", "Todo Está Bien (Radio version)")).toBe(true);
    expect(trackTitlesEquivalent("Bond, Jaime Bond", "Bond, James Bond")).toBe(true);
    expect(trackTitlesEquivalent("Popurrí:", "Popurri: El Cantante / El Peine")).toBe(true);
    expect(trackTitlesEquivalent("Atardecer", "Atardecer (Remix)")).toBe(false);
    expect(trackTitlesEquivalent("Polen", "Polen En Tus Pestañas")).toBe(false);
  });

  it("clasifica las grafías de persona", () => {
    const relation = (a: string, b: string) => personRelation(parsePersonName(a), parsePersonName(b));
    expect(relation('José Manuel "Chema" Arria', 'José Manuel Arria "Chema"')).toBe("nickname_variant");
    expect(relation("J. M. Arria", "José Manuel Arria")).toBe("initials");
    expect(relation("Pedro V. Lizardo", "Pedro Vicente Lizardo")).toBe("initials");
    expect(relation("Rubén Correa", 'Rubén Ángel "Micho" Correa')).toBe("extra_given_name");
    expect(relation("Wincho Schäfer", "Wincho Schaeffer")).toBe("surname_typo");
    expect(relation("Pablo Hernández", "Pablo Fernández")).toBe("fuzzy");
    expect(relation("María Imhof Ramirez", "Martín Imhof Ramirez")).toBe("given_typo");
    expect(relation('Alejandro "Chofa" Loero', 'Alfredo Loero "Chofa"')).toBe("nickname_surname");
    expect(relation("Fernando Carías", "Fernando Cárdenas")).toBeNull();
    expect(parsePersonName('Iván Marcano Carlos "Nené" Quintero Jesús "Chuo" Quintero').compound).toBe(true);
  });
});

describe("E10 · pares de discos", () => {
  it("en empate conserva el título menos truncado, no la ficha de id menor", () => {
    const tracks = songs(5);
    const outcome = pairOf(
      album(1044, "Demo", 2004, "other", tracks, { artistName: "Adh Seidh" }),
      album(3248, "Adh Seidh", 2004, "other", tracks, { artistName: "Adh Seidh" }),
    );
    expect(outcome).toMatchObject({
      decision: "MATCH_HIGH_CONFIDENCE",
      target: { keepId: 3248, dropId: 1044, keepTitle: "Adh Seidh", dropTitle: "Demo" },
    });
  });

  it("Cinema 0 / Cinema Cero: el mismo disco, queda la ficha del canal", () => {
    const tracks = [...songs(12), "Todo Está Bien (Radio Cut)"];
    const outcome = pairOf(
      album(462, "Cinema 0", 2000, "studio_album", tracks, { primaryVideoId: "aaaaaaaaaaa" }),
      album(4664, "Cinema Cero", 2000, "other", [...songs(12), "Todo Está Bien (Radio version)"]),
    );
    expect(outcome).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", rule: "album.same_release", target: { action: "merge_albums", keepId: 462, dropId: 4664 } });
  });

  it("Decade of Perversion 2003/2002 es CONFLICT: el mismo disco con dos años", () => {
    const tracks = songs(17);
    const outcome = pairOf(album(1387, "Decade of Perversion", 2003, "other", tracks, { artistName: "Krueger" }), album(3301, "A Decade of Perversion", 2002, "other", tracks, { artistName: "Krueger" }));
    expect(outcome).toMatchObject({ decision: "CONFLICT", rule: "album.year_conflict", target: null });
  });

  it("Desde Una Orilla: la pista 5 distinta es CONFLICT, no una fusión", () => {
    const outcome = pairOf(
      album(199, "Desde Una Orilla A La Otra", 1983, "studio_album", [...songs(4), "Lo Que Has Hecho", ...songs(5, "Otra")], { artistName: "Hydra", primaryVideoId: "bbbbbbbbbbb" }),
      album(4229, "Desde Una Orilla", null, "other", [...songs(4), "El Anciano de Barba Gris"], { artistName: "Hydra" }),
    );
    expect(outcome).toMatchObject({ decision: "CONFLICT", rule: "album.tracklist_conflict" });
  });

  it("separa con evidencia: dos videos del canal, otra edición, recopilatorio, remix", () => {
    const tracks = songs(11);
    expect(pairOf(album(240, "Los Topinos Del Pan", 2011, "studio_album", tracks, { primaryVideoId: "ccccccccccc" }), album(459, "Todos Los Topinos De Lebronch", 2009, "studio_album", tracks, { primaryVideoId: "ddddddddddd" })).rule).toBe("album.both_on_channel");
    expect(pairOf(album(875, "El Poder Del Lado Oscuro 2.0", 2020, "other", tracks), album(1577, "El poder del lado oscuro", 2000, "other", tracks)).rule).toBe("album.distinct_edition");
    expect(pairOf(album(142, "Harakiri City", 1996, "studio_album", tracks), album(3580, "Solo Exitos", 2001, "other", tracks)).rule).toBe("album.compilation_vs_original");
    expect(pairOf(album(334, "Cruel {Instinto De Morder}", 2008, "studio_album", [...songs(9), "Atardecer"]), album(2030, "Cruel", 2008, "other", [...songs(9), "Atardecer (Remix)"])).decision).toBe("CONFLICT");
  });

  it("sin relación entre títulos queda NEEDS_HUMAN aunque compartan todas las pistas, y un árbitro puede leerlo", () => {
    const tracks = songs(8);
    const outcome = pairOf(album(521, "Acústico En Bits Session", 2010, "other", tracks, { artistName: "Candy66" }), album(3541, "Bitsessions", 2010, "other", tracks, { artistName: "Candy66" }));
    expect(outcome).toMatchObject({ decision: "NEEDS_HUMAN", rule: "album.no_same_release_evidence", aiEligible: true, target: null });
    expect(pairOf(album(1504, "Brutal Assault", 2010, "ep", songs(9), { artistName: "Brutal Assault" }), album(3490, "Demo", 2010, "other", songs(3), { artistName: "Brutal Assault" })).decision).toBe("NEEDS_HUMAN");
    expect(pairOf(album(99, "Éxodo", 2011, "ep", songs(4), { artistName: "Éxodo" }), album(2682, "Ep", 2011, "other", songs(4), { artistName: "Éxodo" })).decision).toBe("MATCH_HIGH_CONFIDENCE");
  });

  it("un rango de años frente a una demo es recopilatorio, las demos de un disco no son el disco y una errata corta sí se reconoce", () => {
    expect(pairOf(album(1489, "1988 – 1996", null, "other", songs(6), { artistName: "Nemesis (Lara)" }), album(1881, "Anarkia en L.A.", 1993, "demo", songs(6), { artistName: "Nemesis (Lara)" })).rule).toBe("album.compilation_vs_original");
    expect(pairOf(album(900, "Recuerdos del Olvido (Demos)", 2010, "other", songs(3), { artistName: "Tierra del Dragón" }), album(901, "Recuerdos del Olvido", 2012, "studio_album", songs(10), { artistName: "Tierra del Dragón" }))).toMatchObject({ decision: "NEEDS_HUMAN", rule: "album.demo_vs_release" });
    expect(pairOf(album(300, "Dubdelic", 2008, "studio_album", songs(12), { artistName: "Patafunk" }), album(2883, "Dudelic", 2008, "other", songs(12), { artistName: "Patafunk" })).decision).toBe("MATCH_HIGH_CONFIDENCE");
  });

  it("un disco candidato en dos pares no se fusiona solo", () => {
    const tracks = songs(8);
    const a = album(558, "The Venezuelan Zinga Son Vol. 1", 2002, "studio_album", tracks, { artistName: "Los Amigos Invisibles" });
    const b = album(3351, "The Venezuelan Zinga Son", 2002, "other", tracks, { artistName: "Los Amigos Invisibles" });
    const c = album(4637, "The Venezuelan Zinga Son Vol 1", null, "other", tracks, { artistName: "Los Amigos Invisibles" });
    const guarded = guardAlbumClusters([{ input: { reviewId: 1, a, b }, outcome: analyzeAlbumPair({ reviewId: 1, a, b }) }, { input: { reviewId: 2, a, b: c }, outcome: analyzeAlbumPair({ reviewId: 2, a, b: c }) }]);
    expect(guarded.map((item) => item.outcome.rule)).toEqual(["album.competing_pairs", "album.competing_pairs"]);
    expect(keep(guarded.map((item) => item.outcome)).every((item) => item.decision === "NEEDS_HUMAN" && item.target === null)).toBe(true);
  });
});

const person = (id: number, name: string, artists: Array<[number, string]>, extra: Partial<PersonSide> = {}): PersonSide => ({
  id, name, nationality: null, birthDate: null, deathDate: null, artists: artists.map(([artistId, artistName]) => ({ id: artistId, name: artistName })),
  albums: [], channelCredited: false, references: artists.length, ...extra,
});
const personPair = (a: PersonSide, b: PersonSide, extra: Partial<PersonPairInput> = {}) =>
  keep(analyzePersonPair({ reviewId: 1, a, b, prior: [], competitors: { a: [], b: [] }, ...extra }));

describe("E10 · personas y homónimos", () => {
  it("en empate queda la grafía menos cortada, no la de id menor", () => {
    const album = { albums: [{ id: 1, title: "Mil Estaciones", artistName: "Languidez", creditTypes: ["musician"] }] };
    const outcome = personPair(person(6201, "onathan Leal", [[9, "Languidez"]], album), person(6203, "Jonathan Leal", [[9, "Languidez"]], album));
    expect(outcome.options[0]?.target).toMatchObject({ keepId: 6203, dropId: 6201 });
  });

  it("una variante del apodo con la misma banda se fusiona, y queda el nombre del canal", () => {
    const outcome = personPair(person(602, 'José Manuel "Chema" Arria', [[10, "Sentimiento Muerto"]]), person(5200, 'José Manuel Arria "Chema"', [[10, "Sentimiento Muerto"]], { channelCredited: true }));
    expect(outcome).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", target: { action: "merge_persons", keepId: 5200, dropId: 602 } });
  });

  it("un nombre sin apodo que encaja con dos apodados distintos es NEEDS_HUMAN", () => {
    const persons = [{ id: 167, name: "José Rodríguez" }, { id: 1112, name: 'José "Cheo" Rodríguez' }, { id: 6072, name: 'José "Pepe" Rodríguez' }];
    const index = buildPersonIndex(persons);
    const context = new Map([[167, new Set([1])], [1112, new Set([1])], [6072, new Set([2])]]);
    const [x, y] = [index.get("rodriguez")!.find((item) => item.id === 167)!, index.get("rodriguez")!.find((item) => item.id === 1112)!];
    const competitors = findCompetitors(x, y, index, context).map(({ id, name }) => ({ id, name }));
    expect(competitors.map((item) => item.id)).toEqual([6072]);
    const outcome = personPair(person(167, "José Rodríguez", [[1, "Colina"]]), person(1112, 'José "Cheo" Rodríguez', [[1, "Colina"]]), { competitors: { a: competitors, b: [] } });
    expect(outcome).toMatchObject({ decision: "NEEDS_HUMAN", rule: "person.competing_candidates", target: null });
  });

  it("una inicial que encaja con dos personas de la misma banda es NEEDS_HUMAN; con una sola, se fusiona", () => {
    const index = buildPersonIndex([{ id: 9449, name: "A. Peña" }, { id: 200, name: "Archie Peña" }, { id: 921, name: "Alexis Peña" }]);
    const context = new Map([[9449, new Set([7])], [200, new Set([7])], [921, new Set([7])]]);
    const initial = index.get("pena")!.find((item) => item.id === 9449)!;
    const archie = index.get("pena")!.find((item) => item.id === 200)!;
    expect(findCompetitors(initial, archie, index, context).map((item) => item.id)).toEqual([921]);

    const unique = buildPersonIndex([{ id: 8920, name: "H. Blanco" }, { id: 482, name: "Horacio Blanco" }]);
    const h = unique.get("blanco")!;
    expect(findCompetitors(h[0]!, h[1]!, unique, new Map([[8920, new Set([3])], [482, new Set([3])]]))).toEqual([]);
    const outcome = personPair(person(8920, "H. Blanco", [[3, "Desorden Público"]]), person(482, "Horacio Blanco", [[3, "Desorden Público"], [4, "Los Amigos Invisibles"]], { references: 8 }));
    expect(outcome).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", rule: "person.initials_unique", target: { keepId: 482, dropId: 8920 } });
  });

  it("nombres de pila distintos, apodos contradictorios o sin banda común nunca se fusionan solos", () => {
    expect(personPair(person(2348, "María Imhof Ramirez", [[5, "Aditus"]]), person(2354, "Martín Imhof Ramirez", [[5, "Aditus"]])).decision).toBe("NEEDS_HUMAN");
    expect(personPair(person(519, 'Francisco "CoCo" Díaz', [[3, "Desorden Público"]]), person(3107, 'Francisco "Roco" Díaz', [[3, "Desorden Público"]])).rule).toBe("person.nickname_conflict");
    expect(personPair(person(37, "Silvio Rodríguez", [[8, "Colina"]]), person(9791, "S. Rodríguez", [[9, "Sentencia"]])).rule).toBe("person.no_shared_context");
    const short = personPair(person(116, "David Hernández", [[55, "Candy66"]]), person(2423, 'David "Morocho" Hernández', [[55, "Candy66"]]));
    expect(short).toMatchObject({ decision: "NEEDS_HUMAN", rule: "person.name_variant_weak_context", aiEligible: true });
    const sameAlbum = { albums: [{ id: 427, title: "P.O.P.", artistName: "Candy66", creditTypes: ["recording"] }] };
    expect(personPair(person(116, "David Hernández", [[55, "Candy66"]], sameAlbum), person(2423, 'David "Morocho" Hernández', [[55, "Candy66"]], sameAlbum)).decision).toBe("MATCH_HIGH_CONFIDENCE");
  });

  it("una errata de apellido solo se fusiona con el mismo crédito en el mismo disco", () => {
    const rendon = person(1617, "Alexis Rendón", [[30, "Témpano"]], { albums: [{ id: 362, title: "El Fin De La Infancia", artistName: "Témpano", creditTypes: ["musician"] }] });
    const rondonMixing = person(2811, "Alexis Rondón", [[30, "Témpano"]], { albums: [{ id: 362, title: "El Fin De La Infancia", artistName: "Témpano", creditTypes: ["mixing"] }] });
    expect(personPair(rendon, rondonMixing)).toMatchObject({ decision: "NEEDS_HUMAN", rule: "person.surname_typo_weak_context" });
    const rondonMusician = { ...rondonMixing, albums: [{ ...rondonMixing.albums[0]!, creditTypes: ["musician"] }] };
    expect(personPair(rendon, rondonMusician)).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", rule: "person.surname_typo_same_credit" });
  });

  it("una decisión humana previa manda y fechas distintas separan", () => {
    const a = person(1, "Carlos Quintero", [[1, "X"]]); const b = person(2, 'Carlos "Nene" Quintero', [[1, "X"]]);
    expect(personPair(a, b, { prior: [{ reviewId: 99, verdict: "different", decidedBy: "Brian" }] })).toMatchObject({ decision: "KEEP_SEPARATE", rule: "person.prior_human_decision" });
    expect(personPair({ ...a, birthDate: "1970-01-01" }, { ...b, birthDate: "1981-05-02" }).decision).toBe("KEEP_SEPARATE");
  });
});

const ytAlbum = (id: number, title: string, year: number | null, type: string, tracks: string[], credits: Array<[string, string]> = [], classifications: string[] = []): YtAlbum => ({
  id, title, year, type, classifications,
  tracks: tracks.map((trackTitle, index) => ({ id: id * 100 + index + 1, disc: 1, number: index + 1, title: trackTitle, durationSeconds: 200 })),
  credits: credits.map(([name, creditType], index) => ({ id: id * 1000 + index, name, creditType, role: creditType })),
});
const ytInput = (extra: Partial<YtReviewInput>): YtReviewInput => ({
  reviewId: 191119, videoDbId: 87, videoId: "1N6cHd9CvEA", title: "Claroscuro - Miel (Official 4K Video)", description: "", durationSeconds: 201,
  kind: "music_video", category: "MATCHED_MEDIUM", artist: { id: 67, name: "Claroscuro" }, seed: null, tracklist: [],
  linkedAlbums: [], candidateTracks: [], candidateAlbums: [], startMismatches: [], ...extra,
});

describe("E10 · revisiones de yt:reconcile", () => {
  it("Miel: los créditos de grabación de la descripción señalan el disco de estudio", () => {
    const studio = ytAlbum(546, "Supereterodino", 2001, "studio_album", ["Intro", "Miel"], [["Pablo Estacio", "mixing"], ["Cayayo Troconis", "producer"], ["Taylor Deupree", "mastering"], ["Carlos Eduardo Reyes", "musician"]]);
    const live = ytAlbum(154, "En Vivo CorpBanca", 2001, "live_album", ["Miel"], [["Carlos Eduardo Reyes", "musician"]]);
    const [outcome] = keep(analyzeYouTubeReview(ytInput({
      description: "Guitar, Keyboards & Vocals: Carlos Eduardo Reyes. Audio produced by Cayayo Troconis, Pablo Estacio & Sebastián Araujo. Mastered by Taylor Deupree at Aquasphere",
      candidateTracks: [{ trackId: 54602, title: "Miel", durationSeconds: 245, album: studio }, { trackId: 15401, title: "Miel", durationSeconds: 261, album: live }],
    })));
    expect(outcome).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", rule: "music_video.session_credits", target: { action: "link_video_track", trackId: 54602, startSeconds: 0, endSeconds: 201 } });
  });

  it("Animal: un crédito compartido con el directo no impide elegir el disco que los tiene todos", () => {
    const sigo = ytAlbum(418, "Sigo", 2011, "studio_album", ["Animal"], [["Gustavo Casas", "producer"], ["Ricardo Martínez", "recording"], ["Andrés Mayo", "mastering"]]);
    const sala = ytAlbum(115, "Concierto En La Sala", 2012, "live_album", ["Animal"], [["Gustavo Casas", "producer"], ["Rubén Hernández", "mixing"]]);
    const [outcome] = keep(analyzeYouTubeReview(ytInput({
      description: "Audio Produced by Ricardo Martínez, Gustavo Casas & Americania. Mastered by Andrés Mayo", artist: { id: 41, name: "Americania" },
      candidateTracks: [{ trackId: 2336, title: "Animal", durationSeconds: 373, album: sigo }, { trackId: 5846, title: "Animal", durationSeconds: 402, album: sala }],
    })));
    expect(outcome?.target).toMatchObject({ trackId: 2336 });
  });

  it("Burrera: dos discos sin créditos de grabación distintivos quedan NEEDS_HUMAN", () => {
    const bsides = ytAlbum(426, "B-Sides", 2003, "other", ["Burrera"], [["Candy66", "producer"], ["Frank Pulgar", "musician"]], ["B-Sides"]);
    const archivo = ytAlbum(3543, "Archivo Vol.1", null, "other", ["Burrera"], [["Let Arteaga", "musician"]]);
    const [outcome] = keep(analyzeYouTubeReview(ytInput({
      title: "Candy66 - Burrera (Official 4K Video)", description: "Produced by Candy66. Guitar: Frank Pulgar. Recorded & Mixed by David Pérez", artist: { id: 55, name: "Candy66" }, category: "AMBIGUOUS",
      candidateTracks: [{ trackId: 3990, title: "Burrera", durationSeconds: 227, album: bsides }, { trackId: 21728, title: "Burrera", durationSeconds: null, album: archivo }],
    })));
    expect(outcome).toMatchObject({ decision: "NEEDS_HUMAN", aiEligible: true, target: null });
    expect(outcome?.options.map((option) => option.key)).toEqual(["track:3990", "track:21728"]);
  });

  it("un concierto con el disco que nombra la hoja se enlaza sin crear disco, y la marca fuera de orden no se usa", () => {
    const live = ytAlbum(248, "En Una Noche Tan Linda Como Esta", 2008, "live_album", ["Miss Venezuela", "Qué Rico", "Llegaste Tarde", "Si Tú Te Vas", "Yo Soy Así", "Ultrafunk", "Cuchi-Cuchi"], [], ["Live Album"]);
    // La descripción real marca «44:40 - Llegaste Tarde» entre 27:51 y 34:24.
    const tracklist = [["Intro", 0], ["Miss Venezuela", 47], ["Qué Rico", 125], ["Llegaste Tarde", 2680], ["Si Tú Te Vas", 2064], ["Yo Soy Así", 2346], ["Ultrafunk", 2685], ["Cuchi Cuchi", 3853]]
      .map(([title, start], position) => ({ position, title: String(title), startSeconds: Number(start) }));
    expect([...outOfOrderPositions(tracklist)]).toEqual([3]);
    // Con un empate no se sabe cuál de las dos marcas está mal: no se usa ninguna.
    expect([...outOfOrderPositions([0, 10, 50, 40, 90].map((startSeconds, position) => ({ position, title: `t${position}`, startSeconds })))]).toEqual([2, 3]);
    const [outcome] = keep(analyzeYouTubeReview(ytInput({
      videoId: "8nfYcQanBSs", title: "Los Amigos Invisibles - En Una Noche Tan Linda Como Esta (2008) || Full Concert || 4K60 Remastered", kind: "live_concert", durationSeconds: 4276,
      seed: { artist: "Los Amigos Invisibles", album: "En Una Noche Tan Linda Como Esta", year: 2008, type: "Live Concert" }, tracklist, candidateAlbums: [live],
    })));
    expect(outcome).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", rule: "live_concert.setlist_overlap", target: { action: "link_video_album", albumId: 248, albumKind: "live_concert" } });
    const occurrences = outcome?.target?.action === "link_video_album" ? outcome.target.occurrences : [];
    expect(occurrences.map((item) => [item.trackId, item.startSeconds, item.endSeconds])).toEqual([
      [24801, 47, 125], [24802, 125, 2064], [24804, 2064, 2346], [24805, 2346, 2685], [24806, 2685, 3853], [24807, 3853, 4276],
    ]);
  });

  it("un concierto nunca es la grabación de un disco de estudio; un disco sin pistas se enlaza solo si la hoja lo nombra con su año", () => {
    const [studio] = keep(analyzeYouTubeReview(ytInput({ kind: "live_concert", title: "Americania - Sigo En Vivo || Full Concert ||", candidateAlbums: [ytAlbum(418, "Sigo", 2011, "studio_album", ["Animal"])] })));
    expect(studio).toMatchObject({ decision: "KEEP_SEPARATE", rule: "live_concert.studio_album" });
    const [ilan] = keep(analyzeYouTubeReview(ytInput({
      videoId: "pIHZugWjvuQ", kind: "live_concert", title: "Ilan Chester - Ilan En Vivo Desde @MataDeCoco (1988) || Full Concert || 4K60 Remastered",
      seed: { artist: "Ilan Chester", album: "Ilan En Vivo", year: 1988, type: "Live Concert" }, candidateAlbums: [ytAlbum(4246, "Ilan En Vivo", 1988, "other", [])],
    })));
    expect(ilan).toMatchObject({ decision: "MATCH_HIGH_CONFIDENCE", rule: "live_concert.sheet_album_and_year", target: { occurrences: [] } });
  });

  it("Acústico en Bits: la intro es un segmento, «Cenizas» es la pista 4; un disco sin pistas no se completa aquí", () => {
    const acustico = { ...ytAlbum(521, "Acústico En Bits Session", 2010, "other", ["Bifásico", "Yankee", "Somos Otros", "Ceniza", "Batalla"]), albumKind: "full_album", isPrimary: true };
    const tracklist = [["Intro", 0], ["Bifásico", 246], ["Yankee", 616], ["Somos Otros", 1036], ["Cenizas", 1276], ["Batalla", 1609]].map(([title, start], position) => ({ position, title: String(title), startSeconds: Number(start) }));
    const questions = keep(analyzeYouTubeReview(ytInput({ videoId: "sVUKZnbTLsE", kind: "full_album", durationSeconds: 2981, tracklist, linkedAlbums: [acustico] })));
    expect(questions.map((item) => [item.questionKey, item.decision, item.rule])).toEqual([
      ["entry:0", "KEEP_SEPARATE", "full_album.non_track_segment"],
      ["entry:4", "MATCH_HIGH_CONFIDENCE", "full_album.near_title_same_position"],
    ]);
    expect(questions[1]?.target).toEqual({ action: "link_video_track", videoDbId: 87, videoId: "sVUKZnbTLsE", trackId: 52104, startSeconds: 1276, endSeconds: 1609 });
    const empty = { ...ytAlbum(534, "EtéreoPlay Sessions", 2016, "other", []), albumKind: "full_album", isPrimary: true };
    expect(keep(analyzeYouTubeReview(ytInput({ kind: "full_album", tracklist, linkedAlbums: [empty] })))[0]).toMatchObject({ decision: "NEEDS_HUMAN", rule: "full_album.album_without_tracks", aiEligible: false });
  });
});

describe("E10 · ninguna resolución automática sin evidencia concreta", () => {
  it("todas las decisiones de estos casos citan hechos existentes en su dirección", () => {
    expect(outcomes.length).toBeGreaterThan(25);
    for (const outcome of outcomes) {
      expect(() => assertGrounded(outcome)).not.toThrow();
      if (outcome.decision !== "NEEDS_HUMAN") expect(outcome.evidence.length).toBeGreaterThan(0);
    }
  });

  it("assertGrounded rechaza un MATCH sin evidencia o con citas inventadas", () => {
    const base = pairOf(album(1, "Cinema 0", 2000, "studio_album", songs(5)), album(2, "Cinema Cero", 2000, "other", songs(5)));
    expect(() => assertGrounded({ ...base, evidence: [] })).toThrow(/sin evidencia/u);
    expect(() => assertGrounded({ ...base, evidence: [{ factId: "F99", supports: "match" }] })).toThrow(/inexistentes/u);
    expect(() => assertGrounded({ ...base, target: null })).toThrow(/sin destino/u);
  });
});

describe("E10 · árbitro de IA", () => {
  const bits = () => analyzeAlbumPair({ reviewId: 7, a: album(521, "Acústico En Bits Session", 2010, "other", songs(8), { artistName: "Candy66" }), b: album(3541, "Bitsessions", 2010, "other", songs(8), { artistName: "Candy66" }) });
  const proposal = (extra: object) => ({ decision: "MATCH_HIGH_CONFIDENCE" as const, option: "same", evidence: [{ fact_id: "F4", supports: "match" as const, note: "8 de 8" }, { fact_id: "F5", supports: "match" as const, note: "mismo año" }], reasoning_summary: "Bits Session es la misma sesión", uncertainties: [], ...extra });

  it("acepta un MATCH que cita dos hechos del dosier y lo convierte en su destino", () => {
    const result = applyArbiterPolicy(bits(), proposal({}));
    expect(result).toMatchObject({ accepted: true, decision: "MATCH_HIGH_CONFIDENCE", target: { action: "merge_albums" } });
  });

  it("descarta citas inventadas, un solo hecho, incertidumbres o una opción inexistente", () => {
    expect(applyArbiterPolicy(bits(), proposal({ evidence: [{ fact_id: "F99", supports: "match", note: "x" }, { fact_id: "F4", supports: "match", note: "y" }] }))).toMatchObject({ accepted: false, decision: "NEEDS_HUMAN", target: null });
    expect(applyArbiterPolicy(bits(), proposal({ evidence: [{ fact_id: "F4", supports: "match", note: "y" }] })).rejection).toMatch(/dos hechos/u);
    expect(applyArbiterPolicy(bits(), proposal({ uncertainties: ["podría ser otra sesión"] })).accepted).toBe(false);
    expect(applyArbiterPolicy(bits(), proposal({ option: "otra" })).accepted).toBe(false);
    expect(applyArbiterPolicy(bits(), { ...proposal({}), decision: "NEEDS_HUMAN", option: null })).toMatchObject({ accepted: true, decision: "NEEDS_HUMAN" });
  });

  it("DeepSeek arbitra con el modelo flash y solo ve el dosier", async () => {
    const transport = new MockDeepSeekTransport(proposal({}));
    const gateway = new DeepSeekGateway({ baseUrl: "https://mock.deepseek.invalid", models: { fast: "configured-fast", reasoning: "configured-pro", vision: "configured-vision" }, maxTokens: 1_000, timeoutMs: 5_000 }, transport, new MemoryDeepSeekRunStore());
    const question = bits();
    const verdict = await new DeepSeekArbiter(gateway).arbitrate({ reviewId: 7, caseTitle: "Candy66", dossierHash: "a".repeat(64), question });
    expect(transport.requests[0]).toMatchObject({ model: "configured-fast", modelClass: "fast" });
    expect(transport.requests[0]?.system).toContain("SOLO los hechos");
    expect(transport.requests[0]?.user).toContain("Bitsessions");
    expect(verdict.arbiter).toBe("deepseek:configured-fast");
  });

  it("un árbitro de archivo solo decide sobre el dosier que vio", async () => {
    const file = new FileArbiter({ arbiter: "claude-opus-5", decidedAt: "2026-09-14", decisions: [{ reviewId: 7, questionKey: "pair", dossierHash: "b".repeat(64), proposal: proposal({}) }] });
    expect(await file.arbitrate({ reviewId: 7, caseTitle: "x", dossierHash: "c".repeat(64), question: bits() })).toBeNull();
    expect((await file.arbitrate({ reviewId: 7, caseTitle: "x", dossierHash: "b".repeat(64), question: bits() }))?.arbiter).toBe("claude-opus-5");
  });
});

describe("E10 · yt:reconcile respeta lo que una persona ya cerró", () => {
  const snapshot = (settled: ReconcileSnapshot["settled"]): ReconcileSnapshot => ({
    artists: [{ id: 2, name: "Candy66" }], aliases: [],
    albums: [{ id: 20, artistId: 2, title: "P.O.P.", year: 2001, type: "studio_album" }, { id: 21, artistId: 2, title: "En Vivo", year: 2003, type: "other" }],
    tracks: [{ id: 200, albumId: 20, discNumber: 1, trackNumber: 1, title: "Solo", youtubeStartSeconds: null }, { id: 201, albumId: 21, discNumber: 1, trackNumber: 1, title: "Solo", youtubeStartSeconds: null }],
    links: [], videos: [{ dbId: 3, videoId: "ncvnMbYmC3g", title: "Candy66 - Solo (Official 4K Video)", durationSeconds: 200, seed: null, tracklist: [] }],
    ...(settled ? { settled } : {}),
  });
  it("una revisión cerrada que ya vio la propuesta la asienta; una propuesta nueva vuelve a preguntar", () => {
    expect(planReconciliation(snapshot(undefined)).verdicts[0]?.category).toBe("MATCHED_MEDIUM");
    const seen = { category: "MATCHED_MEDIUM", proposals: [{ kind: "track", id: 200 }], tracklist: null };
    const settled = planReconciliation(snapshot([{ videoDbId: 3, reviewId: 191131, status: "approved", payload: seen }])).verdicts[0]!;
    expect(settled.category).toBe("MATCHED_HIGH");
    expect(settled.reasons.join(" ")).toContain("#191131");
    const other = { ...seen, proposals: [{ kind: "track", id: 999 }] };
    expect(planReconciliation(snapshot([{ videoDbId: 3, reviewId: 1, status: "approved", payload: other }])).verdicts[0]?.category).toBe("MATCHED_MEDIUM");
  });
});
