// RYM «nuevos» · géneros que quedaron sin mapear tras el run 16902 (Brian 2026-10-06: «crear 2 +
// 2.ª pasada (2026-10-06, tras la corrección por prefijo): Cumbia salvadoreña, Cool Jazz, Steel Band y Wave.
// alias al padre»). Se crean «Changa tuki» (género caraqueño, 57 fichas) y «Emo»; el resto pasa
// como alias al género existente más cercano y lo que no es música queda `not_a_genre`.
// Un run de taxonomía; sin --confirm se revierte. Después: apply-source-genres con los mismos libros.
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/generos-sin-mapear.mts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { applyTaxonomyOperations, type TaxonomyOperation } from "../../src/genres/admin.js";

const NUEVOS: TaxonomyOperation[] = [
  { op: "create_genre", slug: "changa-tuki", name: "Changa tuki", level: "genre", parentSlug: "electronica",
    description: "Música electrónica de baile nacida en los barrios de Caracas a mediados de los 2000 (tuki)." },
  { op: "create_genre", slug: "emo", name: "Emo", level: "genre", parentSlug: "punk",
    description: "Derivado del hardcore punk centrado en la expresión emocional; incluye midwest emo y screamo." },
];

const MAPA: Record<string, string[]> = {
  "changa-tuki": ["Changa tuki"],
  "emo": ["Emo", "Midwest Emo", "Screamo", "Emocore", "Mall Screamo"],
  "pop": ["Bedroom Pop", "Adult Contemporary", "Afrobeats", "Levenslied", "Vocal Group", "Musical Parody"],
  "electronica": ["Synthwave", "Darksynth", "Horror Synth", "Chillsynth", "Vaporwave", "Hardvapour", "Progressive Electronic",
    "Berlin School", "Trap [EDM]", "HexD", "Kuduro", "Future Bass", "Future Garage", "Jersey Club", "Breakbeat Hardcore",
    "Speedcore", "Early Hardstyle", "Neo Rave", "Indietronica", "Mashup", "Wave"],
  "darkwave": ["Minimal Synth"],
  "dark-ambient": ["Dungeon Synth"],
  "chillwave": ["Hypnagogic Pop"],
  "ambient": ["Space Ambient", "Tribal Ambient"],
  "musica-clasica": ["Modern Classical", "Impressionism", "Symphony", "Tone Poem", "Sonata", "Classical Crossover",
    "Classical Period", "Cinematic Classical", "Minimalism"],
  "musica-antigua": ["Baroque Music", "Baroque Suite", "Renaissance Music", "Franco-Flemish School"],
  "musica-sacra": ["Polyphonic Chant", "Mass", "Oratorio", "Passion"],
  "opera": ["Opera seria", "Operetta", "Zarzuela grande"],
  "soca": ["Chutney", "Power Soca"],
  "musica-navidena": ["Parang", "Christmas Music"],
  "avant-garde": ["Free Improvisation", "Reductionism", "Modern Creative"],
  "electroacustica": ["EAI", "Sound Collage", "Plunderphonics", "Musique concrète"],
  "noise": ["Harsh Noise", "Harsh Noise Wall", "Ambient Noise Wall", "Power Electronics"],
  "industrial": ["Power Noise", "Death Industrial"],
  "spoken-word": ["Poetry", "Jazz Poetry"],
  "jazz": ["Jazz Pop", "Vocal Jazz", "New Jazz", "Avant-Garde Jazz", "Jazz manouche", "Cool Jazz"],
  "big-band": ["Swing Revival"],
  "easy-listening": ["Exotica", "Light Music"],
  "soft-rock": ["Yacht Rock"],
  "pop-rock": ["Piano Rock"],
  "art-pop": ["Chamber Pop"],
  "rap-metal": ["Trap Metal"],
  "trap": ["Hard Trap", "Plugg"],
  "drill": ["UK Drill"],
  "hip-hop": ["Jerk", "Tread", "No Melody", "Instrumental Hip Hop", "Drumless", "Comedy Rap", "Phonk"],
  "electropop": ["Digicore", "Electroclash"],
  "rap-experimental": ["Abstract Hip Hop"],
  "musica-tradicional": ["Hispanic American Folk Music", "Caribbean Folk Music", "Traditional Folk Music", "South American Music",
    "Hispanic American Music", "Bullerengue", "Ranchera", "Mariachi", "Norteño", "Música gaúcha", "Murga", "Waltz", "Mazurka"],
  "musica-tropical": ["Caribbean Music", "Plena", "Bomba", "Tamborera", "Tumba", "Cadence lypso"],
  "world-ethnic": ["Tassa", "Hindustani Classical Music"],
  "son": ["Cuban Music", "Son cubano", "Guajira"],
  "cumbia": ["Cumbia colombiana", "Cumbia peruana", "Merecumbé", "Cumbia salvadoreña"],
  "pop-latino": ["Tropipop", "Tejano Music"],
  "malaguena": ["Malagueña venezolana"],
  "calipso": ["Calipso venezolano", "Steel Band"],
  "salsa": ["Salsa dura"],
  "urbano-latino": ["Mambo urbano", "Corrido tumbado", "Funk brasileiro", "Funk mandelão", "Funk 150 bpm", "Moombahton"],
  "tecnomerengue": ["Merenhouse"],
  "latin-electronic-fusion": ["Electro latino"],
  "house": ["Latin House", "Afro House", "Big Room House", "Hip House", "Bass House", "Tribal House", "Acid House", "Bubbling House"],
  "techno": ["Hard Techno", "Acid Techno", "Minimal Techno", "Detroit Techno", "Belgian Techno", "Dub Techno", "Ambient Techno",
    "Techno Bass", "Ghettotech", "Hard Drum"],
  "drum-and-bass": ["Atmospheric Drum and Bass", "Liquid Drum and Bass", "Dancefloor Drum and Bass", "Jungle", "Ragga Jungle"],
  "dubstep": ["Brostep"],
  "trance": ["Dark Psytrance"],
  "dance": ["Alternative Dance"],
  "funk": ["Afrobeat", "Synth Funk"],
  "soul": ["Pop Soul"],
  "cantautor": ["Euskal kantagintza berria", "Chanson québécoise"],
  "folk": ["Folk Pop", "Contemporary Folk", "Psychedelic Folk", "American Primitivism"],
  "country": ["Gothic Country", "Country Pop"],
  "ska": ["Jamaican Ska", "Third Wave Ska"],
  "dancehall": ["Digital Dancehall"],
  "rock-experimental": ["Noise Rock", "Math Rock", "Krautrock"],
  "indie-rock": ["Math Pop", "Slowcore"],
  "garage-rock": ["Garage Rock Revival"],
  "rock-psicodelico": ["Heavy Psych"],
  "punk": ["Synth Punk"],
  "instrumental": ["Pep Band"],
  "banda-sonora": ["Film Soundtrack"],
  "not_a_genre": ["Field Recording", "Nature Recordings", "Animal Sounds", "Comedy", "Stand-Up Comedy"],
};
const notes = "término de Rate Your Music sin mapear tras el run 16902 (Brian 2026-10-06: alias al padre más cercano)";
// --segunda: solo los alias de la 2.ª pasada (crear géneros no es idempotente).
const SEGUNDA = new Set(["Cumbia salvadoreña", "Cool Jazz", "Steel Band", "Wave"]);
const segunda = process.argv.includes("--segunda");
const ops: TaxonomyOperation[] = [...(segunda ? [] : NUEVOS), ...Object.entries(MAPA).flatMap(([target, terms]) =>
  terms.filter((alias) => !segunda || SEGUNDA.has(alias)).map((alias) => ({ op: "set_alias" as const, alias, target, notes })))];
const report = await applyTaxonomyOperations(ops, {
  actor: "claude-code (delegado por Brian)",
  reason: "Géneros de RYM «nuevos» sin mapear: se crean Changa tuki y Emo; el resto como alias al padre más cercano (Brian 2026-10-06)",
}, { confirm: process.argv.includes("--confirm") });
writeFileSync("reports/rym-nuevos-aplicacion-2026-10-05/generos-sin-mapear-mapa.json", JSON.stringify(MAPA, null, 1));
console.log(JSON.stringify({ mode: report.mode, runId: report.runId, operaciones: report.operations.length, términos: Object.values(MAPA).flat().length }));
await closeDb();
