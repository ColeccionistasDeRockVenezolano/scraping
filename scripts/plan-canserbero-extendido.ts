// CRV · El caso Canserbero, extendido a todo el catálogo (Brian, 2026-10-02).
//
// REGLA (2026-10-01, caso Canserbero): el nombre de una persona es su nombre.
// Lo que la fuente pegó al nombre —un apodo, un @usuario, un estudio— pasa a
// alias, y el nombre artístico también: la búsqueda mira nombres y alias, así
// que se sigue encontrando por los dos, y los créditos muestran a la persona.
//
// Decisiones de Brian del 2026-10-02 (cada etapa es un plan para
// `crv review persons --plan=… --confirm`, que corre en su propia run):
//   parens    «Alberto Camacaro (Kama)» → «Alberto Camacaro» + alias Kama; al
//             revés, «Frankie Devil (Francisco Belda)» → queda el nombre real.
//             También @usuario, «aka» y «Estudio - Persona». Tabla revisada a
//             mano: los que son estudios u organizaciones no se renombran.
//   realnames El nombre real que da una fuente (Metal Archives en
//             `persons.real_name`, o una biografía): si la ficha lleva el
//             nombre artístico («Kerch»), pasa a llamarse «Juan Aponte» y
//             «Kerch» queda de alias; si ya es una forma del nombre real
//             («Carlos Baute»), el nombre completo solo se suma como alias.
//   nicknames Todo apodo es también alias, aunque no salga del nombre: los
//             intercalados («Rafael "Pollo" Brito») y los de base de una
//             palabra siguen sin renombrarse (decisión del 2026-10-01).
//   projects  El titular de un proyecto responde también por el nombre del
//             proyecto (como «Canserbero» en Tirone González).
//
// Un renombre que caiga sobre el nombre de otra ficha no se aplica: queda en
// el informe y `merge-canserbero-collisions.ts` decide (fusión con proyecto
// común, o la mesa). --open-reviews abre `person_duplicate` para los pares
// marcados a mano en la tabla. Escribe el plan y un informe con lo que no toca
// y por qué.
//   tsx scripts/plan-canserbero-extendido.ts --stage=parens|realnames|nicknames|projects [--open-reviews]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeEntityName, removeDiacritics } from "../src/normalization/entity-name.js";
import { openPersonCandidateReviews } from "../src/review/person-candidates.js";

const TODAY = new Date().toISOString().slice(0, 10);
const STAGES = ["parens", "realnames", "nicknames", "projects"] as const;
type Stage = typeof STAGES[number];

interface Person { id: number; name: string; realName: string | null }
interface Correction { op: string; [key: string]: unknown }
interface Skipped { id: number; name: string; reason: string; target?: string; collidesWith?: { id: number; name: string } }

/** Nombres con algo pegado (revisados a mano el 2026-10-02). `to` renombra; sin `to`, solo alias. */
const PARENS: Array<{ id: number; name: string; to?: string; aliases: string[]; skip?: string; reviewWith?: number }> = [
  // Nombre (Apodo)
  { id: 16523, name: "Alberto Camacaro (Kama)", to: "Alberto Camacaro", aliases: ["Kama"] },
  { id: 17736, name: "Carlos Granado (Sharly Grand)", to: "Carlos Granado", aliases: ["Sharly Grand"] },
  { id: 6021, name: "Carlos Hernández (DJ HOOCH)", to: "Carlos Hernández", aliases: ["DJ HOOCH"] },
  { id: 15502, name: "César Monge (Albóndiga)", to: "César Monge", aliases: ["Albóndiga"] },
  { id: 18117, name: "David Escobar (Dim)", to: "David Escobar", aliases: ["Dim"] },
  { id: 18119, name: "David Lorduy Hernández (Lorduy)", to: "David Lorduy Hernández", aliases: ["Lorduy"] },
  { id: 17782, name: "Francisco Araujo (Clincho)", to: "Francisco Araujo", aliases: ["Clincho"] },
  { id: 17772, name: "Isabel Matheus (Isa)", to: "Isabel Matheus", aliases: ["Isa"] },
  { id: 15736, name: "Jesus Nieto ( El gordo )", to: "Jesus Nieto", aliases: ["El gordo"] },
  { id: 16608, name: "Jhoan Bello (tablon)", to: "Jhoan Bello", aliases: ["tablon"] },
  { id: 8562, name: "Jorge García (Paté Sónico)", to: "Jorge García", aliases: ["Paté Sónico"] },
  { id: 15503, name: "José Antonio Rojas (Rojitas)", to: "José Antonio Rojas", aliases: ["Rojitas"] },
  { id: 17784, name: "José Barrios (Pulún)", to: "José Barrios", aliases: ["Pulún"] },
  { id: 18118, name: "Juan David Castaño (El Llane)", to: "Juan David Castaño", aliases: ["El Llane"] },
  { id: 18116, name: "Juan David Huertas (El Profe)", to: "Juan David Huertas", aliases: ["El Profe"] },
  { id: 17768, name: "Juan Espinoza (Búho)", to: "Juan Espinoza", aliases: ["Búho"] },
  { id: 15540, name: "Leonardo Chacon (Orekio)", to: "Leonardo Chacon", aliases: ["Orekio"] },
  { id: 16525, name: "Marco León (Mate)", to: "Marco León", aliases: ["Mate"] },
  { id: 15537, name: "Maria Castro (Mauxi)", to: "Maria Castro", aliases: ["Mauxi"] },
  { id: 15539, name: "Miguel Soteldo (Banano)", to: "Miguel Soteldo", aliases: ["Banano"] },
  { id: 17597, name: "Nelson Ramírez (Kiro)", to: "Nelson Ramírez", aliases: ["Kiro"] },
  { id: 15538, name: "Ovidio Pernalete (Obi1)", to: "Ovidio Pernalete", aliases: ["Obi1"] },
  { id: 18115, name: "Pablo Mejía (Pablito)", to: "Pablo Mejía", aliases: ["Pablito"] },
  { id: 17785, name: "Pedro Viloria (Peter)", to: "Pedro Viloria", aliases: ["Peter"] },
  { id: 4370, name: "Rafael Llorente (Rafa)", to: "Rafael Llorente", aliases: ["Rafa"] },
  { id: 17774, name: "Ramón Briceño (Cheklem)", to: "Ramón Briceño", aliases: ["Cheklem"] },
  { id: 17773, name: "Richard Ribas (Astaroth)", to: "Richard Ribas", aliases: ["Astaroth"] },
  { id: 17769, name: "Samuel Terán (Samael)", to: "Samuel Terán", aliases: ["Samael"] },
  { id: 6517, name: "Santiago Rodríguez (Srod)", to: "Santiago Rodríguez", aliases: ["Srod"] },
  { id: 6315, name: "Suzi De Madeiros (Suzi D)", to: "Suzi De Madeiros", aliases: ["Suzi D"] },
  { id: 17770, name: "Vanessa Fernández (Hecate)", to: "Vanessa Fernández", aliases: ["Hecate"] },
  // Apodo (Nombre real): queda el nombre real (decisión de Brian, 2026-10-02)
  { id: 4782, name: "Arian (Felipe Nevado)", to: "Felipe Nevado", aliases: ["Arian"] },
  { id: 5764, name: "Charlie Devil (Carlos Mendoza)", to: "Carlos Mendoza", aliases: ["Charlie Devil"] },
  { id: 15447, name: "DJ 13 (Tony Armas)", to: "Tony Armas", aliases: ["DJ 13"] },
  { id: 5766, name: "Eddie Devil (Eduardo Benatar)", to: "Eduardo Benatar", aliases: ["Eddie Devil"] },
  { id: 5767, name: "Frankie Devil (Francisco Belda)", to: "Francisco Belda", aliases: ["Frankie Devil"] },
  { id: 5761, name: "Willie Devil (Willbert Alvarez)", to: "Willbert Alvarez", aliases: ["Willie Devil"] },
  { id: 5765, name: "Rocky Devil (Francisco \"Coco\" Díaz)", to: "Francisco \"Coco\" Díaz", aliases: ["Rocky Devil", "Coco"] },
  { id: 4731, name: "Matatigre (Clara Bolívar)", to: "Clara Bolívar", aliases: ["Matatigre"] },
  { id: 17386, name: "Mike (Miguel Cerdá)", to: "Miguel Cerdá", aliases: ["Mike"] },
  { id: 6400, name: "Leizer for The Masses (Leizer Oliveros Lara)", to: "Leizer Oliveros Lara", aliases: ["Leizer for The Masses"] },
  { id: 6576, name: "Surrearts Graphics (Erick León)", to: "Erick León", aliases: ["Surrearts Graphics"] },
  { id: 7609, name: "Doped Up Dollies (Sirae Richardson)", to: "Sirae Richardson", aliases: ["Doped Up Dollies"] },
  // La biografía del artista 1683 «Bostas Brain»: «cuyo nombre completo es Luis Quintero».
  { id: 15448, name: "Bostas Brain (El Juez)", to: "Luis Quintero", aliases: ["Bostas Brain", "El Juez"] },
  // Dos apodos: queda el primero, el segundo es alias.
  { id: 15450, name: "El Cubano (Big Habana)", to: "El Cubano", aliases: ["Big Habana"] },
  { id: 15451, name: "El Cura (Ristaman)", to: "El Cura", aliases: ["Ristaman"] },
  { id: 15449, name: "Ruso 40 (Big Smoke)", to: "Ruso 40", aliases: ["Big Smoke"] },
  // Base de una palabra o apodo intercalado: no se renombra, el apodo es alias.
  { id: 13518, name: "Adonay (Q.E.E.P)", aliases: ["Q.E.E.P"] },
  { id: 17069, name: "Alex (RicochetCcs)", aliases: ["RicochetCcs"] },
  { id: 15453, name: "Apolonia (Miss Knox)", aliases: ["Miss Knox"] },
  { id: 16223, name: "Jaime (SJ)", aliases: ["SJ"] },
  { id: 15735, name: "Jesus ( El gordo )", aliases: ["El gordo"], reviewWith: 15736 },
  { id: 16225, name: "Rafael (Tornillo)", aliases: ["Tornillo"] },
  { id: 15452, name: "E.G. (Rotwaila)", aliases: ["Rotwaila"] },
  { id: 7776, name: "Alejandro (Jackson) Castillo", aliases: ["Jackson"] },
  { id: 15504, name: "José (Joseíto) Rodríguez", aliases: ["Joseíto"] },
  { id: 16691, name: "Luis (Pepe) Campos", aliases: ["Pepe"] },
  { id: 13637, name: "C.A.F.P.C. aka A.N.Y.S.K. M.S.D.W.", aliases: ["C.A.F.P.C.", "A.N.Y.S.K. M.S.D.W."] },
  { id: 5198, name: "RCA (aka) Nutria", aliases: ["RCA", "Nutria"] },
  // Estudio o firma - Persona
  { id: 8228, name: "Antonio Huizi - Graficción", to: "Antonio Huizi", aliases: ["Graficción"] },
  { id: 3810, name: "Control X - Gilberto Lazo", to: "Gilberto Lazo", aliases: ["Control X"] },
  { id: 13217, name: "Hale Villalobos - Frente", to: "Hale Villalobos", aliases: ["Frente"] },
  // @usuario y «aka»
  { id: 12301, name: "Diego Alejandro García @BonkDesign", to: "Diego Alejandro García", aliases: ["BonkDesign"] },
  { id: 2158, name: "Edward Vera \"Turtled\" @Turtleddj", to: "Edward Vera", aliases: ["Turtled", "Turtleddj"], reviewWith: 18098 },
  { id: 12328, name: "Euden Ojeda @ElCalvok", to: "Euden Ojeda", aliases: ["ElCalvok"] },
  { id: 3243, name: "Gustavo Dal Farra @GustavoDB", to: "Gustavo Dal Farra", aliases: ["GustavoDB"] },
  { id: 47, name: "Remo Caremartori a.k.a.Recard", to: "Remo Caremartori", aliases: ["Recard"] },
  // Fragmento de la extracción de miembros del 2026-10-01: el nombre es el del final.
  { id: 18555, name: "1993–1997); Pingüino Echezuría (miembro)", to: "Pingüino Echezuría", aliases: [] },
  // No son personas o no se sabe quién es: a la mesa, sin tocar.
  { id: 4010, name: "(Electric Freak Designs)", aliases: [], skip: "estudio de diseño dado de alta como persona: va a organizaciones" },
  { id: 8861, name: "Sala Romulo Gallegos (El Celarg)", aliases: [], skip: "es una sala de conciertos: va a organizaciones" },
  { id: 12272, name: "Brain Gain Unlimited - A.C. Tañerla", aliases: [], skip: "empresa o estudio con persona pegada: sin dato para separar" },
  { id: 5407, name: "Después de Vieja - El Chacal", aliases: [], skip: "título de canción + intérprete: no es una persona" },
  { id: 7554, name: "plus bonus tracks Pantaletas Negras - Un Buen Perdedor", aliases: [], skip: "texto de lista de pistas: no es una persona" },
  { id: 12270, name: "Bogaert Aka", aliases: [], skip: "«aka» sin el otro nombre" },
  { id: 9004, name: "A.K.A. Trece", aliases: [], skip: "puede ser el titular de Trece (16811): eso lo decide la regla de proyecto común", reviewWith: 16811 },
  { id: 7824, name: "joa@DiArt", aliases: [], skip: "usuario de una web de arte, sin nombre" },
  { id: 8464, name: "mobiusCo@deviantart", aliases: [], skip: "usuario de una web de arte, sin nombre" },
  { id: 18097, name: "Dj Remmy (García)", aliases: [], skip: "el paréntesis es un apellido suelto, no un apodo" },
  { id: 16586, name: "Roamin 'Alley 69' (El Cura ex La Corte)", aliases: [], skip: "la nota dice que es «El Cura» de La Corte (15451): va a la mesa", reviewWith: 15451 },
];

/** Nombres reales que da una biografía (del artista del que es titular o de la persona). */
const BIO_REAL_NAMES: Array<{ id: number; name: string; real: string; source: string; extraAliases?: string[] }> = [
  { id: 18060, name: "C-funk", real: "Cristian Moraga", source: "biografía del artista 2606: «su nombre real es Cristian Moraga»" },
  { id: 17663, name: "DJ Rey", real: "Reynaldo Morales", source: "biografía del artista 2225: «Su nombre real es Reynaldo Morales»" },
  { id: 369, name: "Delia", real: "Delia Dorta", source: "biografía del artista 1855: «Delia Dorta, conocida artísticamente como Delia»" },
  { id: 4026, name: "Edgar Alexander", real: "Édgar Enrique Quintero Castillo", source: "biografía del artista 1923: «Édgar Enrique Quintero Castillo, conocido artísticamente como Edgar Alexander»" },
  { id: 5835, name: "Gladys", real: "Gladys María del Rosario Di Ruggiero", source: "biografía del artista 1417: «Gladys María del Rosario Di Ruggiero, conocida artísticamente como Gladys»" },
  { id: 18120, name: "KC", real: "Kevin Cunningham", source: "biografía del artista 2904: «cuyo nombre real es Kevin Cunningham»" },
  { id: 17364, name: "Nella", real: "Marianella Rojas", source: "biografía del artista 1836: «Su nombre completo es Marianella Rojas»" },
  { id: 16406, name: "Psikopata", real: "Pedro Manuel Ortiz Osorio", source: "biografía del artista 1338: «Psikopata es el alias de Pedro Manuel Ortiz Osorio»" },
  { id: 16933, name: "Rekeson", real: "Gustavo Ferrín", source: "biografía del artista 1595: «conocido artísticamente como Rekesón, también Baby Hustla y El Astronauta, cuyo nombre de nacimiento es Gustavo Ferrín»", extraAliases: ["Rekesón", "Baby Hustla", "El Astronauta"] },
  { id: 489, name: "Argel", real: "Argel Trejo", source: "biografía de la persona: «nombre completo Argel Trejo»" },
  { id: 544, name: "Ilan Chester", real: "Ilan Czenstochouski Schechter", source: "biografía de la persona: «nombre completo Ilan Czenstochouski Schechter»" },
  { id: 11915, name: "Mayra Martí", real: "Moira Elisa Martínez Álvarez", source: "biografía de la persona: «su nombre de nacimiento es Moira Elisa Martínez Álvarez»" },
  { id: 4117, name: "Carlos Baute", real: "Carlos Roberto Baute Jiménez", source: "biografía del artista 1801: «Carlos Roberto Baute Jiménez, conocido como Carlos Baute»" },
  { id: 3100, name: "Daniel Grau", real: "Daniel Grau Sosa", source: "biografía del artista 1911: «Daniel Grau Sosa, conocido como Daniel Grau»" },
  { id: 1086, name: "Franco de Vita", real: "Franco Atilio de Vita de Vito", source: "biografía del artista 99: «de nombre completo Franco Atilio de Vita de Vito»" },
  { id: 7116, name: "Guillermo Dávila", real: "Guillermo José Dávila Ruiz", source: "biografía del artista 1960: «Guillermo José Dávila Ruiz, conocido artísticamente como Guillermo Dávila»" },
  { id: 3597, name: "Maricruz Quintero", real: "María de la Cruz Quintero Mendoza", source: "biografía del artista 1819: «Su nombre real es María de la Cruz Quintero Mendoza»" },
  { id: 17394, name: "Julio César", real: "Julio César Rodríguez", source: "biografía del artista 1979: «Nacido como Julio César Rodríguez»" },
  { id: 7300, name: "Alex Berti", real: "Alexander Berti Soteldo", source: "biografía de la persona: «su nombre completo es Alexander Berti Soteldo»" },
  { id: 2853, name: "Glenn Tomassi", real: "Glenn Humberto Tomassi Hung", source: "biografía de la persona" },
  { id: 2841, name: "Ibsen Rosales", real: "Ibsen Fidel Rosales Betancourt", source: "biografía de la persona" },
  { id: 5694, name: "Janet Goitia", real: "Janet del Carmen Goitia Román", source: "biografía de la persona" },
  { id: 2857, name: "Jesús Toro", real: "Jesús Rafael Toro Zambrano", source: "biografía de la persona" },
  { id: 5073, name: "José Arévalo", real: "José Antonio Arévalo González", source: "biografía de la persona" },
  { id: 2032, name: "Manolo Alvarez", real: "Manuel Álvarez", source: "biografía de la persona: «cuyo nombre completo era Manuel Álvarez»" },
  { id: 3091, name: "Oscar Gómez", real: "Óscar Basilio Gómez Díaz", source: "biografía de la persona" },
  { id: 4697, name: "Piero Gigante", real: "Mario Piero Gigante", source: "biografía de la persona" },
  { id: 978, name: "Rudy Márquez", real: "Rodolfo Márquez Van Stenis", source: "biografía de la persona: «cuyo nombre completo era Rodolfo Márquez Van Stenis»" },
  { id: 690, name: "Willy Díaz", real: "Wilmer Antonio Díaz Lara", source: "biografía de la persona" },
];

/** Fuentes que se contradicen sobre el nombre real: no se toca nada. */
const CONTRADICTED: Record<number, string> = {
  3258: "Luz Marina: Wikipedia dice «Luz Marina Virriel» y la biografía «Luz Marina Anselmi Landaeta»",
  306: "MASA: Metal Archives dice «José Manuel Vidal» y la biografía «Miguel Vásquez»",
  2044: "José Martínez: Metal Archives dice «Jose Rafael Martinez» y la biografía «José Martínez Molina»",
  883: "Ezequiel Serrano Valencia: la biografía dice «Ezequiel Serrano Calderón»",
};

function argOf(flag: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
}

const keyOf = (value: string) => normalizeEntityName(value).primaryKey;
const tokens = (value: string) => removeDiacritics(value.toLowerCase()).replace(/[^a-z0-9ñ]+/gu, " ").split(" ").filter(Boolean);

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** El mismo apellido escrito casi igual («Pratolongo»/«Protolongo»). */
const sameToken = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= Math.floor(Math.max(a.length, b.length) / 4));

/**
 * ¿La ficha ya lleva una forma del nombre real? Sí si comparte un apellido
 * (cualquier palabra después de la primera): «Carlos Baute» ⊂ «Carlos Roberto
 * Baute Jiménez», «Kike Montero» ~ «Enrique Alfonso Montero». Si no comparte
 * ninguno, lo que lleva es el nombre artístico: «Kerch», «Luis Platano», «Delia».
 */
function isFormOfRealName(current: string, real: string): boolean {
  // Las mismas palabras en otro orden («Luna Franco»/«Franco Luna») también.
  if ([...tokens(current)].sort().join(" ") === [...tokens(real)].sort().join(" ")) return true;
  const mine = tokens(current).slice(1);
  const theirs = tokens(real).slice(1);
  return mine.some((token) => theirs.some((other) => sameToken(token, other)));
}

/** Nombre real utilizable: dos palabras o más, solo letras (sin notas entre paréntesis). */
function cleanRealName(value: string): string | null {
  const cleaned = value.replace(/\s*\([^)]*\)\s*/gu, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.split(" ").length < 2) return null;
  if (!/^[\p{L}][\p{L}\p{M}.'’ -]+$/u.test(cleaned)) return null;
  // Una palabra repetida («Pedro Pedro Arvelo») es un error de la fuente.
  const words = tokens(cleaned);
  if (words.some((word, index) => index > 0 && word === words[index - 1])) return null;
  return cleaned;
}

/** Apodos que quedan dentro del nombre: entre comillas en cualquier sitio, o entre paréntesis en medio. */
function nicknamesIn(name: string): string[] {
  const found = [...name.matchAll(/["“”«»]([^"“”«»]{2,40})["“”«»]/gu)].map((match) => match[1]!.trim());
  const middle = /^\S+\s+\(([^)]{2,40})\)\s+\S+/u.exec(name);
  if (middle) found.push(middle[1]!.trim());
  return [...new Set(found.flatMap((value) => value.split("/").map((part) => part.trim())).filter((value) => value.length >= 2))];
}

async function main(): Promise<void> {
  const stage = argOf("stage") as Stage | undefined;
  if (!stage || !STAGES.includes(stage)) throw new Error(`--stage=${STAGES.join("|")}`);
  const planPath = argOf("out") ?? `docs/decisions/${TODAY}-canserbero-${stage}.json`;
  const reportPath = argOf("report") ?? `reports/canserbero-${stage}-${TODAY}.jsonl`;
  const pool = getPool();

  const persons = new Map<number, Person>((await pool.query<{ id: string; name: string; real_name: string | null }>(
    "SELECT id::text, name, real_name FROM public.persons ORDER BY id")).rows
    .map((row) => [Number(row.id), { id: Number(row.id), name: row.name, realName: row.real_name }]));
  const byKey = new Map<string, Person[]>();
  for (const person of persons.values()) byKey.set(keyOf(person.name), [...(byKey.get(keyOf(person.name)) ?? []), person]);
  const aliases = new Map<number, Set<string>>();
  for (const row of (await pool.query<{ person_id: string; alias: string }>("SELECT person_id::text, alias FROM ingest.person_aliases")).rows) {
    aliases.set(Number(row.person_id), (aliases.get(Number(row.person_id)) ?? new Set<string>()).add(keyOf(row.alias)));
  }
  const answersTo = (person: Person, value: string) => keyOf(person.name) === keyOf(value) || (aliases.get(person.id)?.has(keyOf(value)) ?? false);

  const corrections: Correction[] = [];
  const skipped: Skipped[] = [];
  const reviews: Array<{ a: Person; b: Person; why: string }> = [];
  const count = { renamed: 0, aliases: 0 };

  const addAlias = (person: Person, currentName: string, alias: string, why: string) => {
    if (!alias.trim() || keyOf(alias) === keyOf(currentName) || aliases.get(person.id)?.has(keyOf(alias))) return;
    aliases.set(person.id, (aliases.get(person.id) ?? new Set<string>()).add(keyOf(alias)));
    corrections.push({ op: "add_alias", person: { id: person.id, name: currentName }, alias, why });
    count.aliases += 1;
  };
  /** Renombra si el nombre nuevo no es de otra ficha; si lo es, va a la mesa. */
  const rename = (person: Person, to: string, why: string): boolean => {
    const collision = (byKey.get(keyOf(to)) ?? []).find((other) => other.id !== person.id);
    if (collision) {
      skipped.push({ id: person.id, name: person.name, target: to, collidesWith: { id: collision.id, name: collision.name },
        reason: "el nombre nuevo ya es de otra ficha: puede ser la misma persona, pero eso se decide con la regla de proyecto común" });
      // Ni se funde ni va a la mesa aquí: lo decide merge-canserbero-collisions.ts con la regla de proyecto común.
      return false;
    }
    corrections.push({ op: "rename", person: { id: person.id, name: person.name }, to, keepOldNameAsAlias: true, why });
    byKey.set(keyOf(to), [...(byKey.get(keyOf(to)) ?? []), person]);
    count.renamed += 1;
    return true;
  };

  if (stage === "parens") {
    for (const entry of PARENS) {
      const person = persons.get(entry.id);
      if (!person) { skipped.push({ id: entry.id, name: entry.name, reason: "la ficha ya no existe (fusionada o retirada)" }); continue; }
      if (person.name !== entry.name) { skipped.push({ id: entry.id, name: person.name, reason: `ya no se llama «${entry.name}»` }); continue; }
      const other = entry.reviewWith === undefined ? undefined : persons.get(entry.reviewWith);
      if (other) reviews.push({ a: person, b: other, why: entry.skip ?? `«${person.name}» y «${other.name}» comparten apodo o proyecto` });
      if (entry.skip) { skipped.push({ id: person.id, name: person.name, reason: entry.skip }); continue; }
      let current = person.name;
      if (entry.to && entry.to !== person.name) {
        const why = `Lo pegado al nombre «${person.name}» pasa a alias; queda el nombre de la persona (caso Canserbero, Brian 2026-10-02).`;
        // Si el nombre limpio ya es de otra ficha, no se renombra (va a la
        // mesa), pero el apodo se suma igual a la ficha tal como está.
        if (rename(person, entry.to, why)) current = entry.to;
      }
      for (const alias of entry.aliases) addAlias(person, current, alias, `Apodo o firma que la fuente escribió dentro del nombre «${person.name}».`);
    }
  }

  if (stage === "realnames") {
    const sourced: Array<{ person: Person; real: string; source: string; extra: string[] }> = [];
    const fromBio = new Set(BIO_REAL_NAMES.map((entry) => entry.id));
    for (const entry of BIO_REAL_NAMES) {
      const person = persons.get(entry.id);
      if (!person) { skipped.push({ id: entry.id, name: entry.name, reason: "la ficha ya no existe" }); continue; }
      if (person.name !== entry.name) { skipped.push({ id: entry.id, name: person.name, reason: `ya no se llama «${entry.name}»` }); continue; }
      sourced.push({ person, real: entry.real, source: entry.source, extra: entry.extraAliases ?? [] });
    }
    for (const person of persons.values()) {
      if (!person.realName || fromBio.has(person.id)) continue;
      if (CONTRADICTED[person.id]) { skipped.push({ id: person.id, name: person.name, reason: CONTRADICTED[person.id]! }); continue; }
      const real = cleanRealName(person.realName);
      if (!real) { skipped.push({ id: person.id, name: person.name, target: person.realName, reason: "el nombre real de la fuente no parece un nombre completo" }); continue; }
      if (keyOf(real) === keyOf(person.name)) continue;
      sourced.push({ person, real, source: "nombre real según Metal Archives (persons.real_name)", extra: [] });
    }
    for (const { person, real, source, extra } of sourced) {
      let current = person.name;
      if (isFormOfRealName(person.name, real)) {
        addAlias(person, current, real, `Nombre completo de la persona (${source}); la ficha ya lleva una forma de ese nombre.`);
      } else {
        const why = `«${person.name}» es el nombre artístico; la persona se llama «${real}» (${source}). El nombre artístico queda de alias (caso Canserbero).`;
        if (!rename(person, real, why)) {
          // Sin renombrar, el nombre real al menos se encuentra.
          addAlias(person, current, real, `Nombre real según la fuente (${source}); no se renombra porque ya es el nombre de otra ficha.`);
          continue;
        }
        current = real;
        for (const nickname of nicknamesIn(person.name)) addAlias(person, current, nickname, `Apodo que iba en el nombre «${person.name}».`);
      }
      for (const alias of extra) addAlias(person, current, alias, `Otro nombre artístico (${source}).`);
    }
  }

  if (stage === "nicknames") {
    for (const person of persons.values()) {
      for (const nickname of nicknamesIn(person.name)) {
        addAlias(person, person.name, nickname, `Apodo dentro del nombre «${person.name}»: el nombre no cambia (apodo intercalado o base de una palabra), pero se encuentra también por el apodo (Brian, 2026-10-02).`);
      }
    }
  }

  if (stage === "projects") {
    const { rows } = await pool.query<{ person_id: string; artist_id: string; artist_name: string; titulares: number }>(`
      SELECT m.person_id::text, a.id::text AS artist_id, a.name AS artist_name,
             (SELECT count(*)::int FROM public.artist_members t WHERE t.artist_id = a.id AND t.role = 'Titular del proyecto') AS titulares
        FROM public.artist_members m JOIN public.artists a ON a.id = m.artist_id
       WHERE m.role = 'Titular del proyecto'
         AND lower(a.name) NOT IN ('various artists','varios artistas','v.a.','va')
       ORDER BY a.id`);
    for (const row of rows) {
      const person = persons.get(Number(row.person_id));
      if (!person) continue;
      if (row.titulares > 1) { skipped.push({ id: person.id, name: person.name, target: row.artist_name, reason: `el artista ${row.artist_id} tiene más de un titular: no es un proyecto solista` }); continue; }
      if (answersTo(person, row.artist_name)) continue;
      // «Chulius & The Filarmónicos», «El Clan Spiteri»: es el grupo del titular, no un nombre suyo.
      if (/\s(&|y|and|con|e)\s|^(los|las|the|el clan)\s/iu.test(row.artist_name)) {
        skipped.push({ id: person.id, name: person.name, target: row.artist_name, reason: "el nombre del proyecto es el de un grupo: no es un nombre de la persona" });
        continue;
      }
      addAlias(person, person.name, row.artist_name, `Nombre del proyecto del que es titular (artista ${row.artist_id}), como «Canserbero» en Tirone González.`);
    }
  }

  let opened: { runId: number; opened: number; skipped: number } | null = null;
  if (process.argv.includes("--open-reviews") && reviews.length) {
    opened = await openPersonCandidateReviews(reviews.map(({ a, b, why }) => ({
      a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, score: 0.5,
      features: [{ key: "canserbero_same_person", value: 1, evidence: why }], priority: 6 as const,
    })), `Caso Canserbero extendido (${stage}): posibles fichas de la misma persona (Brian, 2026-10-02)`, "brian");
  }

  writeFileSync(planPath, `${JSON.stringify({ decidedAt: TODAY, evidence: `Caso Canserbero extendido, etapa «${stage}» (Brian, 2026-10-02). Ver scripts/plan-canserbero-extendido.ts.`, corrections }, null, 2)}\n`);
  writeFileSync(reportPath, skipped.map((row) => JSON.stringify(row)).join("\n") + (skipped.length ? "\n" : ""));
  console.log(JSON.stringify({ stage, plan: planPath, report: reportPath, ...count, corrections: corrections.length,
    skipped: skipped.length, reviewsProposed: reviews.length, reviews: opened,
    skippedByReason: skipped.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.reason.split(":")[0]!]: (acc[row.reason.split(":")[0]!] ?? 0) + 1 }), {}) }, null, 2));
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
