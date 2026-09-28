// Créditos del disco por bloque del canal (Brian, 2026-09-21), con Harakiri
// City como caso: tres músicos principales en el canal y Sincopa aportando
// otros músicos y otra producción.
import { describe, expect, it } from "vitest";
import {
  buildPersonIndex, channelFacts, creditRoleParts, inheritSiblingOrigin, planChannelSections, planMusicianSections,
  planOtherCredits, planOtherSources, roleParts,
  type ChannelFact, type CreditRow, type MusicianChange, type MusicianCredit, type OtherChange, type OtherCredit,
} from "../../src/youtube/credit-sections.js";

let nextId = 1;
function credit(partial: Partial<CreditRow>): CreditRow {
  return { kind: "album_credit", id: nextId++, albumId: 142, creditType: "musician", role: "Guitars", target: "p1",
    fromChannel: false, section: null, human: false, ...partial };
}

describe("créditos por bloque del canal", () => {
  it("el canal manda: Guest Musicians es invitado y Musicians es músico", () => {
    const keyboards = credit({ kind: "track_credit", role: "Keyboards", fromChannel: true, section: "guest_musicians" });
    const programming = credit({ creditType: "other", role: "Programming", fromChannel: true, section: "musicians" });
    const ok = credit({ fromChannel: true, section: "musicians" });
    const corrected = credit({ fromChannel: true, section: "guest_musicians", human: true });
    expect(planChannelSections([keyboards, programming, ok, corrected]).map((c) => [c.credit.id, c.action, "to" in c ? c.to : null]))
      .toEqual([[keyboards.id, "retype", "guest"], [programming.id, "retype", "musician"]]);
  });

  it("los músicos de otras fuentes pasan a invitados, salvo el que repite a un principal", () => {
    const asier = credit({ target: "p10", role: "Lead Vocals & Bass", fromChannel: true, section: "musicians" });
    const miguel = credit({ target: "p11", role: "Guitars", fromChannel: true, section: "musicians" });
    const producer = credit({ target: "p20", creditType: "producer", role: "produced", fromChannel: true });
    const miguelSincopa = credit({ target: "p11", role: "Guitars & Backing Vocals" });
    const jonattanSincopa = credit({ target: "p12", role: "Synthesizers" });
    const danielYt = credit({ target: "p13", creditType: "mixing", role: "mixed", fromChannel: true });
    const borisSincopa = credit({ target: "p13", creditType: "mixing", role: "Recorded & Mixed by" });
    const studioSincopa = credit({ target: "o5", creditType: "mastering", role: "Mastered by" });
    const beibiSincopa = credit({ target: "p14", creditType: "other", role: "Kid Cry" });
    const artSincopa = credit({ target: "p15", creditType: "artwork", role: "Diseño" });
    const humanMusician = credit({ target: "p16", human: true });
    const otherAlbum = credit({ albumId: 999, target: "p17" });
    const plan = planOtherSources([asier, miguel, producer, danielYt, miguelSincopa, jonattanSincopa, borisSincopa, studioSincopa, beibiSincopa, artSincopa, humanMusician, otherAlbum]);
    expect(plan.map((c) => [c.credit.id, c.action, "to" in c ? c.to : null])).toEqual([
      [miguelSincopa.id, "retire", null],
      [jonattanSincopa.id, "retype", "guest"],
      // Repite a quien el canal ya acredita en Producción: sobra.
      [borisSincopa.id, "retire", null],
      // El estudio que el canal no menciona, "Otros", el Arte y lo humano se quedan.
    ]);
  });

  it("las pistas hermanas de un crédito del canal heredan su bloque", () => {
    const first = credit({ kind: "track_credit", target: "p12", role: "Keyboards", creditType: "guest", fromChannel: true, section: "guest_musicians" });
    const sibling = credit({ kind: "track_credit", target: "p12", role: "Keyboards" });
    const otherRole = credit({ kind: "track_credit", target: "p12", role: "Synthesizers" });
    const rows = inheritSiblingOrigin([first, sibling, otherRole], [true, false, false]);
    expect(planChannelSections(rows).map((c) => [c.credit.id, "to" in c ? c.to : null])).toEqual([[sibling.id, "guest"]]);
  });
});

describe("fase músicos: disco por disco contra los créditos del disco", () => {
  const people = buildPersonIndex([
    { id: 1, names: ["Asier Cazalis"] }, { id: 2, names: ['Miguel Gonzáles "El Enano"'] }, { id: 3, names: ["Pablo Martínez"] },
    { id: 4, names: ["Jonattan Humpierrez"] }, { id: 5, names: ["Pancho Salazar"] }, { id: 6, names: ["Marguerite Labroid"] },
    { id: 7, names: ['Alejandro Estrada "Alz"'] }, { id: 8, names: ["Alz"] },
  ], ["Tomates Fritos"]);
  let id = 100;
  const mc = (personId: number, personName: string, role: string, extra: Partial<MusicianCredit> = {}): MusicianCredit =>
    ({ kind: "album_credit", id: id++, creditType: "musician", role, personId, personName, trackId: null, human: false, ...extra });
  const entry = (section: "musicians" | "guest_musicians", role: string, name: string, trackNumbers: number[] = []) =>
    ({ section, role, name, trackNumbers });
  const summary = (plan: MusicianChange[]) => plan.map((c) =>
    c.action === "add" ? `add ${c.creditType} ${c.role} ${c.name}` : c.action === "review" ? `review ${c.name}`
      : `${c.action} ${c.credit.personName} ${c.credit.role}${c.action === "retype" ? ` -> ${c.to}` : ""}`);

  it("Harakiri City: principales del canal, invitados con su rol y el rol más completo", () => {
    const credits = [
      mc(1, "Asier Cazalis", "Lead Vocals & Bass"), mc(4, "Jonattan Humpierrez", "Synthesizers"),
      mc(2, 'Miguel Gonzáles "El Enano"', "Guitars"), mc(2, 'Miguel Gonzáles "El Enano"', "Guitars & Backing Vocals"),
      mc(3, "Pablo Martínez", "Drums"), mc(3, "Pablo Martínez", "Drums & Backing Vocals"), mc(5, "Pancho Salazar", "Kid Voice"),
      mc(4, "Jonattan Humpierrez", "Keyboards", { kind: "track_credit", creditType: "guest", trackId: 1 }),
      mc(6, "Marguerite Labroid", "Moaning Woman", { kind: "track_credit", creditType: "guest", trackId: 13 }),
      mc(5, "Pancho Salazar", "Backing Vocals", { kind: "track_credit", creditType: "guest", trackId: 11 }),
    ];
    const plan = planMusicianSections([{ albumId: 142, credits, tracks: new Map([[1, [1]], [11, [11]], [13, [13]]]), entries: [
      entry("musicians", "Lead Vocals & Bass", "Asier Cazalis"), entry("musicians", "Guitars", 'Miguel Gonzáles "El Enano"'),
      entry("musicians", "Drums", "Pablo Martínez"), entry("guest_musicians", "Keyboards", "Jonattan Humpierrez", [1]),
      entry("guest_musicians", "Moaning Woman", "Marguerite Labroid", [13]), entry("guest_musicians", "Backing Vocals", "Pancho Salazar", [11]),
    ] }], people);
    expect(summary(plan).sort()).toEqual([
      "retire Miguel Gonzáles \"El Enano\" Guitars", "retire Pablo Martínez Drums",
      "retype Jonattan Humpierrez Synthesizers -> guest", "retype Pancho Salazar Kid Voice -> guest",
    ]);
  });

  it("un duplicado por apodo no se baja a invitado: se lista", () => {
    const plan = planMusicianSections([{ albumId: 128, tracks: new Map(), entries: [entry("musicians", "Vocals", 'Alejandro Estrada "Alz"')],
      credits: [mc(7, 'Alejandro Estrada "Alz"', "Vocals"), mc(8, "Alz", "Vocals")] }], people);
    expect(summary(plan)).toEqual(["review Alz"]);
  });

  it("crea personas nuevas, pero no conjuntos, palabras sueltas ni artistas", () => {
    const plan = planMusicianSections([{ albumId: 9, tracks: new Map(), credits: [mc(1, "Asier Cazalis", "Vocals")], entries: [
      entry("musicians", "Vocals", "Asier Cazalis"), entry("guest_musicians", "Bass", "Pedro Pérez"),
      entry("guest_musicians", "Strings", "Miami Symphonic Orchestra"), entry("guest_musicians", "Ruso", "Violin"),
      entry("guest_musicians", "Synths", "Tomates Fritos"), entry("guest_musicians", "Bass", "Pedro Pérez"),
    ] }], people);
    expect(summary(plan)).toEqual(["review Miami Symphonic Orchestra", "review Violin", "review Tomates Fritos", "add guest Bass Pedro Pérez"]);
  });

  it("un bloque Musicians que no casa con nadie del disco deja el disco sin tocar", () => {
    const plan = planMusicianSections([{ albumId: 5, tracks: new Map(), credits: [mc(1, "Asier Cazalis", "Vocals")],
      entries: [entry("musicians", "Vocals", "Pedro Pérez")] }], people);
    expect(plan.map((c) => c.action)).toEqual(["review"]);
  });

  it("roleParts separa roles y trata igual singular y plural", () => {
    expect([...roleParts("Drums & Backing Vocals")]).toEqual(["drum", "backing vocal"]);
    expect([...roleParts("Keyboards (tracks 01, 03)")]).toEqual(["keyboard"]);
  });
});

describe("fase otros créditos: producción, composición y arte del canal", () => {
  const catalog = {
    person: buildPersonIndex([{ id: 1, names: ["Daniel Fernández"] }, { id: 2, names: ["Asier Cazalis"] }, { id: 3, names: ["Grabaciones K-Pella"] }], ["Caramelos De Cianuro"]),
    organization: new Map([["grabacioneskpella", new Set([9])]]),
  };
  let id = 500;
  const oc = (target: OtherCredit["target"], creditType: OtherCredit["creditType"], role: string, extra: Partial<OtherCredit> = {}): OtherCredit =>
    ({ kind: "album_credit", id: id++, creditType, role, target, trackId: null, human: false, ...extra });
  const daniel = { kind: "person" as const, id: 1, name: "Daniel Fernández" };
  const kpellaOrg = { kind: "organization" as const, id: 9, name: "Grabaciones K-Pella" };
  const kpellaPerson = { kind: "person" as const, id: 3, name: "Grabaciones K-Pella" };
  const summary = (plan: OtherChange[]) => plan.map((c) =>
    c.action === "add" ? `add ${c.kind} ${c.creditType} ${c.role} ${c.target.kind}:${c.target.id ?? "nueva"}${c.trackId ? ` t${c.trackId}` : ""}`
      : c.action === "review" ? `review ${c.name}` : `retire ${c.credit.target.name} ${c.credit.role}`);

  it("lee la descripción como api-claims: un crédito por verbo y el estudio como organización", () => {
    const facts = channelFacts("Other Credits\n\nRecorded & Mixed by Daniel Fernández at Grabaciones K-Pella (Caracas, Venezuela)\nTracks 02, 04 composed by Asier Cazalis\nIllustrations: Cristian Vigliano");
    expect(facts.map((f) => `${f.targetKind} ${f.creditType} ${f.role} ${f.name} ${f.trackNumbers.join(",")}`)).toEqual([
      "person recording recorded Daniel Fernández ", "organization recording recorded at Grabaciones K-Pella ",
      "person mixing mixed Daniel Fernández ", "organization mixing mixed at Grabaciones K-Pella ",
      "person composer composed Asier Cazalis 2,4", "person artwork illustrations Cristian Vigliano ",
    ]);
  });

  it("rellena lo que falta, elige el estudio y no la persona homónima, y retira el rol contenido", () => {
    const credits = [
      oc(daniel, "recording", "recorded"), oc(daniel, "mixing", "Recorded & Mixed by"), oc(daniel, "mixing", "mixed"),
      oc(kpellaPerson, "mixing", "Recorded & Mixed by"), oc(kpellaOrg, "recording", "recorded at"),
    ];
    const facts: ChannelFact[] = [
      { name: "Daniel Fernández", targetKind: "person", creditType: "recording", role: "recorded", trackNumbers: [] },
      { name: "Daniel Fernández", targetKind: "person", creditType: "mixing", role: "mixed", trackNumbers: [] },
      { name: "Grabaciones K-Pella", targetKind: "organization", creditType: "mixing", role: "mixed at", trackNumbers: [] },
      { name: "Asier Cazalis", targetKind: "person", creditType: "composer", role: "composed", trackNumbers: [2] },
      { name: "Caramelos De Cianuro", targetKind: "person", creditType: "composer", role: "composed", trackNumbers: [] },
      { name: "Cristian Vigliano", targetKind: "person", creditType: "artwork", role: "Illustrations", trackNumbers: [] },
      { name: "Madbox Studio", targetKind: "organization", creditType: "recording", role: "recorded at", trackNumbers: [8] },
    ];
    const plan = planOtherCredits([{ albumId: 142, artist: { id: 7, name: "Caramelos De Cianuro" }, credits, facts,
      tracks: new Map([[2, [22]], [8, [28]]]) }], catalog);
    expect(summary(plan)).toEqual([
      "review Madbox Studio",
      "add album_credit mixing mixed at organization:9",
      "add track_credit composer composed person:2 t22",
      "add album_credit composer composed artist:7",
      "add album_credit artwork Illustrations person:nueva",
      "retire Daniel Fernández mixed",
    ]);
  });

  it("no retira créditos de quien el canal no menciona", () => {
    const other = { kind: "person" as const, id: 2, name: "Asier Cazalis" };
    const plan = planOtherCredits([{ albumId: 1, artist: { id: 7, name: "X" }, tracks: new Map(),
      credits: [oc(other, "producer", "produced"), oc(other, "producer", "Produced by")],
      facts: [{ name: "Daniel Fernández", targetKind: "person", creditType: "mastering", role: "mastered", trackNumbers: [] }] }], catalog);
    expect(summary(plan)).toEqual(["add album_credit mastering mastered person:1"]);
  });

  it("creditRoleParts ignora la preposición y el alcance", () => {
    expect([...creditRoleParts("Track 8 Recorded & Mixed by")]).toEqual(["recorded", "mixed"]);
  });
});
