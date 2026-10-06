// RYM «nuevos» · alias de géneros obvios (Brian 2026-10-05: «te paso la lista»): los términos de
// RYM que son sinónimo o hijo claro de un género que ya existe pasan como alias; los demás NO se
// tocan (lista para Brian en reports/rym-nuevos-aplicacion-2026-10-05/generos-sin-mapear.md).
// Un solo run de taxonomía; sin --confirm se revierte.
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/alias-generos-rym.mts [--confirm]
import { closeDb } from "../../src/db/client.js";
import { applyTaxonomyOperations, type TaxonomyOperation } from "../../src/genres/admin.js";

const MAPA: Record<string, string[]> = {
  "synth-pop": ["Synthpop"],
  "latin-electronic-fusion": ["Latin Electronic"],
  "hip-hop": ["Conscious Hip Hop", "Political Hip Hop", "Hardcore Hip Hop", "Lo-Fi Hip Hop", "Latin Rap", "Cloud Rap", "Emo Rap", "Horrorcore"],
  "r-and-b": ["Alternative R&B"],
  "musica-clasica": ["Classical Music", "Orchestral Music", "Romanticism", "Spanish Classical Music", "Latin American Classical Music", "Concerto", "Ballet"],
  "jazz": ["Free Jazz", "Post-Bop"],
  "house": ["Progressive House", "Electro House"],
  "tech-house": ["Deep Tech"],
  "techno": ["Melodic Techno", "Industrial Techno"],
  "trance": ["Psytrance"],
  "metal-experimental": ["Avant-Garde Metal"],
  "doom-metal": ["Death Doom Metal"],
  "reggaeton": ["Neoperreo"],
  "urbano-latino": ["Dembow", "RKT"],
  "balada": ["Canción melódica"],
  "soca": ["Chutney Soca"],
  "pop": ["Teen Pop", "Boy Band"],
  "electropop": ["Hyperpop", "Glitch Pop"],
  "reggae": ["Pop Reggae"],
  "folk": ["Indie Folk"],
  "indie-rock": ["Slacker Rock"],
  "industrial": ["Martial Industrial"],
  "dance": ["Electronic Dance Music"],
  "electronica": ["Breakbeat", "Breakcore", "UK Bass", "Deconstructed Club", "Hardcore [EDM]", "Digital Hardcore", "Guaracha [EDM]", "Glitch Hop", "Wonky"],
  "rock": ["Comedy Rock"],
};
const ops: TaxonomyOperation[] = Object.entries(MAPA).flatMap(([target, terms]) =>
  terms.map((alias) => ({ op: "set_alias" as const, alias, target, notes: "término de Rate Your Music (RYM «nuevos» 2026-10-05)" })));
const report = await applyTaxonomyOperations(ops, {
  actor: "claude-code (delegado por Brian)",
  reason: "Alias obvios de los géneros de RYM «nuevos» hacia géneros existentes; sin géneros nuevos (Brian 2026-10-05)",
}, { confirm: process.argv.includes("--confirm") });
console.log(JSON.stringify({ mode: report.mode, runId: report.runId, operaciones: report.operations.length }, null, 1));
await closeDb();
