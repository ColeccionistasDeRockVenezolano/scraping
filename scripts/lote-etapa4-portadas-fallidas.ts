// CRV · Etapa 4 del nuevo lote: portadas que no se pudieron descargar (Cover
// Art Archive responde 500) o que dieron error en la cosecha. Brian
// (2026-10-03): reintentar y, si sigue fallando, buscar otra con prioridad
// Spotify > Deezer > MusicBrainz > Discogs. Candidatas revisadas a ojo.
// Un run de operador; después `npm run media:localize`.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-portadas-fallidas.ts
import { closeDb } from "../src/db/client.js";
import { updateEntity, withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Etapa 4 del nuevo lote: portada que Cover Art Archive no sirve (HTTP 500) tomada de Spotify o Deezer (Brian, 2026-10-03)";
const CHANGE: Array<{ albumId: number; source: string; url: string; page: string }> = [
  { albumId: 13300, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b27333e18ff404e066389f7b84db", page: "https://open.spotify.com/album/080bvrS3d0ZPPwlAz3ui1T" },
  { albumId: 13971, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b27396c690e3a754b382236532fb", page: "https://open.spotify.com/album/5kDedzJQM19Y0LLXFe4kfY" },
  { albumId: 14329, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b2733328b94a26a5aaf407686ecc", page: "https://open.spotify.com/album/1hNwmbaMGKSz2lfAfY5ahn" },
  { albumId: 14885, source: "spotify", url: "https://i.scdn.co/image/ab67616d0000b27338432dd1f74c79361208a4a9", page: "https://open.spotify.com/album/5glSLBXp10avfdvipArFHD" },
  // En Spotify, «A Cuerpo Cobarde» es un tributo de Afro Criollo; Chino & Nacho está restringido.
  { albumId: 14838, source: "deezer", url: "https://cdn-images.dzcdn.net/images/cover/b1230373ca473b136e217cc63cb0cbb7/1000x1000-000000-80-0-0.jpg", page: "https://www.deezer.com/album/97009082" },
  { albumId: 13277, source: "deezer", url: "https://cdn-images.dzcdn.net/images/cover/1a3b28be3bbb181955dac4cfe9bd8982/1000x1000-000000-80-0-0.jpg", page: "https://www.deezer.com/album/241656142" },
];

async function main(): Promise<void> {
  const { runId, result } = await withOperatorRun({ name: "cover_upgrade", operator: "brian", note: NOTE, params: { lote: "nuevo-lote-2026-10-02", etapa: 4 } }, async (context) => {
    const out: string[] = [];
    for (const item of CHANGE) {
      const written = await updateEntity(context, "album", item.albumId, { cover_url: item.url });
      out.push(`${item.albumId} ${item.source} ${written.fields[0]?.action} ${item.page}`);
    }
    return out;
  });
  console.log(`run ${runId}\n${result.join("\n")}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
