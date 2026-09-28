// CRV · Filas de los libros de evidencia que ningún aplicador usa aunque la
// identidad case por nombre: ni apply-source-genres las confirma ni
// source-over-laya deshace a Laya por ellas. Clave `<fuente>|<caseId>`.
export const SKIP_SOURCE_ROWS = new Set([
  // 2026-09-27 · MusicBrainz etiqueta de «spoken word» los discos de Domingo En
  // Llamas (etiquetas de usuario) y su «Blackstone» parece otra banda que la de RHV.
  "musicbrainz|artist:919",
  ...[2659, 2686, 2980, 3181, 3182, 3183, 3184].map((id) => `musicbrainz|album:${id}`),
  // 2026-09-27 · El «Trujillo» del catálogo sale de «Metalkinesia – capítulo
  // Trujillo» (RHV, metal del estado Trujillo); el de Last.fm es Andrés Astorga,
  // DJ de house venezolano con el mismo nombre.
  "lastfm|artist:2726",
  // 2026-09-27 · Last.fm agrupa discografías por nombre: compartir un título
  // con el catálogo no prueba que sus etiquetas pertenezcan a nuestra banda.
  // Las biografías de estas páginas describen expresamente otros artistas
  // (Estados Unidos, Canadá, Argentina, Europa, Sudáfrica o México).
  // Coupe y Aeroclub no tienen biografía útil; sus etiquetas son de artistas
  // ruso y alemán respectivamente, ajenos al catálogo venezolano.
  ...[121, 312, 563, 677, 760, 929, 972, 1330, 1465, 1482, 1556, 1559, 1701, 1864]
    .map((id) => `lastfm|artist:${id}`),
  // 2026-09-28 · Revisión a mano de las 75 fichas casadas por discografía o
  // integrante (sin marca venezolana): la página de Last.fm mezcla homónimos o
  // es de otro artista. Brasil (Eternal Sorrow 504, Aeroplano 1040, Eduardo
  // 1924, Stalingrado 909, Difuntos 751), Islandia (Hekla 738), Eslovenia (Sur
  // 1048), Japón (KBB 1982), Girona (Paralelo 1580), Filadelfia (Sitcom 1578),
  // País Vasco (Anestesia 1750), Lima (Los Polaroid 1507), Portugal (Mancha
  // Negra 1815), EE. UU. (Nomad Theory 330, 3 Words 1447), Polonia (Mind The
  // Gap 1368, Dondi 1792, Ramas 1931), Finlandia (Bajo Cero 531), Sudáfrica
  // (The Ministers 1590), República Dominicana (Trece 1535), Alemania (Chaos
  // Descends 1521); y páginas con discos ajenos mezclados (Cangrejo 56, Punto De
  // Partida 201, Zatrarath 839, Piolet 1160, BrainX 1795, The Hangover 1516,
  // Terra Nullius 336, Triciclo 303, Demolicion 798, Bluff 1558).
  ...[56, 201, 303, 330, 336, 504, 531, 738, 751, 798, 839, 909, 1040, 1048, 1160, 1368, 1447, 1507, 1516,
    1521, 1535, 1558, 1578, 1580, 1590, 1750, 1792, 1795, 1815, 1924, 1931, 1982]
    .map((id) => `lastfm|artist:${id}`),
  // «Bolívar» llevó a la biografía de Simón Bolívar y «Chaima» al pueblo
  // indígena, no a las bandas del catálogo. Ninguno de esos textos es prueba
  // musical para Laya.
  "wikipedia-en|artist:402",
  "wikipedia-es|artist:874",
]);
