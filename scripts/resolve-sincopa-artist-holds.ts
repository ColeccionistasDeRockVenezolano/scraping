// Artistas de Sincopa que la promoción masiva dejó abiertos (nombre casi igual
// o igual a otro del core, o sin decisión de ER), decididos con evidencia
// (2026-10-03):
//
//  * same: el artista del core ya tiene los discos de la ficha (Agni Mogollón,
//    Grupo Palo De Arco), o el nombre solo cambia en tildes o en la grafía
//    (Rigel Mitxelena = Rigel Michelena, OSV = Orquesta Sinfónica de Venezuela).
//  * new: colaboraciones («Franco De Vita & Ilan Chester»), que en el core son
//    artistas propios como «Simón Díaz & Quinto Criollo», y nombres que solo se
//    parecen a otro («Kurare» ≠ «KurareX», «Sistema 2» ≠ «Sistema X»).
//  * Siguen abiertos «Oscar», «Juan Carlos» y «Grupo»: nombres truncados o
//    que juntan varios artistas.
//
// Después hay que repetir la promoción de discos y pistas de las secciones
// (scripts/promote-sincopa.ts): sus padres ya tienen destino.
//
//   tsx scripts/resolve-sincopa-artist-holds.ts                      # ensayo
//   tsx scripts/resolve-sincopa-artist-holds.ts --confirm --note="…"
import { closeDb, getDb, getPool } from "../src/db/client.js";
import { withRunScope } from "../src/db/run-binding.js";
import { scrapeRuns } from "../src/db/schema/ingest.js";
import { finishRun } from "../src/ingest/runs.js";
import { approveEntity } from "../src/review/approval.js";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

type Decision = { name: string; same: number; why: string } | { name: string; same?: undefined; why: string };

const SAME = (name: string, same: number, why: string): Decision => ({ name, same, why });
const NEW = (name: string, why: string): Decision => ({ name, why });

const DECISIONS: Decision[] = [
  SAME("Rigel Mitxelena", 213, "Rigel Michelena: grafía vasca del apellido; ya tiene «Bartok's Room» y «Mitxelena 3: Nauthiz»"),
  SAME("Virgilio Araque Reyes", 1355, "Virgilio Araque: ya tiene «Jamin in Venez» y «En Concierto»"),
  SAME("Orquesta Sinfónica Venezuela (OSV)", 2944, "Orquesta Sinfónica de Venezuela: ya tiene el «Concierto De Las Tres Esferas»"),
  SAME("Orquesta Sinfónica Gran Mariscal de Ayacucho", 3416, "la misma con la sigla (OSGMA): ya tiene «Beethoven», «Navidad Sinfónica», «Venezuela Sinfónica»"),
  SAME("Venezuela Suite (Series)", 3422, "«Venezuela Suite (Series) - Freddy León»: la misma serie"),
  SAME("Gillman", 1951, "los discos de la banda («Escalofrío», «Cuauhtemoc», «El Guerrero») ya están bajo Paul Gillman"),
  SAME("Licio Lugarini", 1989, "Licio Lugarini Melloni «Licho»: ya tiene el disco «Licho»"),
  SAME("Gusanos", 157, "Los Gusanos: ya tiene «Días De Furia»"),
  SAME("Esteban Demián", 3757, "Esteban Demian: solo cambia la tilde"),
  SAME("Daiquiri", 3693, "Daiquirí: solo cambia la tilde; ya tiene «La Historia»"),
  SAME("Los Sinverguenzas", 3982, "Los Sinvergüenzas: ya tiene «Bichoneando», «Desde Otro Lugar» y «20.20»"),
  SAME("Eduardo Soto Soto Blues Band", 1925, "Eduardo Soto: su disco es «Soto Blues Band»"),
  SAME("Abraham Gustin", 1843, "ya tiene «Blue» y «La Casa De David»"),
  SAME("Agni Mogollón", 1832, "ya tiene «Entre Duendes», «Propias y Ajenas» y «Living Rock & Blues»"),
  SAME("Alexis Peña", 379, "ya tiene «Alexis»"),
  SAME("Alexis Rossell", 1387, "ya tiene «Al Rescate», «Torbellino», «Sangre Negra»…"),
  SAME("Al Zeppy / Alberto Lewis", 1861, "Al Zeppy: ya tiene «Al Zeppy En New York» y «El Zeppy»"),
  SAME("P", 3798, "nombre truncado de Grupo Palo De Arco: ya tiene «Ay Que Mujer!» y «Que Palo De Arco»"),
  SAME("Grupo P", 3798, "nombre truncado de Grupo Palo De Arco: ya tiene «El Enamorao», «Mi Negra», «Palo De Arco Vol.3»"),

  NEW("Coral Lombana", "jazz; «Coral» (434) es otro proyecto (thrash)"),
  NEW("Impromptu Trio", "jazz; «Impromptu» (3057) es una banda de metal"),
  NEW("La Banda Municipal", "«La Banda de» (1798) es otra"),
  NEW("María Rivas & Aldemaro Romero", "colaboración"),
  NEW("Víctor Cuica & Roberto Jirón", "colaboración"),
  NEW("Juan Francisco Sans & Luis Gómez Imbert", "colaboración"),
  NEW("Orfeón Lamas & Orquesta Sinfónica Venezuela", "colaboración"),
  NEW("Juan Carlos Salazar", "«Carlos Salazar» (2865) es otro nombre; el dúo con Hernán Gamboa (3788) sigue aparte"),
  NEW("La Gente De La Ciudad", "«La Gente» (1661) es otra"),
  NEW("Salón Carmín", "«Salón» (2075) es otra"),
  NEW("Sistema 2", "«Sistema X» (1699) es otra"),
  NEW("Evio Di Marzo y su Adrenalina Caribe", "agrupación propia, como «Oscar D' León y Su Salsa Mayor»"),
  NEW("Alma Juvenil Conjunto Estudiantil", "«Alma» (448) es una banda de rock"),
  NEW("Kurare", "«KurareX» (902) es otra"),
  NEW("Serenata Guayanesa y Gualberto Ibarreto", "colaboración"),
  NEW("A Trio", "«C4 Trío» (53) es otro"),
  NEW("Al & El", "dúo; no es Al Zeppy"),
  NEW("Eduardo Betancourt", "«Eduardo» (1924) es otra"),
  NEW("Ensamble 4", "«Ensamble 2» (2702) es otro"),
  NEW("Vytas Brenner & Paulette Dozier", "colaboración"),
  NEW("Guillermo Carrasco & Pedro Castillo", "colaboración"),
  NEW("Julio César & The Band", "agrupación con nombre propio, como «Frankie & The Blue Devils»"),
  NEW("Kiara y Melissa", "colaboración"),
  NEW("Luz Marina y Gustavo Carucí", "colaboración"),
  NEW("Pentágono - Témpano", "disco compartido de dos bandas"),
  NEW("Pedro Castillo & OSV", "colaboración"),
  NEW("Franco De Vita & Ilan Chester", "colaboración"),
  NEW("Cherry Navarro con Chelique Sarabia y Aníbal Abreu", "colaboración"),
  NEW("Melancólicos Anónimos & Rosa", "colaboración"),
];

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const note = arg("note") ?? "Sincopa: artistas abiertos de la promoción, decididos con evidencia del core";
  const pool = getPool();
  const plan: Array<Decision & { identityKey?: string; target?: string; status: string }> = [];
  for (const decision of DECISIONS) {
    const { rows } = await pool.query<{ identity_key: string }>(`
      SELECT DISTINCT identity_key FROM ingest.claims
       WHERE source_id=(SELECT id FROM ingest.sources WHERE slug='sincopa') AND entity_kind='artist'
         AND status='candidate' AND identity_raw=$1`, [decision.name]);
    if (rows.length !== 1) { plan.push({ ...decision, status: rows.length === 0 ? "sin claims candidatos" : "varias identidades" }); continue; }
    let target: string | undefined;
    if (decision.same !== undefined) {
      const { rows: [artist] } = await pool.query<{ name: string }>("SELECT name FROM public.artists WHERE id=$1", [decision.same]);
      if (!artist) { plan.push({ ...decision, status: "el artista destino no existe" }); continue; }
      target = artist.name;
    }
    plan.push({ ...decision, identityKey: rows[0]!.identity_key, ...(target === undefined ? {} : { target }), status: "pendiente" });
  }

  let runId: number | undefined;
  if (confirm) {
    const [run] = await getDb().insert(scrapeRuns).values({ kind: "merge_run", status: "running", params: { action: "resolve-sincopa-artist-holds", note } }).returning();
    if (!run) throw new Error("no se pudo abrir el run");
    runId = run.id;
    const reason = `[run ${run.id}] ${note}`;
    await withRunScope(run.id, async () => {
      for (const item of plan) {
        if (item.status !== "pendiente" || item.identityKey === undefined) continue;
        const reference = `${item.why} (resolve-sincopa-artist-holds, run ${run.id})`;
        try {
          const result = await approveEntity("artist", item.identityKey, `${reason} · ${item.why}`, {
            humanResolution: item.same === undefined
              ? { verdict: "different", decidedBy: "brian", reference }
              : { verdict: "same", targetId: item.same, decidedBy: "brian", reference },
          });
          item.status = `aplicado (${result.applied} aplicados, ${result.unchanged} sin cambio, ${result.stillCandidate} candidatos) → ${result.targetId ?? "?"}`;
        } catch (error) {
          item.status = `error: ${(error as Error).message}`;
        }
      }
    });
    await finishRun(run.id, plan.some((item) => item.status.startsWith("error")) ? "partial" : "ok", { decisions: plan.length });
  }
  for (const item of plan) console.log(`${item.status.padEnd(14).slice(0, 80)} | ${item.name}${item.same === undefined ? " → nuevo" : ` → ${item.same} «${item.target ?? "?"}»`}`);
  console.log(JSON.stringify({ dryRun: !confirm, runId, decisions: plan.length }));
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
