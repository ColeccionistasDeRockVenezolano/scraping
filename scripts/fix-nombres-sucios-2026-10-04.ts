// CRV · Bandeja «Nombres sucios» de Curaduría (Brian, 2026-10-04).
//
// Decisiones de Brian:
//   · MAYÚSCULAS SOSTENIDAS → capitalizar (con tildes y siglas repuestas).
//   · «Яitual» (Arca) se queda tal cual y gana el alias «Ritual».
//   · Créditos «Estudio (Persona» → el crédito va a los dos: la persona (fusionada
//     con su ficha si ya existe) y el estudio/banda como organización/artista.
//
// El resto es mecánico: quitar el «:» o «-» colgante, cerrar o quitar el signo,
// limpiar invisibles, dominio → alias, fusionar fragmentos con la ficha limpia,
// partir «A?B» en dos créditos y reubicar los créditos «hijo». Los emoticonos
// («Lloro :'(», «B-)») y los falsos positivos se ignoran con motivo.
//
// UN run de operador; cada caso en su SAVEPOINT. Sin --confirm corre y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/fix-nombres-sucios-2026-10-04.ts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import {
  createEntity, createRelation, deleteEntity, deleteRelation, updateEntity, updateRelation, withOperatorRun,
  type OperatorContext,
} from "../src/merge/operator.js";
import { createAlias, type AliasKind } from "../src/api/repositories/aliases.js";

const NOTE = "Nombres sucios de Curaduría (Brian, 2026-10-04)";
type Kind = "person" | "artist" | "organization" | "album" | "track";
type Step = (c: OperatorContext) => Promise<void>;
interface Finding { id: number; detector: string; entity_kind: Kind; entity_id: number; value: string; suggested_value: string | null }

class DryRun extends Error {
  constructor(readonly lines: string[], readonly stats: Record<string, number>) { super("dry-run"); }
}

const field = (kind: Kind): "name" | "title" => (kind === "album" || kind === "track" ? "title" : "name");
const rename = (kind: Kind, id: number, value: string): Step => async (c) => { await updateEntity(c, kind, id, { [field(kind)]: value }); };
const alias = (kind: AliasKind, id: number, value: string, aliasType = "other"): Step => async (c) => {
  // Al renombrar, el motor ya guarda el nombre anterior como alias.
  const spec = { person: "person_aliases", artist: "artist_aliases", organization: "organization_aliases", album: "album_aliases", track: "track_aliases" }[kind];
  const exists = await c.client.query(`SELECT 1 FROM ingest.${spec} WHERE ${kind}_id=$1 AND alias=$2`, [id, value]);
  if (!exists.rowCount) await createAlias(c, kind, id, { alias: value, aliasType, isPrimary: false });
};
const merge = (keep: number, drop: number, keepAlias = false, kind: "person" | "artist" | "organization" = "person"): Step => async (c) => {
  const preview = await previewEntityMerge(c.client, kind, keep, drop, { lock: true });
  await mergeEntities(c, { kind, keepId: keep, dropId: drop, previewHash: preview.previewHash, keepDropNameAsAlias: keepAlias, rewriteLater: true });
};
type Credit = { album?: number; track?: number; type: string; role: string };
const credit = (to: { personId?: number; artistId?: number; organizationId?: number }, cr: Credit): Step => async (c) => {
  const kind = cr.album ? "album_credit" : "track_credit";
  await createRelation(c, kind, { ...(cr.album ? { albumId: cr.album } : { trackId: cr.track! }), ...to }, { credit_type: cr.type, credit_role: cr.role });
};

// Entidades nuevas (estudios y bandas) que se crean una vez y se reutilizan.
const created = new Map<string, number>();
async function ensure(c: OperatorContext, kind: "organization" | "artist" | "person", name: string): Promise<number> {
  const key = `${kind}:${name}`;
  const known = created.get(key);
  if (known) return known;
  const table = kind === "organization" ? "organizations" : kind === "artist" ? "artists" : "persons";
  const existing = await c.client.query<{ id: string }>(`SELECT id FROM public.${table} WHERE lower(name)=lower($1) ORDER BY id LIMIT 1`, [name]);
  const id = existing.rows[0] ? Number(existing.rows[0].id) : (await createEntity(c, kind, { name }, { allowSimilar: true })).id;
  created.set(key, id);
  return id;
}
const creditNew = (kind: "organization" | "artist" | "person", name: string, credits: Credit[]): Step => async (c) => {
  const id = await ensure(c, kind, name);
  const to = kind === "organization" ? { organizationId: id } : kind === "artist" ? { artistId: id } : { personId: id };
  for (const cr of credits) await credit(to, cr)(c);
};

// Fichas cuyo hallazgo se resuelve con estos pasos (clave «kind:id»).
const PLAN: Record<string, { label: string; steps: Step[] }> = {};
const plan = (key: string, label: string, ...steps: Step[]) => { PLAN[key] = { label, steps }; };

// — Personas —
plan("person:34863", "Gustavo Aguado ← «(From Guaco: Gustavo Aguado» + Guaco", merge(339, 34863),
  credit({ artistId: 3709 }, { album: 4597, type: "musician", role: "Background Vocals" }));
plan("person:33642", "Gustavo Aguado ← «Guaco (Gustavo Aguado» + Guaco", merge(339, 33642),
  credit({ artistId: 3709 }, { track: 72075, type: "musician", role: "Backing Vocals" }));
plan("person:18591", "Wladimir Lozano ← fragmento de Dimensión Latina", merge(1042, 18591));
plan("person:18592", "Argenis Carruyo ← fragmento de Dimensión Latina", merge(1044, 18592));
plan("person:18595", "Juan Carlos Sabater ← fragmento de Fuga", merge(5793, 18595));
plan("person:18593", "Freddy Sánchez (fragmento de Dimensión Latina)", rename("person", 18593, "Freddy Sánchez"));
const factoria = (albums: number[]): Step => creditNew("organization", "Factoría Gráfica", albums.map((album) => ({ album, type: "artwork", role: "Graphic Design" })));
plan("person:20696", "Alejandro Calzadilla ← «Factoría Gráfica (Alejandro Calzadilla» + Factoría Gráfica",
  factoria([4106, 5534, 6130, 6226, 6558, 9123, 9594]), merge(5422, 20696));
plan("person:20742", "Alejandro Calzadilla ← «Factoria Gráfica (Alejandro Calzadilla» + Factoría Gráfica",
  factoria([6152, 8854, 9103]), merge(5422, 20742));
plan("person:36705", "Kamelot Agüero ← «Fusión IV (Kamelot Aguero» + Fusión IV",
  creditNew("artist", "Fusión IV", [{ track: 40441, type: "musician", role: "Vocals" }]), merge(7007, 36705));
plan("person:20345", "Pedro Quintero ← «Temática (Pedro Quintero» + Temática",
  creditNew("organization", "Temática", [{ album: 6021, type: "artwork", role: "Graphic Design" }]), merge(22881, 20345));
plan("person:34211", "Marco Granados ← «Triángulo (Marco Granados» + Triángulo",
  creditNew("organization", "Triángulo", [{ album: 9920, type: "producer", role: "Executive Producers" }]), merge(22635, 34211));
plan("person:38748", "P. Herrero ← «Mecenas (P. Herrero» + Mecenas",
  creditNew("organization", "Mecenas", [8143, 8144, 8145].map((album) => ({ album, type: "other", role: "Artistic Direction" }))), merge(9582, 38748));
plan("person:24530", "Valentina Curcó ← «Valentina Curcó)»", merge(21138, 24530), rename("person", 21138, "Valentina Curcó"));
plan("person:33620", "Simón «Toto» Ruiz + Caibo", rename("person", 33620, 'Simón "Toto" Ruiz'),
  credit({ artistId: 4726 }, { track: 72079, type: "musician", role: "Vocals" }));
plan("person:30308", "Musiu + Centro Nacional del Disco", rename("person", 30308, "Musiu"),
  creditNew("organization", "Centro Nacional del Disco", [{ album: 8520, type: "artwork", role: "Graphic Design" }]));
plan("person:34190", "Juan José Hernández + ODILA", rename("person", 34190, "Juan José Hernández"),
  credit({ artistId: 3990 }, { track: 157722, type: "musician", role: "Backing Vocals" }));
plan("person:33638", "Jairo Hernández + Los Chiquinquireñitos", rename("person", 33638, "Jairo Hernández"),
  creditNew("artist", "Los Chiquinquireñitos", [{ track: 72072, type: "musician", role: "Backing Vocals" }]));
for (const [id, name] of [
  [23212, "Gary Keller"], [38874, "M. de Calva"], [38868, "Atanase “Jean Cartier” Mironescu"], [34191, "Edinson Adrian"],
  [20743, "Frank Querales"], [33637, "Gabriela Marique"], [35366, "Jennie Silva"], [20346, "Jennifer Huizi"],
  [15528, "Luis “Prosti” Solano"], [23214, "Mike Brignola"], [16347, "Danny"], [16957, "Enrique"], [16348, "Teddy"],
  [39885, "Escuela de Vuelo"],
] as const) plan(`person:${id}`, name, rename("person", id, name));
for (const [id, name, domain] of [[31588, "DGenerador", "DGenerador.com"], [36502, "JC Socorro", "JC Socorro.com"], [36002, "Modovisual", "Modovisual.com"]] as const) {
  plan(`person:${id}`, `${name} (alias ${domain})`, rename("person", id, name), alias("person", id, domain));
}
plan("person:21491", "JCmixstudio ← JCmixstudio.com", merge(35323, 21491, true));
plan("person:39141", "Keloide ← Keloide.net", merge(37581, 39141, true));
plan("person:26136", "«Juan Vicente Torrealba?Ernesto Luís Rodríguez» → dos compositores",
  async (c) => { await updateRelation(c, "track_credit", 28200, { person_id: 4456 }); },
  credit({ personId: 9481 }, { track: 53879, type: "composer", role: "composer" }),
  async (c) => { await deleteEntity(c, "person", 26136); });
plan("person:39356", "«Tisuby González?Georgina León» → dos compositoras",
  async (c) => { for (const id of [61357, 61359]) await updateRelation(c, "track_credit", id, { person_id: 2122 }); },
  credit({ personId: 2123 }, { track: 6525, type: "composer", role: "composer" }),
  credit({ personId: 2123 }, { track: 6527, type: "composer", role: "composer" }),
  async (c) => { await deleteEntity(c, "person", 39356); });
plan("person:31955", "«hijo» → Juan Vicente Torrealba Jr. (maracas), Mariano Tito Jr. (bajo), nota en José Quintero",
  async (c) => {
    // «Juan Vicente Torrealba, hijo» y «Mariano Tito, hijo» se partieron en dos créditos.
    for (const [hijo, padre] of [[45496, 45495], [45505, 45504], [45512, 45511]] as const) {
      await updateRelation(c, "album_credit", hijo, { person_id: 31921 });
      await deleteRelation(c, "album_credit", padre);
    }
    await updateRelation(c, "album_credit", 52051, { person_id: 23923 });
    await deleteRelation(c, "album_credit", 22998);
    await deleteRelation(c, "album_credit", 54670);
    await updateRelation(c, "album_credit", 54669, { notes: "La fuente dice «José Quintero, hijo»." });
    await deleteEntity(c, "person", 31955);
  });
plan("person:18570", "«lead vocals)» (miembro basura de Wahala) → retirada",
  async (c) => { await deleteRelation(c, "artist_membership", 9152); await deleteEntity(c, "person", 18570); });

// — Artistas y organizaciones —
plan("artist:4465", "Grupo Quitiplas", rename("artist", 4465, "Grupo Quitiplas"));
plan("artist:4457", "Grupo de Parrandas", rename("artist", 4457, "Grupo de Parrandas"));
plan("artist:4362", "Grupo Mina + Miguel Urbina", rename("artist", 4362, "Grupo Mina"),
  credit({ personId: 21476 }, { album: 256, type: "musician", role: "Bata Drums" }));
plan("organization:3857", "Lucky Productions + Mariela Sosa", rename("organization", 3857, "Lucky Productions"),
  credit({ personId: 12919 }, { album: 3601, type: "photography", role: "Photo" }));
plan("organization:3970", "Villa Estudio Creativo + Jesús Villareal", rename("organization", 3970, "Villa Estudio Creativo"),
  creditNew("person", "Jesús Villareal", [{ album: 3589, type: "producer", role: "Executive Production" }]));
plan("organization:2334", "«House/Downtempo/» (sin vínculos) → retirada", async (c) => { await deleteEntity(c, "organization", 2334); });
plan("organization:1749", "«Uraniun/MP3.com» (sin vínculos) → retirada", async (c) => { await deleteEntity(c, "organization", 1749); });
plan("organization:2574", "Montaner Legacy LLC", rename("organization", 2574, "Montaner Legacy LLC"));

// — Discos —
for (const [id, title] of [
  [9118, "Alejandro Vargas Cien Años De Canto"], [9181, "Algo Más Que Un Aguinaldo"], [9406, "Serenata Guayanesa"],
  [9410, "Su Más Firme Aliado"], [9412, "Sueños De Fragua y Tiempo"], [6528, "Villa Sebucán"],
  [14106, "A Typical and Autoctonal Venezuelan Dance Band (Remastered)"],
  [14386, "Gounod: Ave Maria, G 89a (After J.S. Bach: Prelude in C Major, BWV 846) [Arr. Hazell for Voice & Orchestra]"],
] as const) plan(`album:${id}`, title, rename("album", id, title));
// Mismo resto de «Special Edition for» que el detector ya no marca (perdió el «:»).
plan("album:9178", "Serenata Guayanesa (1971)", rename("album", 9178, "Serenata Guayanesa"));
plan("album:12741", "«Яitual» + alias «Ritual»", alias("album", 12741, "Ritual", "alternate_title"));

// — Pistas —
for (const [id, title] of [
  [151523, "Caracas en el 2000 (Remix)"], [136839, "¿Dónde Está Er Futuro?"], [71447, "Tres Danzas Cubanas (Los Delirios de Rosita)"],
  [75007, "Recuerdos Nº 16"], [151891, "Nos Extraño (Interlude)"],
  [141522, "Lucía de Lammermoor: \"Oh, giusto cielo!... Il dolce suono\" (Lucia, \"Mad Scene\")"],
  [152813, "Ave Maria, G 89a (After J.S. Bach: Prelude in C Major, BWV 846) [Arr. Hazell for Voice & Orchestra]"],
  [152846, "Gounod: Ave Maria, G 89a (After J.S. Bach: Prelude in C Major, BWV 846) [Arr. Hazell for Voice & Orchestra]"],
] as const) plan(`track:${id}`, title, rename("track", id, title));
plan("track:149914", "«Яitual» + alias «Ritual»", alias("track", 149914, "Ritual", "alternate_title"));

// Hallazgos que se cierran como ignorados (no se toca el core).
const IGNORE: Record<string, { reason: "falso_positivo" | "correcto_a_proposito"; note: string }> = {
  "album:13868": { reason: "correcto_a_proposito", note: "emoticono «:'(» del título oficial" },
  "track:152018": { reason: "correcto_a_proposito", note: "emoticono «:'(» del título oficial" },
  "track:151930": { reason: "correcto_a_proposito", note: "emoticono «:'(» del título oficial" },
  "track:42389": { reason: "correcto_a_proposito", note: "emoticono «B-)» del título oficial" },
  "track:48341": { reason: "falso_positivo", note: "las comillas de «El 9» están cerradas" },
  "track:141000": { reason: "correcto_a_proposito", note: "enumeración a) b) c) d) de la obra" },
  "album:12741": { reason: "correcto_a_proposito", note: "grafía estilizada de Arca; alias «Ritual» añadido" },
  "track:149914": { reason: "correcto_a_proposito", note: "grafía estilizada de Arca; alias «Ritual» añadido" },
};

/** Mayúsculas sostenidas: la sugerencia del detector con tildes, «(En Vivo)» y siglas. */
function fixCaps(value: string): string {
  return value
    .replace(/\(en Vivo\)/gu, "(En Vivo)")
    .replace(/\bExitos\b/gu, "Éxitos").replace(/\bSinfonico\b/gu, "Sinfónico").replace(/\bJunin\b/gu, "Junín")
    .replace(/\bQuedate\b/gu, "Quédate").replace(/\bLlc\b/gu, "LLC");
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const { rows: findings } = await getPool().query<Finding>(`
    SELECT id::int, detector, entity_kind, entity_id::int, value, suggested_value
      FROM ingest.curation_findings WHERE category='nombres_sucios' AND status='open' ORDER BY id`);
  // Lo que no tiene plan explícito ni se ignora: la sugerencia del detector.
  for (const f of findings) {
    const key = `${f.entity_kind}:${f.entity_id}`;
    if (PLAN[key] || IGNORE[key]) continue;
    const suggested = f.suggested_value?.trim();
    if (!suggested || suggested === "∅") continue;
    const value = f.detector === "mayusculas_sostenidas" || f.detector === "signos_colgantes" ? fixCaps(suggested) : suggested;
    plan(key, `${f.value} → ${value}`, rename(f.entity_kind, f.entity_id, value));
  }
  const uncovered = findings.filter((f) => !PLAN[`${f.entity_kind}:${f.entity_id}`] && !IGNORE[`${f.entity_kind}:${f.entity_id}`]);
  let runId: number | null = null;
  let lines: string[];
  let stats: Record<string, number>;
  try {
    const done = await withOperatorRun({ name: "curation_dirty_names", operator: "brian", note: NOTE, params: { cases: Object.keys(PLAN).length } }, async (context) => {
      const out: string[] = [];
      const count: Record<string, number> = { casos: 0, fallidos: 0, ignorados: 0, sinPlan: uncovered.length };
      for (const [key, item] of Object.entries(PLAN)) {
        await context.client.query("SAVEPOINT caso");
        try {
          for (const step of item.steps) await step(context);
          await context.client.query("RELEASE SAVEPOINT caso");
          count["casos"]! += 1;
          out.push(`- ${key} · ${item.label}`);
        } catch (error) {
          await context.client.query("ROLLBACK TO SAVEPOINT caso");
          count["fallidos"]! += 1;
          out.push(`- FALLÓ ${key} · ${item.label}: ${(error as Error).message.slice(0, 200)}`);
        }
      }
      for (const [key, ignore] of Object.entries(IGNORE)) {
        const [kind, id] = key.split(":");
        const result = await context.client.query(`
          UPDATE ingest.curation_findings
             SET status='ignored', ignored_at=now(), ignored_by='brian', ignore_reason=$3, ignore_note=$4
           WHERE category='nombres_sucios' AND status='open' AND entity_kind=$1 AND entity_id=$2`,
        [kind, Number(id), ignore.reason, `[run ${context.runId}] ${ignore.note}`]);
        count["ignorados"]! += result.rowCount ?? 0;
      }
      for (const f of uncovered) out.push(`- SIN PLAN ${f.entity_kind}:${f.entity_id} «${f.value}» (${f.detector})`);
      if (!confirm) throw new DryRun(out, count);
      return { lines: out, stats: count };
    });
    runId = done.runId;
    ({ lines, stats } = done.result);
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    ({ lines, stats } = error);
  }
  const mode = confirm ? "confirm" : "dry-run";
  const file = `reports/nombres-sucios-2026-10-04-${mode}${runId ? `-run${runId}` : ""}.md`;
  const summary = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join(" · ");
  writeFileSync(file, [`# Nombres sucios (${mode}${runId ? `, run ${runId}` : ""})`, "", NOTE, "", summary, "", ...lines, ""].join("\n"));
  console.log(`${mode}${runId ? ` run ${runId}` : ""}: ${summary}\n${file}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
