// CRV · Curaduría 2026-10-05: invitados escritos en el título («(feat. X)», «(ft. X & Y)», «(con X)»).
//
// La acción genérica crea UNA persona con todo el texto («A & B») y trata a las bandas como personas.
// Aquí cada nombre se separa (« & », «, », « y » — salvo nombres que ya existen enteros, como
// «Carota, Ñema y Tajá») y se acredita como invitado a la ficha que ya existe: primero el artista,
// luego la persona (también por alias); solo si no existe se crea la persona.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-extract-guests.ts --ids=<json de hallazgos> [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { createEntity, createRelation, updateEntity, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const NOTE = "Curaduría 2026-10-05: invitado escrito en el título; el título queda limpio y cada invitado recibe su crédito (artista o persona existente)";
const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const FEAT = /\s*[([](?:feat\.?|ft\.?|featuring|con)\s+([^)\]]+)[)\]]/iu;
/** Nombres que la fuente escribe distinto a la ficha. */
const SAME: Record<string, string> = {
  "huascar barradas": "Huáscar Barradas", "rafael el pollo brito": "Rafael \"Pollo\" Brito", "el pollo brito": "Rafael \"Pollo\" Brito",
  "celilia todd": "Cecilia Todd", "lil supa": "Lil Supa'", "adso": "Adso Alejandro", "nene quintero": "Carlos \"Nene\" Quintero",
  "alvaro paiva bimbo": "Álvaro Paiva-Bimbo",
};
const OVERRIDE: Record<number, { title: string; guests: string[] }> = {
  484140: { title: "Tu cuerpo bailando en mi cuerpo (Merengue electrónico remix)", guests: ["Sohanny"] },
  484111: { title: "Ramoncito en Cimarrona", guests: ["Tico Páez", "Carota, Ñema y Tajá", "Alexis Cárdenas"] },
  // Ninguna de las fichas «Carlos Méndez» es el cantante de la Cantoría (son un guitarrista y un baterista).
  484170: { title: "Los Pastores de San Joaquín", guests: ["Gilberto Rebolledo", "Carolina Arnal", "new:Carlos Méndez"] },
  484178: { title: "Como te gusta", guests: ["C-Funk", "person:3039"] },
};

type Target = { kind: "artist" | "person"; id: number; name: string };
async function resolve(client: PoolClient, raw: string): Promise<Target | null> {
  if (raw.startsWith("new:")) return { kind: "person", id: 0, name: raw.slice(4) };
  const fixed = /^(person|artist):(\d+)$/u.exec(raw);
  if (fixed) return { kind: fixed[1] as "person" | "artist", id: Number(fixed[2]), name: raw };
  const name = SAME[fold(raw)] ?? raw;
  const key = fold(name);
  const artist = (await client.query<{ id: string; name: string }>(`
    SELECT a.id::text, a.name FROM public.artists a WHERE lower(a.name)=lower($1)
    UNION SELECT a.id::text, a.name FROM ingest.artist_aliases x JOIN public.artists a ON a.id=x.artist_id WHERE lower(x.alias)=lower($1)`, [name])).rows;
  const artistHit = artist.filter((row) => fold(row.name) === key || true);
  if (artistHit.length === 1) return { kind: "artist", id: Number(artistHit[0]!.id), name: artistHit[0]!.name };
  const person = (await client.query<{ id: string; name: string }>(`
    SELECT p.id::text, p.name FROM public.persons p WHERE lower(p.name)=lower($1)
    UNION SELECT p.id::text, p.name FROM ingest.person_aliases x JOIN public.persons p ON p.id=x.person_id WHERE lower(x.alias)=lower($1)`, [name])).rows;
  if (person.length === 1) return { kind: "person", id: Number(person[0]!.id), name: person[0]!.name };
  if (artist.length > 1 || person.length > 1) return null;
  return { kind: "person", id: 0, name };
}
async function splitGuests(client: PoolClient, text: string): Promise<string[]> {
  if ((await resolve(client, text))?.id) return [text];
  const parts = text.split(/\s*,\s*|\s+&\s+/u);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    // «Carota, Ñema y Tajá»: si unir con la siguiente da un artista existente, va junto.
    const joined = parts[i + 1] !== undefined ? `${parts[i]}, ${parts[i + 1]}` : "";
    if (joined && (await resolve(client, joined))?.id) { out.push(joined); i += 1; continue; }
    const part = parts[i]!;
    if (/\sy\s/u.test(part) && !(await resolve(client, part))?.id) out.push(...part.split(/\s+y\s+/u)); else out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const ids = JSON.parse(readFileSync(arg("ids")!, "utf8")) as number[];
const pool = getPool();
const plans: Array<{ findingId: number; trackId: number; before: string; title: string; guests: Array<Target | string> }> = [];
const client = await pool.connect();
try {
  for (const id of ids) {
    const { rows: [row] } = await client.query<{ track_id: string; title: string }>(
      "SELECT t.id::text AS track_id, t.title FROM ingest.curation_findings f JOIN public.tracks t ON t.id=f.entity_id WHERE f.id=$1 AND f.status='open'", [id]);
    if (!row) continue;
    const override = OVERRIDE[id];
    const match = FEAT.exec(row.title);
    if (!override && !match) continue;
    const title = override?.title ?? row.title.replace(FEAT, "").replace(/\s{2,}/gu, " ").trim()
      // «X - Extendida», «X - Orestes Gomez Remix»: la versión va entre paréntesis (el guion se lee como «Artista - Título»).
      .replace(/ - (Extendida|Acústica|Extended Version|[^-]*Remix)$/u, " ($1)");
    const names = override?.guests ?? await splitGuests(client, match![1]!.trim());
    const guests: Array<Target | string> = [];
    for (const name of names) guests.push((await resolve(client, name)) ?? `AMBIGUO:${name}`);
    plans.push({ findingId: id, trackId: Number(row.track_id), before: row.title, title, guests });
  }
} finally { client.release(); }
for (const plan of plans) console.log(`${plan.before} → «${plan.title}» + ${plan.guests.map((g) => typeof g === "string" ? g : `${g.kind}:${g.id || "nueva"}:${g.name}`).join(" | ")}`);
if (process.argv.includes("--confirm")) {
  const { runId } = await withOperatorRun({ name: "curation:extract-guests", operator: "claude-code", note: NOTE }, async (context: OperatorContext) => {
    const created = new Map<string, number>();
    for (const plan of plans) {
      if (plan.guests.some((g) => typeof g === "string")) continue;
      await updateEntity(context, "track", plan.trackId, { title: plan.title });
      for (const guest of plan.guests as Target[]) {
        let id = guest.id;
        if (guest.kind === "person" && !id) {
          id = created.get(fold(guest.name)) ?? Number((await createEntity(context, "person", { name: guest.name }, { allowSimilar: true })).id);
          created.set(fold(guest.name), id);
        }
        const endpoints = guest.kind === "artist" ? { trackId: plan.trackId, artistId: id } : { trackId: plan.trackId, personId: id };
        await createRelation(context, "track_credit", endpoints, { credit_type: "guest", credit_role: "Invitado" });
      }
    }
  });
  console.log(`run ${runId}`);
}
writeFileSync("reports/curaduria-2026-10-05/extract-guests.json", JSON.stringify(plans, null, 1));
await closeDb();
