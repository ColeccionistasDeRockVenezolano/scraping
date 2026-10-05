// CRV · Curaduría 2026-10-05: personas de Metal Archives sin membresía.
//
// La importación de Metal Archives (2026-10-01) creó la ficha de estos músicos
// pero no su membresía. Su página de MA (person-details.jsonl) dice en qué
// bandas tocan y el cruce MA→catálogo (cruce-catalogo.jsonl) dice qué banda es
// cada una en el catálogo: se crea la membresía con rol y años de MA. Más
// Eddie Hermida (Wikipedia): vocalista de Suicide Silence desde 2013.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-ma-members.ts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { createRelation, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";

const OPERATOR = "claude-code";
const NOTE = "Curaduría 2026-10-05: membresía según la página de Metal Archives del músico (la importación creó la persona sin vínculo)";
const MA = "data/raw/metal-archives-ve-2026-10-01";
const jsonl = <T>(path: string): T[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);

interface Plan { personId: number; name: string; artistId: number; band: string; role: string; from: number | null; to: number | null; current: boolean }

/** «As M.: Vocals, Drums (2018-present)» → rol y años. */
function parseRole(raw: string): { role: string; from: number | null; to: number | null; current: boolean } {
  const text = raw.replace(/^As [^:]+:\s*/u, "").trim();
  const years = /\(([^()]*\d{4}[^()]*)\)\s*$/u.exec(text);
  const role = (years ? text.slice(0, years.index) : text).replace(/[,\s]+$/u, "").trim() || "Member";
  let from: number | null = null; let to: number | null = null; let current = false;
  if (years) {
    const nums = [...years[1]!.matchAll(/\d{4}/gu)].map((m) => Number(m[0]));
    from = nums.length ? Math.min(...nums) : null;
    current = /present/iu.test(years[1]!);
    to = current ? null : (nums.length ? Math.max(...nums) : null);
  }
  return { role, from, to, current };
}

async function main(): Promise<void> {
  const pool = getPool();
  const { rows: orphans } = await pool.query<{ id: string; name: string; url: string }>(`
    SELECT DISTINCT p.id::text, p.name, e.url FROM ingest.curation_findings f JOIN public.persons p ON p.id=f.entity_id
      JOIN ingest.claims c ON c.person_id=p.id JOIN ingest.sources s ON s.id=c.source_id AND s.slug='metal-archives'
      JOIN ingest.claim_evidence e ON e.claim_id=c.id
     WHERE f.status='open' AND f.detector='fichas_sin_vinculos' AND f.entity_kind='person' AND e.url LIKE '%metal-archives.com/artists/%'`);
  const details = new Map(jsonl<{ artist_id: string; bands: Array<{ band: string; band_id: string; role: string; tab: string }> }>(`${MA}/person-details.jsonl`).map((d) => [d.artist_id, d]));
  const cross = new Map(jsonl<{ ma_id: string; crv_artist_id: string | null }>(`${MA}/consolidado/cruce-catalogo.jsonl`)
    .filter((c) => c.crv_artist_id).map((c) => [c.ma_id, Number(c.crv_artist_id)]));
  // Bandas que el cruce dejó «nuevas» pero que ya entraron al catálogo con el mismo nombre (y no son homónimas: un solo artista).
  const fold = (t: string): string => t.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
  const byName = new Map<string, number[]>();
  for (const row of (await pool.query<{ id: string; name: string }>("SELECT id::text, name FROM public.artists")).rows) {
    byName.set(fold(row.name), [...(byName.get(fold(row.name)) ?? []), Number(row.id)]);
  }
  const plans: Plan[] = [];
  const unmatched: string[] = [];
  for (const orphan of orphans) {
    const maId = /\/(\d+)$/u.exec(orphan.url)?.[1];
    const detail = maId ? details.get(maId) : undefined;
    let any = false;
    for (const band of detail?.bands ?? []) {
      const named = byName.get(fold(band.band));
      const artistId = cross.get(band.band_id) ?? (named?.length === 1 ? named[0] : undefined);
      if (!artistId || /guest|live|session|misc/iu.test(band.tab)) continue;
      plans.push({ personId: Number(orphan.id), name: orphan.name, artistId, band: band.band, ...parseRole(band.role) });
      any = true;
    }
    if (!any) unmatched.push(`${orphan.id} ${orphan.name}`);
  }
  plans.push({ personId: 15367, name: "Hernán Hermida", artistId: 2340, band: "Suicide Silence", role: "Vocals", from: 2013, to: null, current: true });
  console.log(`${orphans.length} personas de MA sin vínculo · ${plans.length} membresías · sin banda en el catálogo: ${unmatched.length}`);
  for (const plan of plans) console.log(`  ${plan.name} → ${plan.band} (${plan.artistId}) · ${plan.role} ${plan.from ?? ""}-${plan.current ? "presente" : plan.to ?? ""}`);
  if (process.argv.includes("--confirm")) {
    const { runId } = await withOperatorRun({ name: "curation:ma-orphan-members", operator: OPERATOR, note: NOTE }, async (context: OperatorContext) => {
      for (const plan of plans) {
        await createRelation(context, "artist_membership", { artistId: plan.artistId, personId: plan.personId }, {
          role: plan.role, from_year: plan.from, to_year: plan.to, is_current: plan.current,
        });
      }
    });
    console.log(`run ${runId}`);
  }
  writeFileSync("reports/curaduria-2026-10-05/ma-members.json", JSON.stringify({ plans, unmatched }, null, 1));
  await closeDb();
}
void main();
