// CRV · Etapa 2 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3):
// creación de fichas y correcciones del catálogo, UN run reversible por bloque
// (`crv runs undo <run>` lo deshace entero). Cada bloque es un run `manual` del
// operador (`crv-operador`, claims human/high): son decisiones de Brian del
// 2026-10-02, ejecutadas por delegación.
//
//   correcciones  El Puma 3712 → 3756 (y los discos repetidos, disco a disco),
//                 Triangular Ascension 835 → Zardonic 795 (+ alias Gorepriest),
//                 solistas registrados como `band` → `solo_artist`, y el alias
//                 «Simón Díaz» fuera del artista 1022 «Simón Díaz Remixes».
//   nuevos        los artistas nuevos del lote con su persona titular (la que
//                 ya existe si es la misma persona; si no, una nueva con el
//                 nombre real), los miembros con nombre propio, «miembro de»,
//                 las fichas del lote que ya existían con otro nombre (Pablo
//                 Gill 288, Schola Cantorum de Caracas 3420) y las «personas»
//                 que eran grupos (Chino y Nacho, Orfeón UCV, Servando &
//                 Florentino). Nuuro (1250) ≠ Arca: Arca es ficha nueva con
//                 P2528 (Alejandra Ghersi) de titular; Nuuro no se toca.
//   personas      duplicados de las titulares y los pares del plan: se funden
//                 SOLO con proyecto común (regla de Brian, 2026-09-28); el
//                 resto va a la mesa como `person_duplicate`.
//   titulares     (etapa 5, 2026-10-04) persona titular de los solistas del
//                 lote que ya existían, «miembro de» hacia grupos del catálogo
//                 y sus fichas dobles (misma regla que `personas`).
//
// Después, `lote-investigacion-2026-10-02.ts` vuelve a correr con
// `etapa2-identidades.json` y engancha a las fichas nuevas los claims
// `candidate` del lote, rellenando solo vacíos.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-investigacion-etapa2.ts --block=correcciones|nuevos|personas|titulares [--confirm]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { createAlias } from "../src/api/repositories/aliases.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import {
  createEntity, createRelation, OperatorError, OPERATOR_SOURCE_SLUG, updateEntity, type OperatorContext,
} from "../src/merge/operator.js";
import { deriveVenezuelanFor } from "../src/merge/venezuelan.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";
import { openPersonCandidateReviews } from "../src/review/person-candidates.js";
import { convertPerson } from "../src/review/person-corrections.js";
import { LOTE_SOURCE_SLUG, compareKey, loteFileSchema, mapArtistType, type LoteArtist } from "../src/ingest/lote-investigacion.js";

const OPERATOR = "claude-code (delegado por Brian)";
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const IDENTITIES_OUT = `${OUT_DIR}/etapa2-identidades.json`;
const DESKTOP = path.join(os.homedir(), "Desktop");
const LOTES = [
  { key: "lote1", file: path.join(DESKTOP, "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json"), cross: OUT_DIR },
  { key: "lote2", file: path.join(DESKTOP, "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json"), cross: `${OUT_DIR}/lote2` },
] as const;
const TITULAR_ROLE = "Titular del proyecto";
const PLAN_NOTE = "Nuevo lote 2026-10-02, etapa 2 (decisiones de Brian del 2026-10-02, plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §2.9 y §3)";

const BLOCK = process.argv.find((arg) => arg.startsWith("--block="))?.slice("--block=".length);
const CONFIRM = process.argv.includes("--confirm");

// --- Decisiones (revisadas a mano contra los créditos de cada persona) -------

/** Fichas que la etapa 0 dio por nuevas y ya existían con otro nombre. */
const EXISTING_UNDER_OTHER_NAME: Record<string, { artist: { id: number; name: string }; rename?: string; artistType?: string; alias: string[]; why: string }> = {
  "pablo-gil": {
    artist: { id: 288, name: "Pablo Gill" }, rename: "Pablo Gil", artistType: "solo_artist", alias: ["Pablo Gill"],
    why: "«Pablo Gill» (288, «Suka Jazz En Directo») es el saxofonista Pablo Gil: su persona 2398 figura en ese disco como saxo, productor y autor; el nombre tenía una errata",
  },
  "schola-cantorum-venezuela": {
    artist: { id: 3420, name: "Schola Cantorum de Caracas" }, alias: ["Schola Cantorum de Venezuela"],
    why: "la Schola Cantorum de Venezuela se fundó en 1967 como Schola Cantorum de Caracas (lote y la-schola.org): renombre = alias",
  },
};

/**
 * Persona titular existente por ficha del lote (id y nombre esperado). Sin
 * entrada, se crea una persona nueva. Se eligió la ficha con más créditos de
 * las candidatas de la etapa 0, tras mirar que sus créditos son de esa
 * persona (compositor, cantante…); las otras van al bloque `personas`.
 */
const TITULAR: Record<string, { id: number; name: string } | null> = {
  arca: { id: 2528, name: "Alejandra Ghersi" }, // titular también de Nuuro (1250), que es otro proyecto
  sunsplash: { id: 1022, name: "Alberto Stangarone" },
  "aquiles-machado": { id: 30404, name: "Aquiles Machado" },
  diveana: { id: 27228, name: "Diveana" },
  "nascuy-linares": { id: 8997, name: "Nascuy Linares" },
  "teresa-carreno": { id: 19257, name: "Teresa Carreño" },
  "antonio-lauro": { id: 19071, name: "Antonio Lauro" },
  "vicente-emilio-sojo": { id: 19382, name: "Vicente Emilio Sojo" },
  "modesta-bor": { id: 19499, name: "Modesta Bor" },
  "antonio-estevez": { id: 19720, name: "Antonio Estévez" },
  "inocente-carreno": { id: 3562, name: "Inocente Carreño" },
  "juan-bautista-plaza": { id: 19213, name: "Juan Bautista Plaza" },
  "adina-izarra": { id: 33221, name: "Adina Izarra" },
  "alfredo-rugeles": { id: 2645, name: "Alfredo Rugeles" },
  "guillermo-castillo-bustamante": { id: 25598, name: "Guillermo Castillo Bustamante" },
  "nelson-arrieta": { id: 3622, name: "Nelson Arrieta" },
  "alfredo-del-monaco": { id: 33209, name: "Alfredo del Mónaco" },
  "pablo-gil": { id: 2398, name: "Pablo Gil" },
  "simon-diaz": { id: 3235, name: "Simón Díaz" },
  "eneas-perdomo": { id: 7352, name: "Eneas Perdomo" },
  "angel-custodio-loyola": { id: 31703, name: "Angel Custodio Loyola" },
  "francisco-montoya": { id: 31223, name: "Francisco Montoya" },
  "rummy-olivo": { id: 35890, name: "Rummy Olivo" },
  "teo-galindez": { id: 35891, name: "Teo Galíndez" },
  "jorge-guerrero": { id: 32267, name: "Jorge Guerrero" },
  // Los dos «Armando Martínez» del catálogo (825, 16123) son guitarristas de
  // rock (DespuésDeVieja, Caramelos de Cianuro, Pig Farm on the Moon), no el
  // cantante llanero: persona nueva.
  "armando-martinez-llanero": null,
  "ivan-jose": { id: 32167, name: "Iván José Rodríguez" },
  "iris-gavidia": { id: 31169, name: "Iris Gavidia" },
  "ignacio-figueredo": { id: 21722, name: "Indio Figueredo" },
  "otilio-galindez": { id: 7389, name: "Otilio Galíndez" },
  "francisco-mata": { id: 29466, name: "Francisco Mata" },
  "luis-mariano-rivera": { id: 7348, name: "Luis Mariano Rivera" },
  "cruz-quinal": { id: 31641, name: "Cruz Quinal" },
  "marco-antonio-rivera-useche": { id: 33837, name: "Marco A. Rivera Useche" }, // compositor (Grupo Raíces de Venezuela)
  "luis-felipe-ramon-rivera": { id: 11811, name: "Luis Felipe Ramón y Rivera" },
  "chucho-corrales": { id: 32304, name: "Chucho Corrales" },
  "ricardo-aguirre": { id: 20547, name: "Ricardo Aguirre" },
  "betulio-medina": { id: 7820, name: "Betulio Medina" },
  "ricardo-cepeda": { id: 7819, name: "Ricardo Cepeda" },
  "astolfo-romero": { id: 27158, name: "Astolfo Romero" },
  popy: { id: 11856, name: "Diony López" },
};

/** Nombre de la persona titular nueva cuando no es el nombre real del lote. */
const NEW_PERSON_NAME: Record<string, string> = {
  irepelusa: "Irepelusa", // el lote da «Irene Alejandra», sin apellidos
};

/** Alias de artista que no salen solos del lote (los del lote suelen ser de la persona). */
const ARTIST_ALIASES: Record<string, string[]> = {
  "micro-tdh": ["MC Microbio", "MC Micro"],
};

type PersonRef = { existing: { id: number; name: string } } | { create: string; aliases?: string[] } | { titularOf: string };
interface MemberPlan { person: PersonRef; role: string; from?: number; to?: number; notes?: string }

/** Miembros con nombre propio de los grupos (limpios a mano: sin «others», apodos aparte). */
const MEMBERS: Record<string, MemberPlan[]> = {
  "adolescents-orquesta": [{ person: { titularOf: "porfi-baloa" }, role: "fundador y director" }],
  "chino-nacho": [
    { person: { existing: { id: 13278, name: "Chyno Miranda" } }, role: "integrante", notes: "Jesús Alberto Miranda Pérez" },
    { person: { existing: { id: 35444, name: "Miguel Ignacio Mendoza" } }, role: "integrante", notes: "Nacho" },
  ],
  "mau-y-ricky": [
    { person: { create: "Mauricio Montaner" }, role: "integrante" },
    { person: { create: "Ricardo Montaner Jr." }, role: "integrante" },
  ],
  motherflowers: [
    { person: { titularOf: "irepelusa" }, role: "integrante" },
    { person: { create: "Frank Lucas" }, role: "integrante" },
    { person: { create: "Veztalone" }, role: "integrante" },
  ],
  // Luis Jiménez: hay dos personas con ese nombre; la de Los Mesoneros (227)
  // comparte contexto con Agustín Zubillaga (4985, mezcla de Los Mesoneros).
  lagos: [
    { person: { existing: { id: 227, name: "Luis Jiménez" } }, role: "integrante" },
    { person: { existing: { id: 4985, name: "Agustín Zubillaga" } }, role: "integrante" },
  ],
  "fur-coat": [{ person: { create: "Sergio Muñoz" }, role: "integrante", notes: "configuración actual: el proyecto empezó como dúo" }],
  "maracaibo-15": [{ person: { existing: { id: 7820, name: "Betulio Medina" } }, role: "fundador, voz líder y director" }],
  "orfeon-universitario-ucv": [{ person: { existing: { id: 19720, name: "Antonio Estévez" } }, role: "fundador y primer director" }],
  "schola-cantorum-venezuela": [
    { person: { existing: { id: 19336, name: "Alberto Grau" } }, role: "director fundador" },
    { person: { existing: { id: 19335, name: "María Guinand" } }, role: "directora artística" },
    { person: { existing: { id: 19588, name: "Luimar Arismendi" } }, role: "directora asociada" },
  ],
};

/** «Miembro de» del lote hacia artistas que existen (o que crea este bloque). */
const MEMBER_OF: Array<{ titularOf: string; artist: { id: number; name: string } | { lote: string }; role: string; from?: number; to?: number; notes?: string }> = [
  { titularOf: "joseph-palacios", artist: { lote: "adolescents-orquesta" }, role: "voz", from: 2015, to: 2020 },
  { titularOf: "diveana", artist: { id: 3794, name: "Los Melódicos" }, role: "voz", notes: "exintegrante" },
  { titularOf: "nelson-arrieta", artist: { id: 3709, name: "Guaco" }, role: "voz" },
  { titularOf: "ricardo-aguirre", artist: { lote: "cardenales-del-exito" }, role: "integrante" },
  { titularOf: "betulio-medina", artist: { lote: "cardenales-del-exito" }, role: "integrante" },
  { titularOf: "ricardo-cepeda", artist: { lote: "cardenales-del-exito" }, role: "integrante" },
];

/** Personas que en realidad son el grupo: sus créditos pasan al artista. */
const PERSON_TO_ARTIST: Array<{ person: { id: number; name: string }; artist: { id: number; name: string } | { lote: string } }> = [
  { person: { id: 25848, name: "Chino y Nacho" }, artist: { lote: "chino-nacho" } },
  { person: { id: 25544, name: "Orfeón Universitario de la UCV" }, artist: { lote: "orfeon-universitario-ucv" } },
  { person: { id: 26549, name: "Servando & Florentino" }, artist: { id: 2014, name: "Servando y Florentino" } },
];

/** Discos de 3712 que son el mismo de 3756 con otro título (los de título igual se emparejan solos). */
const PUMA_ALBUM_PAIRS: Array<[number, number]> = [
  [7272, 8176], // 20 Exitos de José Luis - Colección 20/20 = 20 Exitos Colección 20/20 (1999)
  [7273, 8177], // Boleros con Billo's - Serie Millenium = Serie Millennium 21 Boleros con Billo's (2000)
  [7271, 8175], // Mis Primeros Boleros con Billo - Serie 32 (1999)
  [7246, 8155], // Inolvidable (Con Los Panchos) (1997)
  [7247, 8156], // Inolvidable II (1999)
  [7249, 8157], // Inolvidable III (2001)
];

/** Pares de personas a evaluar (plan §2.9 y duplicados de las titulares). */
const PERSON_PAIRS: Array<{ a: number; b: number; why: string; keepA?: boolean }> = [
  { a: 15801, b: 15808, why: "Federico Ágreda: titular de Zardonic y de Triangular Ascension (fusionados)", keepA: true },
  { a: 15801, b: 5847, why: "Federico Agreda de Sol Nocturno (ex Gorepriest), el mismo autor de Zardonic" },
  { a: 1022, b: 18567, why: "Alberto Stangarone / Sunsplash (plan §2.9)" },
  { a: 1022, b: 19777, why: "Alberto Stangarone duplicado (plan §2.9)" },
  { a: 1022, b: 19776, why: "Sunsplash es el proyecto de Alberto Stangarone (lote)" },
  { a: 18567, b: 19776, why: "Sunsplash duplicado (plan §2.9)" },
  { a: 19777, b: 19776, why: "Alberto Stangarone / Sunsplash" },
  { a: 2398, b: 18955, why: "Pablo Gil duplicado (plan §2.9)" },
  { a: 19720, b: 19503, why: "Antonio Estévez duplicado (plan §2.9)" },
  { a: 3235, b: 22595, why: "Simón Díaz duplicado" },
  { a: 3235, b: 36363, why: "Simón Díaz duplicado" },
  { a: 7352, b: 32324, why: "Eneas Perdomo duplicado" },
  { a: 21722, b: 31290, why: "Ignacio «Indio» Figueredo duplicado" },
  { a: 7389, b: 21395, why: "Otilio Galíndez duplicado" },
  { a: 7389, b: 33744, why: "Otilio Galíndez duplicado" },
  { a: 7348, b: 32029, why: "Luis Mariano Rivera duplicado" },
  { a: 11856, b: 29308, why: "Diony López (Popy) duplicado" },
];

/**
 * Etapa 5 (2026-10-04): solistas del lote que YA existían y no tenían persona
 * titular (el bloque «nuevos» solo la dio a las fichas creadas). Se eligió la
 * persona con créditos en los discos de la propia ficha; Oscar D'León: 21846
 * (56 créditos propios y Dimensión Latina) sobre 1039 (40), que se le funde.
 * Sin persona: se crea con el nombre del lote.
 */
const TITULAR_EXISTENTES: Record<string, { artist: { id: number; name: string }; person: { id: number; name: string } | null }> = {
  "aldemaro-romero": { artist: { id: 3897, name: "Aldemaro Romero" }, person: { id: 30, name: "Aldemaro Romero" } },
  "alfredo-sadel": { artist: { id: 3676, name: "Alfredo Sadel" }, person: { id: 21399, name: "Alfredo Sadel" } },
  "ali-primera": { artist: { id: 3677, name: "Alí Primera" }, person: { id: 22238, name: "Alí Primera" } },
  "aquiles-baez": { artist: { id: 3449, name: "Aquiles Báez" }, person: { id: 935, name: "Aquiles Báez" } },
  "canelita-medina": { artist: { id: 3684, name: "Canelita Medina" }, person: { id: 22438, name: "Canelita Medina" } },
  "chelique-sarabia": { artist: { id: 3689, name: "Chelique Sarabia" }, person: { id: 57, name: "Chelique Sarabia" } },
  "edward-simon": { artist: { id: 3480, name: "Edward Simon" }, person: { id: 22148, name: "Edward Simon" } },
  "evencio-castellanos": { artist: { id: 3400, name: "Evencio Castellanos" }, person: { id: 19477, name: "Evencio Castellanos" } },
  "felipe-pirela": { artist: { id: 3785, name: "Felipe Pirela" }, person: { id: 24366, name: "Felipe Pirela" } },
  "floria-marquez": { artist: { id: 3703, name: "Floria Márquez" }, person: null },
  // Canta y toca en Un Solo Pueblo y en Francisco Pacheco y Su Pueblo (sin créditos en esta ficha).
  "francisco-pacheco": { artist: { id: 3816, name: "Francisco Pacheco" }, person: { id: 1709, name: "Francisco Pacheco" } },
  "gerry-weil": { artist: { id: 3500, name: "Gerry Weil" }, person: { id: 670, name: "Gerry Weil" } },
  "gualberto-ibarreto": { artist: { id: 3821, name: "Gualberto Ibarreto" }, person: { id: 21200, name: "Gualberto Ibarreto" } },
  "hernan-marin": { artist: { id: 3823, name: "Hernán Marín" }, person: { id: 24616, name: "Hernán Marín" } },
  "hugo-blanco": { artist: { id: 3710, name: "Hugo Blanco" }, person: { id: 761, name: "Hugo Blanco" } },
  "jose-luis-rodriguez-el-puma": { artist: { id: 3756, name: "José Luis Rodríguez" }, person: { id: 7180, name: "José Luis Rodríguez" } },
  "juan-vicente-torrealba": { artist: { id: 3829, name: "Juan Vicente Torrealba" }, person: { id: 4456, name: "Juan Vicente Torrealba" } },
  "lilia-vera": { artist: { id: 3831, name: "Lilia Vera" }, person: { id: 31135, name: "Lilia Vera" } },
  "linda-briceno": { artist: { id: 3529, name: "Linda Briceño" }, person: { id: 847, name: "Linda Briceño" } },
  "luis-silva": { artist: { id: 3833, name: "Luis Silva" }, person: { id: 3197, name: "Luis Silva" } },
  "magdalena-sanchez": { artist: { id: 3890, name: "Magdalena Sánchez" }, person: { id: 31057, name: "Magdalena Sánchez" } },
  "maria-teresa-chacin": { artist: { id: 3797, name: "María Teresa Chacín" }, person: { id: 3972, name: "María Teresa Chacín" } },
  "mirla-castellanos": { artist: { id: 3796, name: "Mirla Castellanos" }, person: { id: 29343, name: "Mirla Castellanos" } },
  natusha: { artist: { id: 3732, name: "Natusha" }, person: { id: 29573, name: "Natusha" } },
  "oscar-dleon": { artist: { id: 3739, name: "Oscar D' León" }, person: { id: 21846, name: "Oscar D’León" } },
  "otmaro-ruiz": { artist: { id: 3558, name: "Otmaro Ruiz" }, person: { id: 1639, name: "Otmaro Ruiz" } },
  "paul-desenne": { artist: { id: 3993, name: "Paul Desenne" }, person: { id: 20614, name: "Paul Desenne" } },
  "pecos-kanvas": { artist: { id: 3740, name: "Pecos Kanvas" }, person: { id: 29792, name: "Pecos Kanvas" } },
  "pollo-brito": { artist: { id: 3743, name: "Rafael \"Pollo\" Brito" }, person: { id: 934, name: "Rafael \"Pollo\" Brito" } },
  "reyna-lucero": { artist: { id: 3870, name: "Reyna Lucero" }, person: { id: 31056, name: "Reyna Lucero" } },
  "reynaldo-armas": { artist: { id: 3889, name: "Reynaldo Armas" }, person: { id: 20590, name: "Reynaldo Armas" } },
  "roberto-antonio": { artist: { id: 3745, name: "Roberto Antonio" }, person: { id: 25692, name: "Roberto Antonio" } },
  "soledad-bravo": { artist: { id: 3749, name: "Soledad Bravo" }, person: { id: 25256, name: "Soledad Bravo" } },
};

/** «Miembro de» del lote para esas titulares (y la directora de la Cantoría), solo hacia grupos del catálogo. */
const MEMBER_OF_EXISTENTES: Array<{ titularOf?: string; person?: { id: number; name: string }; artist: { id: number; name: string }; role: string; notes?: string }> = [
  { titularOf: "oscar-dleon", artist: { id: 270, name: "Dimension Latina" }, role: "voz y bajo", notes: "fundador" },
  { titularOf: "canelita-medina", artist: { id: 3700, name: "Federico y Su Combo Latino" }, role: "voz" },
  { titularOf: "francisco-pacheco", artist: { id: 3857, name: "Un Solo Pueblo" }, role: "voz y percusión" },
  { titularOf: "francisco-pacheco", artist: { id: 3865, name: "Francisco Pacheco y Su Pueblo" }, role: "director y voz" },
  { titularOf: "juan-vicente-torrealba", artist: { id: 3884, name: "Juan Vicente Torrealba y sus Torrealberos" }, role: "director y arpa" },
  { titularOf: "juan-vicente-torrealba", artist: { id: 3883, name: "Los Torrealberos Juan Vicente Torrealba" }, role: "director y arpa" },
  { person: { id: 19335, name: "María Guinand" }, artist: { id: 3387, name: "Cantoría Alberto Grau" }, role: "directora", notes: "directora histórica (lote)" },
  // Sin ficha en el catálogo: Sonero Clásico del Caribe (Canelita Medina), Grupo Oriente (Hernán Marín).
];

/** Fichas dobles de esas titulares: se funden solo con proyecto común; si no, a la mesa. */
const TITULAR_PAIRS: Array<{ a: number; b: number; why: string }> = [
  { a: 21846, b: 1039, why: "Oscar D'León duplicado (titular de 3739)" },
  { a: 21846, b: 21396, why: "Oscar D'León duplicado (titular de 3739)" },
  { a: 22238, b: 12890, why: "Alí Primera duplicado (titular de 3677)" },
  { a: 57, b: 31206, why: "«Chelique», compositor en discos de Chelique Sarabia (titular de 3689)" },
  { a: 24366, b: 12032, why: "Felipe Pirela duplicado (titular de 3785)" },
  { a: 21200, b: 619, why: "Gualberto Ibarreto duplicado (titular de 3821)" },
  { a: 29343, b: 12006, why: "Mirla Castellanos duplicado (titular de 3796)" },
  { a: 29792, b: 12090, why: "Pecos Kanvas duplicado (titular de 3740)" },
];

// --- Infraestructura -----------------------------------------------------------

interface Report {
  block: string; mode: string; runId: number; steps: Array<Record<string, unknown>>; warnings: string[];
}
const report: Report = { block: BLOCK ?? "", mode: CONFIRM ? "confirm" : "dry-run", runId: 0, steps: [], warnings: [] };
const step = (row: Record<string, unknown>) => { report.steps.push(row); console.log(JSON.stringify(row)); };
const warn = (text: string) => { report.warnings.push(text); console.warn(`AVISO: ${text}`); };

async function operatorRun(action: string, note: string, work: (context: OperatorContext) => Promise<void>): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Operador del catálogo (API)','database','high',false,'Altas y correcciones humanas. Nunca se raspa.')
      ON CONFLICT (slug) DO NOTHING`, [OPERATOR_SOURCE_SLUG]);
    const sourceId = Number((await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [OPERATOR_SOURCE_SLUG])).rows[0]!.id);
    const run = await client.query<{ id: string }>(
      "INSERT INTO ingest.scrape_runs(kind,source_id,status,params) VALUES('manual',$1,'running',$2::jsonb) RETURNING id::text",
      [sourceId, JSON.stringify({ action, operator: OPERATOR, note, stage: 2, block: BLOCK, confirm: CONFIRM })]);
    report.runId = Number(run.rows[0]!.id);
    await work({ client, runId: report.runId, sourceId, operator: OPERATOR, note });
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [report.runId, JSON.stringify({ steps: report.steps.length, warnings: report.warnings.length })]);
    await client.query(CONFIRM ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Ejecuta `work` en un savepoint: si falla, la transacción sigue limpia. */
async function attempt<T>(client: PoolClient, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await client.query("SAVEPOINT etapa2");
  try {
    const value = await work();
    await client.query("RELEASE SAVEPOINT etapa2");
    return { ok: true, value };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT etapa2");
    return { ok: false, error };
  }
}

async function rowName(client: PoolClient, table: "artists" | "persons" | "albums", id: number): Promise<string | null> {
  const column = table === "albums" ? "title" : "name";
  return (await client.query<{ name: string }>(`SELECT ${column} AS name FROM public.${table} WHERE id=$1`, [id])).rows[0]?.name ?? null;
}

async function expectRow(client: PoolClient, table: "artists" | "persons", ref: { id: number; name: string }): Promise<void> {
  const actual = await rowName(client, table, ref.id);
  if (actual === null) throw new Error(`${table} ${ref.id} no existe (se esperaba «${ref.name}»)`);
  if (actual !== ref.name) throw new Error(`${table} ${ref.id} se llama «${actual}», se esperaba «${ref.name}»`);
}

/** Sigue las fusiones: la ficha viva de un id (o null si se borró sin destino). */
async function liveId(client: PoolClient, kind: "artist" | "person", id: number): Promise<number | null> {
  let current = id;
  for (let hop = 0; hop < 10; hop += 1) {
    const next = await client.query<{ to_id: string }>(
      "SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind=$1::ingest.claim_entity_kind AND from_id=$2 ORDER BY created_at DESC LIMIT 1", [kind, current]);
    if (!next.rowCount) break;
    current = Number(next.rows[0]!.to_id);
  }
  return (await rowName(client, kind === "artist" ? "artists" : "persons", current)) === null ? null : current;
}

/** Alias nuevo, sin repetir el nombre ni un alias ya presente; en artistas, sin pisar el nombre de otro artista. */
async function addAlias(context: OperatorContext, kind: "artist" | "person", id: number, alias: string, aliasType: string): Promise<boolean> {
  const { client } = context;
  const clean = alias.trim();
  if (!clean) return false;
  const table = kind === "artist" ? "ingest.artist_aliases" : "ingest.person_aliases";
  const column = `${kind}_id`;
  const name = await rowName(client, kind === "artist" ? "artists" : "persons", id);
  const key = normalizeEntityName(clean).primaryKey;
  if (name !== null && normalizeEntityName(name).primaryKey === key) return false;
  const present = await client.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 AND (alias=$2 OR normalized_alias=$3)`, [id, clean, key]);
  if (present.rowCount) return false;
  if (kind === "artist") {
    const taken = await client.query<{ id: string; name: string }>(`
      SELECT a.id::text, a.name FROM public.artists a WHERE a.id<>$1 AND lower(a.name)=lower($2)
      UNION SELECT a.id::text, a.name FROM ingest.artist_aliases al JOIN public.artists a ON a.id=al.artist_id
       WHERE al.artist_id<>$1 AND lower(al.alias)=lower($2) LIMIT 1`, [id, clean]);
    if (taken.rowCount) {
      warn(`alias «${clean}» no se añade al artista ${id}: ya es de ${taken.rows[0]!.name} (${taken.rows[0]!.id})`);
      return false;
    }
  }
  await createAlias(context, kind, id, { alias: clean, aliasType, isPrimary: false });
  return true;
}

async function audit(client: PoolClient, runId: number, kind: "artist" | "person", id: number, field: string, oldValue: unknown, newValue: unknown, reason: string): Promise<void> {
  await client.query(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,${kind}_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,$2::ingest.claim_entity_kind,$3,$4,$5::jsonb,$6::jsonb,$7,'high','human')`,
  [runId, kind, id, field, JSON.stringify(oldValue ?? null), JSON.stringify(newValue ?? null), reason]);
}

// --- Lote ----------------------------------------------------------------------

interface LoteRow { lote: string; artist: LoteArtist; estado: "existe" | "nuevo" }

function loadLote(): LoteRow[] {
  const rows: LoteRow[] = [];
  for (const lote of LOTES) {
    const parsed = loteFileSchema.parse(JSON.parse(readFileSync(lote.file, "utf8")));
    const identities = new Map((JSON.parse(readFileSync(path.join(lote.cross, "identidades.json"), "utf8")) as Array<{ lote_id: string; estado: "existe" | "nuevo" }>)
      .map((row) => [row.lote_id, row.estado]));
    for (const artist of parsed.artists) {
      const estado = identities.get(artist.id);
      if (!estado) throw new Error(`${lote.key}: ${artist.id} no está en la tabla de identidades de la etapa 0`);
      rows.push({ lote: lote.key, artist, estado });
    }
  }
  return rows;
}

/** Fichas que esta etapa crea: las «nuevas» de la etapa 0, más Simón Díaz y Arca (forzadas a nuevo en la etapa 1). */
function newArtists(rows: LoteRow[]): LoteRow[] {
  return rows.filter((row) => (row.estado === "nuevo" || row.artist.id === "simon-diaz" || row.artist.id === "arca")
    && !(row.artist.id in EXISTING_UNDER_OTHER_NAME));
}

const isSolo = (artist: LoteArtist) => mapArtistType(artist.entity_type) === "solo_artist";

/** Nombre de la titular nueva: el nombre real del lote si es completo (regla «el nombre real manda»), si no el artístico. */
function newTitularName(artist: LoteArtist): string {
  if (NEW_PERSON_NAME[artist.id]) return NEW_PERSON_NAME[artist.id]!;
  const real = artist.real_name?.trim();
  if (real && real.split(/\s+/).length >= 2 && compareKey(real) !== compareKey(artist.artist_name)) return real;
  return artist.artist_name.trim();
}

/** Alias de la persona titular: nombre artístico y alias del lote, salvo los que nombran a otro proyecto. */
function titularAliases(artist: LoteArtist, personName: string): string[] {
  const out = new Map<string, string>();
  for (const alias of [artist.artist_name, ...(artist.aliases ?? [])]) {
    const clean = alias?.trim();
    if (!clean || compareKey(clean) === compareKey(personName)) continue;
    out.set(compareKey(clean), clean);
  }
  return [...out.values()];
}

// --- Bloque: correcciones ------------------------------------------------------

async function mergeArtist(context: OperatorContext, keep: { id: number; name: string }, drop: { id: number; name: string }, extraAliases: string[]): Promise<void> {
  const { client } = context;
  if ((await rowName(client, "artists", drop.id)) === null && (await liveId(client, "artist", drop.id)) === keep.id) {
    step({ op: "fusionar_artista", status: "skipped", detail: `${drop.id} ya está fusionado en ${keep.id}` });
    return;
  }
  await expectRow(client, "artists", keep);
  await expectRow(client, "artists", drop);
  const preview = await previewEntityMerge(client, "artist", keep.id, drop.id, { lock: true });
  const merged = await mergeEntities(context, { kind: "artist", keepId: keep.id, dropId: drop.id, previewHash: preview.previewHash, keepDropNameAsAlias: true });
  const aliases: string[] = [];
  for (const alias of extraAliases) if (await addAlias(context, "artist", keep.id, alias, "stage_name")) aliases.push(alias);
  step({
    op: "fusionar_artista", status: "applied", keep, drop, moved: merged.moved, filled: merged.filled, preserved: merged.preserved,
    conflicts: preview.fieldConflicts, aliasesMoved: preview.aliasesToAdd, aliasesAdded: aliases, warnings: preview.warnings,
  });
}

async function blockCorrecciones(context: OperatorContext): Promise<void> {
  const { client } = context;
  // 1. El Puma: los discos de 3712 que repiten uno de 3756 se emparejan antes de mover nada.
  const keyOf = (title: string) => compareKey(title).replace(/[^a-z0-9]/g, "");
  const puma = (await client.query<{ id: string; artist_id: string; title: string; release_year: number | null }>(
    "SELECT id::text, artist_id::text, title, release_year FROM public.albums WHERE artist_id IN (3712,3756)")).rows;
  const keepByKey = new Map<string, typeof puma>();
  for (const album of puma.filter((row) => row.artist_id === "3756")) keepByKey.set(keyOf(album.title), [...(keepByKey.get(keyOf(album.title)) ?? []), album]);
  const pairs: Array<{ drop: number; keep: number; title: string }> = [];
  for (const album of puma.filter((row) => row.artist_id === "3712")) {
    const twins = (keepByKey.get(keyOf(album.title)) ?? []).filter((twin) =>
      album.release_year === null || twin.release_year === null || Math.abs(album.release_year - twin.release_year) <= 1);
    if (twins.length === 1) pairs.push({ drop: Number(album.id), keep: Number(twins[0]!.id), title: album.title });
    else if (twins.length > 1) warn(`El Puma: «${album.title}» (${album.id}) coincide con ${twins.length} discos de 3756; no se funde`);
  }
  for (const [drop, keep] of PUMA_ALBUM_PAIRS) {
    if (puma.some((row) => Number(row.id) === drop) && puma.some((row) => Number(row.id) === keep)) {
      pairs.push({ drop, keep, title: puma.find((row) => Number(row.id) === drop)!.title });
    }
  }
  await mergeArtist(context, { id: 3756, name: "José Luis Rodríguez" }, { id: 3712, name: "José Luis Rodríguez \"El Puma\"" }, ["El Puma"]);
  let albumsMerged = 0;
  for (const pair of pairs) {
    const preview = await previewAlbumMerge(client, pair.keep, pair.drop, { lock: true });
    const merged = await mergeAlbums(context, { keepId: pair.keep, dropId: pair.drop, previewHash: preview.previewHash, keepDropNameAsAlias: true });
    albumsMerged += 1;
    step({ op: "fusionar_disco", status: "applied", keep: pair.keep, drop: pair.drop, title: pair.title, tracksMoved: merged.tracksMoved, fieldsCorrected: merged.fieldsCorrected });
  }
  step({ op: "el_puma_discos", albumsOf3712: puma.filter((row) => row.artist_id === "3712").length, merged: albumsMerged, movedAsIs: puma.filter((row) => row.artist_id === "3712").length - albumsMerged });

  // 2. Triangular Ascension y Gorepriest son alias de Zardonic.
  await mergeArtist(context, { id: 795, name: "Zardonic" }, { id: 835, name: "Triangular Ascension" }, ["Gorepriest"]);

  // 3. Solistas registrados como `band` (conflictos de la etapa 1, run 11461).
  const stage1 = JSON.parse(readFileSync(`${OUT_DIR}/etapa1-confirm-run11461.json`, "utf8")) as { conflicts: Array<{ field: string; entityId: number; artist: string; lote_value: string; core_value: string }> };
  const solos = stage1.conflicts.filter((row) => row.field === "artist_type" && row.lote_value === "solo_artist" && row.core_value === "band");
  let retyped = 0;
  for (const row of solos) {
    const id = await liveId(client, "artist", row.entityId);
    if (id === null) { warn(`solista ${row.artist} (${row.entityId}) ya no existe`); continue; }
    const current = (await client.query<{ artist_type: string }>("SELECT artist_type::text FROM public.artists WHERE id=$1", [id])).rows[0]!.artist_type;
    if (current !== "band") { step({ op: "solista", status: "skipped", id, name: row.artist, detail: `ya es ${current}` }); continue; }
    await updateEntity(context, "artist", id, { artist_type: "solo_artist" });
    const settled = await client.query(`
      UPDATE ingest.claims c SET status='accepted', updated_at=now(), notes=concat_ws(' · ', c.notes, $2::text)
        FROM ingest.sources s
       WHERE s.id=c.source_id AND s.slug=$3 AND c.artist_id=$1 AND c.field='artist_type' AND c.status='conflict'`,
    [id, `el core pasó a solo_artist (etapa 2, run ${context.runId})`, LOTE_SOURCE_SLUG]);
    retyped += 1;
    step({ op: "solista", status: "applied", id, name: row.artist, loteClaimsAccepted: settled.rowCount });
  }
  step({ op: "solistas", listed: solos.length, retyped });

  // 4. «Simón Díaz» no es alias de «Simón Díaz Remixes» (1022): Simón Díaz tendrá ficha propia (bloque nuevos).
  await expectRow(client, "artists", { id: 1022, name: "Simón Díaz Remixes" });
  const dropped = await client.query<{ id: string; alias: string }>(
    "DELETE FROM ingest.artist_aliases WHERE artist_id=1022 AND alias='Simón Díaz' RETURNING id::text, alias");
  if (dropped.rowCount) {
    await audit(client, context.runId, "artist", 1022, "aliases", ["Simón Díaz"], null,
      `${PLAN_NOTE}: «Simón Díaz Remixes» es un proyecto de remezclas; «Simón Díaz» será su propia ficha`);
  }
  step({ op: "quitar_alias", artist: 1022, alias: "Simón Díaz", status: dropped.rowCount ? "applied" : "skipped" });
}

// --- Bloque: nuevos ------------------------------------------------------------

interface CreatedIdentity { lote: string; artistId: number; artistName: string; personId: number | null; created: boolean; similar?: number[] }

async function createArtistOrPerson(context: OperatorContext, kind: "artist" | "person", values: Record<string, unknown>): Promise<{ id: number; similar: boolean }> {
  const first = await attempt(context.client, () => createEntity(context, kind, values, { allowSimilar: false }));
  if (first.ok) return { id: first.value.id, similar: false };
  if (!(first.error instanceof OperatorError) || first.error.code !== "needs_review") throw first.error;
  // Brian decidió que entran (plan §2.1): el parecido con otra ficha no las detiene, pero queda anotado.
  const second = await createEntity(context, kind, values, { allowSimilar: true });
  return { id: second.id, similar: true };
}

async function linkMember(context: OperatorContext, artistId: number, personId: number, plan: { role: string; from?: number | undefined; to?: number | undefined; notes?: string | undefined }): Promise<string> {
  const existing = await context.client.query("SELECT 1 FROM public.artist_members WHERE artist_id=$1 AND person_id=$2", [artistId, personId]);
  if (existing.rowCount) return "ya era miembro";
  const result = await createRelation(context, "artist_membership", { artistId, personId }, {
    role: plan.role, from_year: plan.from, to_year: plan.to, notes: plan.notes,
  });
  return result.created ? "enlazado" : "ya estaba";
}

async function blockNuevos(context: OperatorContext): Promise<void> {
  const { client } = context;
  const rows = loadLote();
  const identities: Record<string, CreatedIdentity> = {};
  const touchedPersons = new Set<number>();
  const byLote = new Map(rows.map((row) => [row.artist.id, row]));

  // 1. Fichas del lote que ya existían con otro nombre.
  for (const [loteId, decision] of Object.entries(EXISTING_UNDER_OTHER_NAME)) {
    const row = byLote.get(loteId);
    if (!row) throw new Error(`${loteId} no está en el lote`);
    const live = await liveId(client, "artist", decision.artist.id);
    if (live === null) throw new Error(`artista ${decision.artist.id} inexistente`);
    const current = (await rowName(client, "artists", live))!;
    if (current !== decision.artist.name && current !== decision.rename) throw new Error(`artista ${live} se llama «${current}»`);
    const aliases: string[] = [];
    for (const alias of decision.alias) if (await addAlias(context, "artist", live, alias, "name_variant")) aliases.push(alias);
    const values: Record<string, unknown> = {};
    if (decision.rename && current !== decision.rename) values["name"] = decision.rename;
    if (decision.artistType) {
      const type = (await client.query<{ t: string }>("SELECT artist_type::text AS t FROM public.artists WHERE id=$1", [live])).rows[0]!.t;
      if (type !== decision.artistType) values["artist_type"] = decision.artistType;
    }
    if (Object.keys(values).length) await updateEntity(context, "artist", live, values);
    identities[loteId] = { lote: row.lote, artistId: live, artistName: decision.rename ?? current, personId: null, created: false };
    step({ op: "ficha_existente", loteId, artist: live, from: current, values, aliases, why: decision.why });
  }

  // 2. Artistas nuevos (antes que nada: los miembros y «miembro de» apuntan a ellos).
  for (const row of newArtists(rows)) {
    const { artist } = row;
    const name = artist.artist_name.trim();
    const live = await client.query<{ id: string; name: string }>(`
      SELECT a.id::text, a.name FROM public.artists a WHERE lower(a.name)=lower($1)
      UNION SELECT a.id::text, a.name FROM ingest.artist_aliases al JOIN public.artists a ON a.id=al.artist_id WHERE lower(al.alias)=lower($1)`, [name]);
    if (live.rowCount) {
      warn(`${artist.id}: «${name}» ya existe como ${live.rows.map((r) => `${r.name} (${r.id})`).join(", ")}; no se crea (decide Brian)`);
      continue;
    }
    const type = mapArtistType(artist.entity_type) ?? "other";
    const values: Record<string, unknown> = { name, artist_type: type, origin_country: "Venezuela" };
    if (artist.id === "jose-coraspe") {
      values["notes"] = "Nacionalidad venezolana indicada por el proyecto (Brian, 2026-10-02); sin confirmación pública independiente. No confundir con el cantante llanero José Gregorio Coraspe.";
    }
    const created = await createArtistOrPerson(context, "artist", values);
    const aliases: string[] = [];
    for (const alias of ARTIST_ALIASES[artist.id] ?? []) if (await addAlias(context, "artist", created.id, alias, "name_variant")) aliases.push(alias);
    identities[artist.id] = { lote: row.lote, artistId: created.id, artistName: name, personId: null, created: true };
    step({ op: "crear_artista", loteId: artist.id, id: created.id, name, type, similarCandidates: created.similar, aliases });
  }

  // 3. Persona titular de cada solista (las existentes se verifican por nombre).
  for (const row of [...newArtists(rows), ...Object.keys(EXISTING_UNDER_OTHER_NAME).map((id) => byLote.get(id)!)]) {
    const { artist } = row;
    const identity = identities[artist.id];
    if (!identity || !isSolo(artist)) continue;
    let personId: number;
    let personName: string;
    let origin: string;
    const chosen = TITULAR[artist.id];
    if (chosen) {
      const live = await liveId(client, "person", chosen.id);
      if (live === null) throw new Error(`persona ${chosen.id} («${chosen.name}») inexistente`);
      personName = (await rowName(client, "persons", live))!;
      if (live === chosen.id && personName !== chosen.name) throw new Error(`persona ${chosen.id} se llama «${personName}», se esperaba «${chosen.name}»`);
      personId = live;
      origin = "existente";
    } else {
      personName = newTitularName(artist);
      const created = await createArtistOrPerson(context, "person", { name: personName });
      personId = created.id;
      origin = created.similar ? "nueva (hay homónimos o parecidas)" : "nueva";
    }
    const link = await linkMember(context, identity.artistId, personId, { role: TITULAR_ROLE });
    const aliases: string[] = [];
    for (const alias of titularAliases(artist, personName)) if (await addAlias(context, "person", personId, alias, "stage_name")) aliases.push(alias);
    identity.personId = personId;
    touchedPersons.add(personId);
    step({ op: "titular", loteId: artist.id, artist: identity.artistId, person: personId, personName, origin, link, aliases });
  }

  const resolvePerson = async (ref: PersonRef): Promise<{ id: number; name: string; origin: string }> => {
    if ("titularOf" in ref) {
      const id = identities[ref.titularOf]?.personId;
      if (!id) throw new Error(`${ref.titularOf} no tiene titular`);
      return { id, name: (await rowName(client, "persons", id))!, origin: `titular de ${ref.titularOf}` };
    }
    if ("existing" in ref) {
      const id = await liveId(client, "person", ref.existing.id);
      if (id === null) throw new Error(`persona ${ref.existing.id} inexistente`);
      const name = (await rowName(client, "persons", id))!;
      if (id === ref.existing.id && name !== ref.existing.name) throw new Error(`persona ${id} se llama «${name}», se esperaba «${ref.existing.name}»`);
      return { id, name, origin: "existente" };
    }
    const created = await createArtistOrPerson(context, "person", { name: ref.create });
    for (const alias of ref.aliases ?? []) await addAlias(context, "person", created.id, alias, "stage_name");
    return { id: created.id, name: ref.create, origin: created.similar ? "nueva (hay homónimos o parecidas)" : "nueva" };
  };
  const artistOf = async (ref: { id: number; name: string } | { lote: string }): Promise<number | null> => {
    if ("lote" in ref) return identities[ref.lote]?.artistId ?? null;
    await expectRow(client, "artists", ref);
    return ref.id;
  };

  // 4. Miembros con nombre propio.
  for (const [loteId, members] of Object.entries(MEMBERS)) {
    const artistId = identities[loteId]?.artistId;
    if (!artistId) { warn(`${loteId}: sin ficha; sus miembros no se enlazan`); continue; }
    for (const member of members) {
      const person = await resolvePerson(member.person);
      const link = await linkMember(context, artistId, person.id, member);
      touchedPersons.add(person.id);
      step({ op: "miembro", loteId, artist: artistId, person: person.id, personName: person.name, origin: person.origin, role: member.role, link });
    }
  }

  // 5. «Miembro de» hacia otros artistas.
  for (const row of MEMBER_OF) {
    const personId = identities[row.titularOf]?.personId;
    const artistId = await artistOf(row.artist);
    if (!personId || !artistId) { warn(`miembro de: ${row.titularOf} → ${JSON.stringify(row.artist)} sin ficha`); continue; }
    const link = await linkMember(context, artistId, personId, row);
    step({ op: "miembro_de", titularOf: row.titularOf, person: personId, artist: artistId, role: row.role, link });
  }

  // 6. Personas que son el grupo: sus créditos pasan al artista (su nombre queda de alias).
  for (const row of PERSON_TO_ARTIST) {
    const artistId = await artistOf(row.artist);
    if (!artistId) { warn(`${row.person.name}: el artista destino no existe`); continue; }
    const name = await rowName(client, "persons", row.person.id);
    if (name === null) { step({ op: "persona_a_artista", status: "skipped", person: row.person, detail: "ya no existe" }); continue; }
    if (name !== row.person.name) throw new Error(`persona ${row.person.id} se llama «${name}»`);
    const outcome = await convertPerson(client, row.person.id, { kind: "artist", id: artistId }, true, `${PLAN_NOTE}: «${row.person.name}» es el grupo, no una persona`, context.runId);
    step({ op: "persona_a_artista", person: row.person, artist: artistId, status: outcome.status, detail: outcome.detail });
  }

  // 7. Venezolano en las personas tocadas (se deriva de sus membresías).
  const marked = await deriveVenezuelanFor(client, [...touchedPersons], context.runId);
  step({ op: "venezolano_derivado", persons: touchedPersons.size, marked });

  const created = Object.values(identities).filter((row) => row.created).length;
  step({ op: "resumen_nuevos", artistsCreated: created, existingUnderOtherName: Object.keys(EXISTING_UNDER_OTHER_NAME).length, withTitular: Object.values(identities).filter((row) => row.personId).length });
  if (CONFIRM) writeFileSync(IDENTITIES_OUT, `${JSON.stringify({ runId: context.runId, decidedAt: "2026-10-02", identities }, null, 2)}\n`);
}

// --- Bloque: personas ----------------------------------------------------------

/** Contextos de proyecto (misma regla que scripts/merge-canserbero-collisions.ts). */
const SHARED_SQL = `
  WITH ctx AS (
    SELECT person_id, 'artist:'||artist_id AS c FROM public.artist_members
    UNION SELECT ac.person_id, 'album:'||ac.album_id FROM public.album_credits ac
      JOIN public.albums al ON al.id=ac.album_id
      JOIN public.artists ar ON ar.id=al.artist_id
     WHERE ac.person_id IS NOT NULL AND lower(ar.name) NOT IN ('various artists','varios artistas','v.a.','va')
    UNION SELECT tc.person_id, 'album:'||t.album_id FROM public.track_credits tc
      JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
      JOIN public.artists ar ON ar.id=al.artist_id
     WHERE tc.person_id IS NOT NULL AND lower(ar.name) NOT IN ('various artists','varios artistas','v.a.','va')
    UNION SELECT tc.person_id, 'artist:'||al.artist_id FROM public.track_credits tc
      JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
      JOIN public.artists ar ON ar.id=al.artist_id
     WHERE tc.person_id IS NOT NULL AND lower(ar.name) NOT IN ('various artists','varios artistas','v.a.','va'))
  SELECT
    (SELECT array_agg(DISTINCT a.c) FROM ctx a JOIN ctx b ON b.c=a.c WHERE a.person_id=$1 AND b.person_id=$2) AS shared,
    (SELECT count(DISTINCT x.person_id) FROM ctx a JOIN ctx x ON x.c=a.c AND x.person_id NOT IN ($1,$2)
       WHERE a.person_id=$1 AND x.person_id IN (
         SELECT y.person_id FROM ctx b JOIN ctx y ON y.c=b.c WHERE b.person_id=$2)) AS colleagues`;

const queued: Array<{ a: { id: number; name: string }; b: { id: number; name: string }; why: string }> = [];

async function blockPersonas(context: OperatorContext, pairs: Array<{ a: number; b: number; why: string; keepA?: boolean }> = PERSON_PAIRS): Promise<void> {
  const { client } = context;
  const linked = async (id: number) => Number((await client.query<{ n: string }>(
    "SELECT (count(*) FILTER (WHERE role='Titular del proyecto') * 10 + count(*))::text AS n FROM public.artist_members WHERE person_id=$1", [id])).rows[0]?.n ?? 0);
  const refs = async (id: number) => Number((await client.query<{ n: string }>(`
    SELECT ((SELECT count(*) FROM public.album_credits WHERE person_id=$1) + (SELECT count(*) FROM public.track_credits WHERE person_id=$1))::text AS n`, [id])).rows[0]!.n);
  for (const pair of pairs) {
    const a = await liveId(client, "person", pair.a);
    const b = await liveId(client, "person", pair.b);
    if (a === null || b === null || a === b) { step({ op: "fusionar_persona", status: "skipped", pair, detail: a === b ? "ya son la misma ficha" : "una no existe" }); continue; }
    const [nameA, nameB] = [(await rowName(client, "persons", a))!, (await rowName(client, "persons", b))!];
    const { shared, colleagues } = (await client.query<{ shared: string[] | null; colleagues: string }>(SHARED_SQL, [a, b])).rows[0]!;
    if (!shared?.length && Number(colleagues) < 2) {
      if (queued.some((row) => Math.min(row.a.id, row.b.id) === Math.min(a, b) && Math.max(row.a.id, row.b.id) === Math.max(a, b))) continue;
      queued.push({ a: { id: a, name: nameA }, b: { id: b, name: nameB }, why: `${pair.why}; sin proyecto común` });
      step({ op: "fusionar_persona", status: "a_la_mesa", a, nameA, b, nameB, why: pair.why });
      continue;
    }
    // Queda la ficha ligada al artista; a igualdad, la de más créditos.
    const [la, lb] = [await linked(a), await linked(b)];
    // keepA: la del plan (p. ej. la titular original con el nombre completo).
    const keepA = pair.keepA && a === pair.a ? true : la !== lb ? la > lb : (await refs(a)) >= (await refs(b));
    const [keep, drop] = keepA ? [a, b] : [b, a];
    const preview = await previewEntityMerge(client, "person", keep, drop, { lock: true });
    const merged = await mergeEntities(context, { kind: "person", keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: true });
    step({
      op: "fusionar_persona", status: "applied", keep, keepName: keepA ? nameA : nameB, drop, dropName: keepA ? nameB : nameA,
      why: `${pair.why}; ${shared?.length ? `proyecto común: ${shared.slice(0, 4).join(", ")}` : `${colleagues} colegas en común`}`,
      moved: merged.moved, conflicts: preview.fieldConflicts.map((row) => row.field), preserved: merged.preserved,
    });
  }
}

// --- Bloque: titulares (etapa 5) -----------------------------------------------

async function blockTitulares(context: OperatorContext): Promise<void> {
  const { client } = context;
  const byLote = new Map(loadLote().map((row) => [row.artist.id, row]));
  const titularOf = new Map<string, number>();
  const touchedPersons = new Set<number>();

  // 1. Persona titular de los solistas que ya existían.
  for (const [loteId, decision] of Object.entries(TITULAR_EXISTENTES)) {
    const row = byLote.get(loteId);
    if (!row) throw new Error(`${loteId} no está en el lote`);
    const artistId = await liveId(client, "artist", decision.artist.id);
    if (artistId === null) throw new Error(`artista ${decision.artist.id} («${decision.artist.name}») inexistente`);
    if (artistId === decision.artist.id) await expectRow(client, "artists", decision.artist);
    const current = await client.query<{ person_id: string }>("SELECT person_id::text FROM public.artist_members WHERE artist_id=$1", [artistId]);
    if (current.rowCount) {
      warn(`${loteId}: el artista ${artistId} ya tiene personas enlazadas; no se toca`);
      continue;
    }
    let personId: number;
    let personName: string;
    let origin: string;
    if (decision.person) {
      const live = await liveId(client, "person", decision.person.id);
      if (live === null) throw new Error(`persona ${decision.person.id} («${decision.person.name}») inexistente`);
      if (live === decision.person.id) await expectRow(client, "persons", decision.person);
      personId = live;
      personName = (await rowName(client, "persons", live))!;
      origin = "existente";
    } else {
      personName = newTitularName(row.artist);
      const created = await createArtistOrPerson(context, "person", { name: personName });
      personId = created.id;
      origin = created.similar ? "nueva (hay homónimos o parecidas)" : "nueva";
    }
    const link = await linkMember(context, artistId, personId, { role: TITULAR_ROLE });
    const aliases: string[] = [];
    for (const alias of titularAliases(row.artist, personName)) if (await addAlias(context, "person", personId, alias, "stage_name")) aliases.push(alias);
    titularOf.set(loteId, personId);
    touchedPersons.add(personId);
    step({ op: "titular", loteId, artist: artistId, person: personId, personName, origin, link, aliases });
  }

  // 2. «Miembro de» hacia grupos del catálogo.
  for (const row of MEMBER_OF_EXISTENTES) {
    let personId: number | null = null;
    if (row.titularOf) personId = titularOf.get(row.titularOf) ?? null;
    else if (row.person) {
      personId = await liveId(client, "person", row.person.id);
      if (personId === row.person.id) await expectRow(client, "persons", row.person);
    }
    if (personId === null) { warn(`miembro de: ${row.titularOf ?? row.person?.name} → ${row.artist.name} sin persona`); continue; }
    await expectRow(client, "artists", row.artist);
    const link = await linkMember(context, row.artist.id, personId, row);
    touchedPersons.add(personId);
    step({ op: "miembro_de", titularOf: row.titularOf, person: personId, artist: row.artist.id, artistName: row.artist.name, role: row.role, link });
  }

  // 3. Fichas dobles de las titulares (solo con proyecto común; el resto, a la mesa).
  await blockPersonas(context, TITULAR_PAIRS);

  // 4. Venezolano en las personas tocadas (se deriva de sus membresías).
  const live = (await Promise.all([...touchedPersons].map((id) => liveId(client, "person", id)))).filter((id): id is number => id !== null);
  const marked = await deriveVenezuelanFor(client, [...new Set(live)], context.runId);
  step({ op: "venezolano_derivado", persons: live.length, marked });
}

/** Pares sin proyecto común → mesa (`person_duplicate`), con ids vivos y sin repetir. */
async function openQueuedPairs(): Promise<void> {
  const pool = await getPool().connect();
  const live: typeof queued = [];
  try {
    for (const row of queued) {
      const a = await liveId(pool, "person", row.a.id);
      const b = await liveId(pool, "person", row.b.id);
      if (a === null || b === null || a === b) continue;
      if (live.some((item) => Math.min(item.a.id, item.b.id) === Math.min(a, b) && Math.max(item.a.id, item.b.id) === Math.max(a, b))) continue;
      live.push({ a: { id: a, name: (await rowName(pool, "persons", a))! }, b: { id: b, name: (await rowName(pool, "persons", b))! }, why: row.why });
    }
  } finally {
    pool.release();
  }
  queued.splice(0, queued.length, ...live);
  if (CONFIRM && queued.length) {
    writeReport();
    const opened = await openPersonCandidateReviews(queued.map((row) => ({
      a: row.a, b: row.b, score: 0.5, features: [{ key: "lote_2026_10_02_same_person", value: 1, evidence: row.why }], priority: 6 as const,
    })), `${PLAN_NOTE}: posibles fichas de la misma persona sin proyecto común`, OPERATOR);
    step({ op: "mesa", ...opened });
  } else if (queued.length) step({ op: "mesa", proposed: queued.length });
}

// --- Principal -----------------------------------------------------------------

function writeReport(): void {
  const stem = `${OUT_DIR}/etapa2-${report.block}-${report.mode}-run${report.runId}`;
  writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# Etapa 2 — ${report.block} (${report.mode}, run ${report.runId})`, "",
    `Pasos: ${report.steps.length}. Avisos: ${report.warnings.length}.`, "",
    ...(report.warnings.length ? ["## Avisos", "", ...report.warnings.map((text) => `- ${text}`), ""] : []),
    "## Pasos", "",
    ...report.steps.map((row) => `- ${Object.entries(row).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ")}`),
  ];
  writeFileSync(`${stem}.md`, `${lines.join("\n")}\n`);
  console.log(`→ ${stem}.md`);
}

async function main(): Promise<void> {
  if (BLOCK === "correcciones") {
    await operatorRun("lote-2026-10-02:etapa2:correcciones",
      `${PLAN_NOTE}: El Puma 3712→3756, Triangular Ascension 835→Zardonic 795 (+Gorepriest), solistas band→solo_artist, alias «Simón Díaz» fuera de 1022.`,
      blockCorrecciones);
  } else if (BLOCK === "nuevos") {
    if (existsSync(IDENTITIES_OUT) && CONFIRM) throw new Error(`${IDENTITIES_OUT} ya existe: el bloque nuevos ya se aplicó`);
    await operatorRun("lote-2026-10-02:etapa2:nuevos",
      `${PLAN_NOTE}: artistas nuevos del lote con su persona titular y miembros con nombre propio. Nuuro (1250) ≠ Arca: Arca es ficha nueva con P2528 de titular.`,
      blockNuevos);
  } else if (BLOCK === "personas") {
    await operatorRun("lote-2026-10-02:etapa2:personas",
      `${PLAN_NOTE}: personas duplicadas de las titulares; se funden solo con proyecto común (regla de Brian, 2026-09-28).`,
      (context) => blockPersonas(context));
    // Las fusiones del propio bloque pueden haber movido una ficha de la mesa: ids vivos y sin repetir.
    await openQueuedPairs();
  } else if (BLOCK === "titulares") {
    await operatorRun("lote-2026-10-02:etapa5:titulares",
      `${PLAN_NOTE}: persona titular de los solistas del lote que ya existían (plan §2.8), «miembro de» hacia grupos del catálogo y fusión de sus fichas dobles con proyecto común.`,
      blockTitulares);
    await openQueuedPairs();
  } else {
    throw new Error("--block=correcciones|nuevos|personas|titulares");
  }
  writeReport();
  await closeDb();
}

main().catch(async (error: unknown) => { console.error(error); await closeDb(); process.exit(1); });
