// CRV · Artistas de Sincopa con el nombre truncado a una letra (Brian,
// 2026-10-03: «fusiona los artistas truncados»). En el HTML de Sincopa el
// nombre llega partido en dos piezas («L a / Fe», «E lisa Rego») y la ingesta
// guardó solo la primera letra, como «La Banda de» (run 11795). Cada ficha
// truncada repite discos que ya estaban bien en el artista real.
//
//   · «L» (3790) mezclaba tres artistas: Los Blanco (3719), Laberinto (141) y La Fé (1231).
//   · «E» (4041) → Elisa Rego (1928) · «G» (4046) → Paul Gillman (1951) · «A» (4329) → Al Zeppy (1861).
//
// Primero cada disco duplicado se fusiona en su gemelo del artista real (las
// pistas y créditos que solo tenía la copia pasan al gemelo); después la ficha
// truncada se fusiona en el artista real SIN dejar la letra como alias. Todo
// en UN run de operador. Sin --confirm corre entero y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/fix-sincopa-artistas-truncados.ts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Sincopa: artista con el nombre truncado a una letra fusionado en el real, con sus discos duplicados (Brian, 2026-10-03)";

// Disco de la ficha truncada → su gemelo en el artista real.
const TWINS: Record<number, number> = {
  // L → Los Blanco (3719)
  8202: 7311, 8225: 7335, 8218: 7328, 8196: 7305, 8203: 7312, 8194: 7303, 8207: 7316, 8198: 7307, 8208: 7317,
  8210: 7319, 8188: 7297, 8190: 7299, 8197: 7306, 8206: 7315, 8211: 7320, 8215: 7325, 8195: 7304, 8213: 7322,
  8186: 7295, 8223: 7333, 8224: 7334, 8226: 7336, 8214: 7323, 8204: 7313, 8209: 7318, 8200: 7309, 8212: 7321,
  8187: 7296, 8193: 7302, 8220: 7330, 8205: 7314, 8189: 7298, 8191: 7300,
  8192: 7301, 8199: 7308, 8201: 7310, 8219: 7329, 8222: 7332, 8217: 7327,
  // L → Laberinto (141)
  9982: 73, 9983: 233, 9984: 232, 9970: 1240, 9985: 230, 9986: 231, 9987: 1237, 9988: 1239, 9940: 4369,
  // L → La Fé (1231)
  9962: 2188, 9936: 4361,
  // E → Elisa Rego (1928)
  9934: 4026, 9922: 4028, 9938: 4029, 9924: 4027, 9933: 4031,
  // G → Paul Gillman (1951)
  9956: 2157, 9961: 3060, 9953: 2135, 9957: 3059, 9954: 2020, 9955: 2133,
  // A → Al Zeppy (1861)
  15278: 4628,
};
// Ficha truncada → artista real que la absorbe (lo que quede: «Los Blanco» de 1976, 15400).
const ARTISTS: Array<[drop: number, keep: number]> = [[3790, 3719], [4041, 1928], [4046, 1951], [4329, 1861]];

class DryRun extends Error {
  constructor(readonly lines: string[]) { super("dry-run"); }
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  let runId: number | null = null;
  let lines: string[];
  try {
    const done = await withOperatorRun({ name: "merge_entities", operator: "brian", note: NOTE, params: { kind: "artist", truncatedSincopa: ARTISTS } }, async (context) => {
      const out: string[] = [];
      // Ningún disco de las fichas truncadas puede quedar sin destino.
      const albums = await context.client.query<{ id: string; artist_id: string; title: string }>(
        "SELECT id::text, artist_id::text, title FROM public.albums WHERE artist_id = ANY($1)", [ARTISTS.map(([drop]) => drop)]);
      const loose = albums.rows.filter((row) => TWINS[Number(row.id)] === undefined);
      for (const row of loose) out.push(`- disco ${row.id} «${row.title}» sin gemelo: pasa con la ficha ${row.artist_id} al artista real`);
      for (const [drop, keep] of Object.entries(TWINS).map(([d, k]) => [Number(d), k] as const)) {
        const preview = await previewAlbumMerge(context.client, keep, drop, { lock: true });
        const result = await mergeAlbums(context, { keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: preview.keep.title !== preview.drop.title });
        out.push(`- disco ${drop} «${preview.drop.title}» → ${keep} «${preview.keep.title}» (${preview.keep.artistName}): ${result.tracksMerged} pistas unidas, ${result.tracksMoved} movidas, ${result.creditsMerged} créditos`);
      }
      for (const [drop, keep] of ARTISTS) {
        const preview = await previewEntityMerge(context.client, "artist", keep, drop, { lock: true });
        const result = await mergeEntities(context, { kind: "artist", keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: false });
        out.push(`- artista ${drop} «${preview.drop.name}» → ${keep} «${preview.keep.name}»: ${result.moved} movidos, campos ${result.filled.join(", ") || "—"}`);
      }
      if (!confirm) throw new DryRun(out);
      return out;
    });
    runId = done.runId;
    lines = done.result;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    lines = error.lines;
  }
  const mode = confirm ? "confirm" : "dry-run";
  const file = `reports/sincopa-artistas-truncados-2026-10-03-${mode}${runId ? `-run${runId}` : ""}.md`;
  writeFileSync(file, [`# Sincopa: artistas truncados a una letra (${mode}${runId ? `, run ${runId}` : ""})`, "", NOTE, "", ...lines, ""].join("\n"));
  console.log(`${lines.length} operaciones → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
