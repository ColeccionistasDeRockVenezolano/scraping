// CRV · Barrido de artistas duplicados y con nombre roto (Brian, 2026-10-04,
// decisiones por preguntas):
//
//   · duplicados por artículo o «&» → fusión en la ficha con más datos, con
//     sus discos gemelos (El Arca/Arca NO: son bandas distintas);
//   · «"El Pavo" Frank» → «"El Pavo" Frank Hernández»;
//   · nombres «A / B» del mismo artista → nombre principal + alias (los que son
//     dos artistas o banda + director quedan para Brian, ver DOUBLE);
//   · fichas basura sin discos: «R» se borra; las dos «listas de orquestas»
//     acompañantes de Mirla Castellanos pasan a nota del disco y se borran.
//     «Ex K La» se queda: es una banda real (Pepsi Music: Pide Más);
//   · alias de una letra que dejó la fusión de los truncados de Sincopa (run 11807).
//
// UN run de operador. Sin --confirm corre entero y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/fix-artistas-duplicados-2026-10-04.ts [--confirm]
import { writeFileSync } from "node:fs";
import { createAlias, deleteAlias } from "../src/api/repositories/aliases.js";
import { closeDb } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { deleteEntity, deleteRelation, updateEntity, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";

const NOTE = "Barrido de artistas duplicados y nombres rotos (Brian, 2026-10-04)";

// Ficha que desaparece → ficha que queda (la del nombre limpio). Los discos
// gemelos se emparejan por título normalizado: mismo año, o un único
// candidato a ±1 año. Lo dudoso (varias ediciones con el mismo título) no se
// fusiona y queda en el informe.
const MERGES: Array<{ drop: number; keep: number; aliases?: string[] }> = [
  { drop: 4364, keep: 3623 }, // VNote Ensemble
  { drop: 3872, keep: 3848 }, // Rondalla Venezolana
  { drop: 4641, keep: 1965 }, // Homer & The Dont's
  { drop: 4561, keep: 535 }, // Zumo
  { drop: 3719, keep: 3791, aliases: ["Sexteto Los Blanco"] }, // Los Blanco (3719 «Los Blanco / Sexteto Los Blanco»)
  { drop: 3600, keep: 3601 }, // «El Pavo» Frank Hernández
  { drop: 3366, keep: 3376, aliases: ["Di Donna"] },
  { drop: 3701, keep: 3785, aliases: ["El Bolerista de América"] },
  { drop: 3714, keep: 4343, aliases: ["Grupo Kurare"] },
  { drop: 3828, keep: 3880, aliases: ["Juan Galea y Su Grupo"] },
  { drop: 3496, keep: 3649, aliases: ["Gaby Vivas"] },
  { drop: 3682, keep: 3764, aliases: ["Billos"] },
  { drop: 3846, keep: 3870, aliases: ["Reina Lucero"] },
];
// Nombre «A / B» sin ficha limpia: se renombra y el resto pasa a alias.
const RENAMES: Array<{ id: number; name: string; aliases: string[] }> = [
  { id: 3699, name: "Esteban Demián", aliases: ["Steven Damian"] },
];
// Dos artistas en una ficha, o banda + director: decide Brian.
const DOUBLE = [3365, 3720, 3723, 3516, 3552, 4042, 890, 351, 793];
const DELETE_EMPTY = [3246];
const ORCHESTRA_LISTS = [4422, 4423];
const LETTER_ALIASES = [1861, 1928, 1951, 3791];

class DryRun extends Error {
  constructor(readonly lines: string[]) { super("dry-run"); }
}

async function aliasesOf(context: OperatorContext, artistId: number): Promise<Array<{ id: number; alias: string }>> {
  const { rows } = await context.client.query<{ id: string; alias: string }>("SELECT id::text, alias FROM ingest.artist_aliases WHERE artist_id=$1", [artistId]);
  return rows.map((row) => ({ id: Number(row.id), alias: row.alias }));
}

const titleKey = (title: string): string => title.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();

async function findTwins(context: OperatorContext, keep: number, drop: number): Promise<{ pairs: Array<[number, number]>; doubtful: number[] }> {
  const { rows } = await context.client.query<{ id: string; artist_id: string; title: string; release_year: number | null }>(
    "SELECT id::text, artist_id::text, title, release_year FROM public.albums WHERE artist_id = ANY($1)", [[keep, drop]]);
  const keepAlbums = rows.filter((row) => Number(row.artist_id) === keep);
  const pairs: Array<[number, number]> = [];
  const doubtful: number[] = [];
  const used = new Set<number>();
  for (const album of rows.filter((row) => Number(row.artist_id) === drop)) {
    const same = keepAlbums.filter((other) => titleKey(other.title) === titleKey(album.title) && !used.has(Number(other.id)));
    if (!same.length) continue;
    const exact = same.filter((other) => other.release_year === album.release_year);
    const near = same.filter((other) => other.release_year === null || album.release_year === null || Math.abs(other.release_year - album.release_year) <= 1);
    const twin = exact.length === 1 ? exact[0] : exact.length === 0 && same.length === 1 && near.length === 1 ? near[0] : undefined;
    if (!twin) { doubtful.push(Number(album.id)); continue; }
    used.add(Number(twin.id));
    pairs.push([Number(album.id), Number(twin.id)]);
  }
  return { pairs, doubtful };
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  let runId: number | null = null;
  let lines: string[];
  try {
    const done = await withOperatorRun({ name: "merge_entities", operator: "brian", note: NOTE, params: { kind: "artist" } }, async (context) => {
      const out: string[] = ["## Fusiones", ""];
      for (const merge of MERGES) {
        const twins = await findTwins(context, merge.keep, merge.drop);
        for (const doubt of twins.doubtful) out.push(`- disco ${doubt} sin fusionar: varias ediciones posibles`);
        for (const [drop, keep] of twins.pairs) {
          const preview = await previewAlbumMerge(context.client, keep, drop, { lock: true });
          const result = await mergeAlbums(context, { keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: preview.keep.title !== preview.drop.title });
          out.push(`- disco ${drop} «${preview.drop.title}» (${preview.drop.fields["release_year"] ?? "s/a"}) → ${keep} «${preview.keep.title}» (${preview.keep.fields["release_year"] ?? "s/a"}): ${result.tracksMerged} pistas unidas, ${result.tracksMoved} movidas`);
        }
        const preview = await previewEntityMerge(context.client, "artist", merge.keep, merge.drop, { lock: true });
        const result = await mergeEntities(context, { kind: "artist", keepId: merge.keep, dropId: merge.drop, previewHash: preview.previewHash, keepDropNameAsAlias: !preview.drop.name.includes("/") });
        for (const alias of await aliasesOf(context, merge.keep)) {
          if (alias.alias.includes("/") && alias.alias !== "20/20") await deleteAlias(context, "artist", merge.keep, alias.id);
        }
        const now = new Set((await aliasesOf(context, merge.keep)).map((alias) => alias.alias));
        for (const alias of merge.aliases ?? []) {
          if (!now.has(alias)) await createAlias(context, "artist", merge.keep, { alias, aliasType: "name_variant", isPrimary: false });
        }
        out.push(`- **artista ${merge.drop} «${preview.drop.name}» → ${merge.keep} «${preview.keep.name}»**: ${result.moved} movidos, ${twins.pairs.length} discos gemelos${merge.aliases ? `, alias ${merge.aliases.map((alias) => `«${alias}»`).join(", ")}` : ""}`);
      }
      out.push("", "## Nombres «A / B» → nombre + alias", "");
      for (const rename of RENAMES) {
        const before = await aliasesOf(context, rename.id);
        await updateEntity(context, "artist", rename.id, { name: rename.name });
        for (const alias of await aliasesOf(context, rename.id)) {
          if (alias.alias.includes("/")) await deleteAlias(context, "artist", rename.id, alias.id);
        }
        const now = new Set((await aliasesOf(context, rename.id)).map((alias) => alias.alias));
        for (const alias of rename.aliases) {
          if (!now.has(alias)) await createAlias(context, "artist", rename.id, { alias, aliasType: "name_variant", isPrimary: false });
        }
        out.push(`- ${rename.id}: «${before.find((alias) => alias.alias.includes("/"))?.alias ?? "?"}» → «${rename.name}» + alias ${rename.aliases.map((alias) => `«${alias}»`).join(", ")}`);
      }
      out.push("", "## Fichas basura", "");
      for (const id of ORCHESTRA_LISTS) {
        const credits = await context.client.query<{ id: string; album_id: string; role: string; name: string; notes: string | null }>(`
          SELECT c.id::text, c.album_id::text, c.role, ar.name, al.notes
            FROM public.album_credits c JOIN public.artists ar ON ar.id=c.artist_id JOIN public.albums al ON al.id=c.album_id
           WHERE c.artist_id=$1`, [id]);
        for (const credit of credits.rows) {
          const text = `Acompañada por: ${credit.name.trim()} (lista recortada en la fuente)`;
          await updateEntity(context, "album", Number(credit.album_id), { notes: credit.notes ? `${credit.notes}\n${text}` : text });
          await deleteRelation(context, "album_credit", Number(credit.id));
          out.push(`- crédito ${credit.id} («${credit.role}») del disco ${credit.album_id} → nota del disco`);
        }
        await deleteEntity(context, "artist", id);
        out.push(`- artista ${id} borrado`);
      }
      for (const id of DELETE_EMPTY) {
        await deleteEntity(context, "artist", id);
        out.push(`- artista ${id} borrado (sin discos, créditos ni miembros)`);
      }
      out.push("", "## Alias de una letra (fusión de los truncados de Sincopa)", "");
      for (const artistId of LETTER_ALIASES) {
        for (const alias of await aliasesOf(context, artistId)) {
          if (alias.alias.trim().length <= 1) {
            await deleteAlias(context, "artist", artistId, alias.id);
            out.push(`- artista ${artistId}: alias «${alias.alias}» quitado`);
          }
        }
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
  const file = `reports/artistas-duplicados-2026-10-04-${mode}${runId ? `-run${runId}` : ""}.md`;
  writeFileSync(file, [`# Artistas duplicados y nombres rotos (${mode}${runId ? `, run ${runId}` : ""})`, "", NOTE, "", ...lines, "",
    "## Para Brian: dos artistas en una ficha o banda + director", "", `Fichas ${DOUBLE.join(", ")}: no se tocan.`, ""].join("\n"));
  console.log(`→ ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
