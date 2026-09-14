import { describe, expect, it } from "vitest";
import { matchTracklist, planReconciliation, type ReconcileSnapshot, type SnapshotTrack, type SnapshotVideo } from "../../src/youtube/reconcile.js";

const video = (dbId: number, videoId: string, title: string | null, extra: Partial<SnapshotVideo> = {}): SnapshotVideo =>
  ({ dbId, videoId, title, durationSeconds: 900, seed: null, tracklist: [], ...extra });
const track = (id: number, albumId: number, trackNumber: number, title: string, youtubeStartSeconds: number | null = null): SnapshotTrack =>
  ({ id, albumId, discNumber: 1, trackNumber, title, youtubeStartSeconds });

// Caramelos De Cianuro y el caso de aceptación, más los casos límite reales
// que la base de desarrollo mostró (videoclip en varios discos, concierto de
// la hoja sin separador en el título, pieza editorial).
function snapshot(): ReconcileSnapshot {
  return {
    artists: [{ id: 1, name: "Caramelos De Cianuro" }, { id: 2, name: "Candy66" }, { id: 3, name: "Metrozubdivision" }, { id: 4, name: "Salpachino" }, { id: 5, name: "Zapato 3" }],
    aliases: [{ artistId: 2, alias: "Candy 66" }],
    albums: [
      { id: 10, artistId: 1, title: "Las Paticas De La Abuela", year: 1992, type: "ep" },
      { id: 11, artistId: 1, title: "Miss Mujerzuela", year: 2000, type: "studio_album" },
      { id: 20, artistId: 2, title: "P.O.P.", year: 2001, type: "studio_album" },
      { id: 21, artistId: 2, title: "En Vivo", year: 2003, type: "other" },
      { id: 30, artistId: 3, title: "CCS", year: 2007, type: "live_album" },
      { id: 40, artistId: 4, title: "Reina Contra La Máquina", year: 2011, type: "studio_album" },
    ],
    tracks: [
      track(100, 10, 1, "Chan², Chaca², Chan²", 0), track(101, 10, 2, "Tu Mamá Te Va a Pegar", 247),
      track(102, 10, 3, "La Bruja", 475), track(103, 10, 4, "Nadando a Través De La Galaxia", 615),
      track(200, 20, 1, "Solo"), track(201, 21, 1, "Solo"), track(400, 40, 1, "Nosferatu"),
    ],
    links: [{ videoDbId: 1, albumId: 10, albumKind: "full_album", isPrimary: true, sourceId: 12 }],
    videos: [
      video(1, "Q-pRpO2sYSI", "Caramelos De Cianuro - Las Paticas De La Abuela (1992) || Full Album ||", {
        durationSeconds: 940,
        tracklist: [
          { position: 0, title: "Chan², Chaca², Chan²", startSeconds: 0 }, { position: 1, title: "Tu Mama Te Va A Pegar", startSeconds: 247 },
          { position: 2, title: "La Bruja*", startSeconds: 475 }, { position: 3, title: "Nadando a Través De La Galaxia", startSeconds: 615 },
        ],
      }),
      video(2, "uwTM_olKdj0", "Salpachino - Nosferatu (Official 4K Video)", { durationSeconds: 161, seed: { uploadOrder: 600, artist: "Salpachino", album: "Nosferatu", normalizedType: "music_video" } }),
      video(3, "ncvnMbYmC3g", "Candy66 - Solo (Official 4K Video)", { seed: { uploadOrder: 601, artist: "Candy66", album: "Solo", normalizedType: "music_video" } }),
      video(4, "Jza1_KAtBZI", "Metrozubdivision Live From @MuseoDeBellasArtes (2006) || Full Concert ||", { seed: { uploadOrder: 584, artist: "Metrozubdivision", album: "CCS", normalizedType: "live_concert" } }),
      video(5, "zNdcRR1rBZE", "Babylon Motorhome, disponible mañana en el canal. Reseña por @nuevasbandas"),
      video(6, "QcnD-UIl0N8", null, { durationSeconds: null, seed: { uploadOrder: 559, artist: "Zapato 3", album: "Detrás De La Puerta", normalizedType: "documentary" } }),
      video(7, "aaaaaaaaaaa", "Candy 66 - Miss Mujerzuela (2000) || Full Album ||", { seed: { uploadOrder: 602, artist: "Caramelos De Cianuro", album: "Miss Mujerzuela", normalizedType: "studio_album" } }),
    ],
  };
}

const verdictOf = (videoId: string) => planReconciliation(snapshot()).verdicts.find((verdict) => verdict.videoId === videoId)!;

describe("yt:reconcile — plan determinista", () => {
  it("relaciona Las Paticas De La Abuela con su artista y sus cuatro pistas por timestamp", () => {
    const plan = planReconciliation(snapshot());
    expect(verdictOf("Q-pRpO2sYSI")).toMatchObject({ kind: "full_album", category: "MATCHED_HIGH", artists: ["Caramelos De Cianuro"] });
    expect(plan.videoArtists).toContainEqual({ videoDbId: 1, artistId: 1, relationKind: "performer", via: "album_link", linkSourceId: 12 });
    expect(plan.videoTracks.filter((row) => row.videoDbId === 1).map(({ trackId, startSeconds, endSeconds }) => ({ trackId, startSeconds, endSeconds }))).toEqual([
      { trackId: 100, startSeconds: 0, endSeconds: 247 }, { trackId: 101, startSeconds: 247, endSeconds: 475 },
      { trackId: 102, startSeconds: 475, endSeconds: 615 }, { trackId: 103, startSeconds: 615, endSeconds: 940 },
    ]);
  });

  it("un videoclip con una sola canción homónima se escribe; con varias, propone la de estudio sin escribir", () => {
    const plan = planReconciliation(snapshot());
    expect(verdictOf("uwTM_olKdj0").category).toBe("MATCHED_HIGH");
    expect(plan.videoTracks).toContainEqual({ videoDbId: 2, videoId: "uwTM_olKdj0", trackId: 400, startSeconds: 0, endSeconds: 161, via: "sheet" });
    const solo = verdictOf("ncvnMbYmC3g");
    expect(solo.category).toBe("MATCHED_MEDIUM");
    expect(solo.proposals).toEqual([expect.objectContaining({ kind: "track", id: 200 })]);
    expect(plan.videoTracks.some((row) => row.videoDbId === 3)).toBe(false);
  });

  it("un concierto nunca crea disco: toma el artista de la hoja y solo propone el disco homónimo", () => {
    const plan = planReconciliation(snapshot());
    const concert = verdictOf("Jza1_KAtBZI");
    expect(concert).toMatchObject({ kind: "live_concert", category: "MATCHED_MEDIUM", artists: ["Metrozubdivision"] });
    expect(concert.proposals).toEqual([expect.objectContaining({ kind: "album", id: 30 })]);
    expect(plan.videoArtists).toContainEqual({ videoDbId: 4, artistId: 3, relationKind: "performer", via: "sheet", linkSourceId: null });
  });

  it("no inventa relaciones para piezas editoriales y registra el documental sin metadatos", () => {
    const plan = planReconciliation(snapshot());
    expect(verdictOf("zNdcRR1rBZE")).toMatchObject({ kind: "editorial", category: "UNMATCHED_VIDEO" });
    expect(plan.videoArtists.some((row) => row.videoDbId === 5)).toBe(false);
    const documentary = verdictOf("QcnD-UIl0N8");
    expect(documentary).toMatchObject({ kind: "documentary", category: "MATCHED_HIGH" });
    expect(plan.videoArtists).toContainEqual({ videoDbId: 6, artistId: 5, relationKind: "subject", via: "sheet", linkSourceId: null });
  });

  it("si la hoja y el título nombran artistas distintos es un conflicto y no se escribe nada", () => {
    const plan = planReconciliation(snapshot());
    expect(verdictOf("aaaaaaaaaaa").category).toBe("CONFLICT");
    expect(plan.videoArtists.some((row) => row.videoDbId === 7)).toBe(false);
  });

  it("lista cada disco sin video y marca si su artista está en el canal", () => {
    const unmatched = planReconciliation(snapshot()).unmatchedAlbums;
    expect(unmatched.map((album) => album.albumId)).toEqual([11, 20, 21, 30, 40]);
    expect(unmatched.find((album) => album.albumId === 11)!.artistOnChannel).toBe(true);
  });
});

describe("matchTracklist", () => {
  it("usa la posición solo para desempatar pistas homónimas y reporta lo que no casa", () => {
    const tracks = [track(1, 9, 1, "Intro"), track(2, 9, 2, "Ceniza", 60), track(3, 9, 6, "Ceniza", 300)];
    const result = matchTracklist([
      { position: 1, title: "Ceniza", startSeconds: 61 }, { position: 4, title: "Cenizas", startSeconds: 200 },
      { position: 5, title: "Ceniza", startSeconds: 300 }, { position: 6, title: "Ceniza", startSeconds: 400 },
    ], tracks, 500, true);
    expect(result.occurrences).toEqual([
      { trackId: 2, startSeconds: 61, endSeconds: 200 }, { trackId: 3, startSeconds: 300, endSeconds: 400 },
    ]);
    expect(result.unmatched).toEqual(["Cenizas", "Ceniza (varias pistas homónimas y ninguna en la posición 7)"]);
    expect(result.startMismatches).toEqual([{ trackId: 2, title: "Ceniza", core: 60, video: 61 }]);
  });
});
