import { describe, expect, it } from "vitest";
import { QUOTA_COST, SEARCH_MAX_RESULTS, YouTubeDataApi, type FetchLike } from "../../src/youtube/api.js";
import { matchEnrichmentCandidates } from "../../src/youtube/enrich.js";

describe("yt:enrich-artist", () => {
  it("busca solo dentro del canal, con techo de resultados", async () => {
    const urls: URL[] = [];
    const fetcher: FetchLike = async (input) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ items: [{ id: { kind: "youtube#video", videoId: "Q-pRpO2sYSI" } }] }), { status: 200 });
    };
    const api = new YouTubeDataApi("clave-de-prueba", fetcher);
    const found = await api.searchChannelVideos("UCtYlrz6GyvRahlhHjocWQYQ", "Caramelos De Cianuro", 500);
    expect(found.items?.[0]?.id?.videoId).toBe("Q-pRpO2sYSI");
    const url = urls[0]!;
    expect(url.pathname).toBe("/youtube/v3/search");
    expect(url.searchParams.get("channelId")).toBe("UCtYlrz6GyvRahlhHjocWQYQ");
    expect(url.searchParams.get("type")).toBe("video");
    expect(Number(url.searchParams.get("maxResults"))).toBe(SEARCH_MAX_RESULTS);
    expect(QUOTA_COST.search).toBe(100);
  });

  it("una cuota agotada (403) es terminal: una sola llamada y el error no expone la clave", async () => {
    let calls = 0;
    const api = new YouTubeDataApi("AIzaClaveQueNoDebeFiltrarse", async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }), { status: 403 });
    });
    const error: unknown = await api.listVideos(["Q-pRpO2sYSI"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/HTTP 403 .*quotaExceeded/);
    expect((error as Error).message).not.toContain("AIzaClaveQueNoDebeFiltrarse");
    expect(calls).toBe(1);
  });

  it("un 500 aislado se reintenta en vez de perder el lote", async () => {
    let calls = 0;
    const api = new YouTubeDataApi("clave-de-prueba", async () => {
      calls += 1;
      return calls === 1 ? new Response("backend error", { status: 500 }) : new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    await expect(api.listVideos(["Q-pRpO2sYSI"])).resolves.toEqual({ items: [] });
    expect(calls).toBe(2);
  });

  it("rechaza una búsqueda sin canal: nunca se busca en todo YouTube", () => {
    const api = new YouTubeDataApi("clave-de-prueba", async () => new Response("{}"));
    expect(() => api.searchChannelVideos("", "Caramelos De Cianuro")).toThrow(/canal/);
  });

  it("empareja solo artista y título exactos, respetando el año", () => {
    const albums = [
      { albumId: 1, title: "Las Paticas De La Abuela", year: 1992 },
      { albumId: 2, title: "Miss Mujerzuela", year: 2000 },
      { albumId: 3, title: "En Vivo", year: 2009 },
    ];
    const videos = [
      { videoId: "aaaaaaaaaaa", title: "Caramelos De Cianuro - Las Paticas de la Abuela (1992) || Full Album ||" },
      { videoId: "bbbbbbbbbbb", title: "Caramelos De Cianuro - Miss Mujerzuela (2001) || Full Album ||" },
      { videoId: "ccccccccccc", title: "Otra Banda - En Vivo (2009) || Full Album ||" },
      { videoId: "ddddddddddd", title: "Caramelos De Cianuro - En Vivo Remix (2009)" },
    ];
    expect(matchEnrichmentCandidates("Caramelos De Cianuro", albums, videos)).toEqual([
      { albumId: 1, album: "Las Paticas De La Abuela", videoId: "aaaaaaaaaaa", videoTitle: videos[0]!.title },
    ]);
  });
});
