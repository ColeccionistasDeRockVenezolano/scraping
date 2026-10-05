// CRV · Curaduría 2026-10-05: discos dobles que el reconstructor de Sincopa aplanó en un disco.
//
// rebuild-sincopa-order numeró 1…n en el orden de la ficha, pero la ficha de un CD doble (CD1/CD2) o de
// un CD+DVD reinicia la numeración en cada medio: el resultado fue un solo disco de 30+ pistas con
// títulos repetidos (el DVD en vivo repite las canciones del CD). Aquí cada pista vuelve a su medio:
// la sección de la ficha (CD1, CD2, DVD…) da el disco y el orden dentro de la sección, el número.
// Solo se toca un disco si cada pista coincide en título con su entrada de la ficha; las pistas de
// otras fuentes que el reconstructor dejó al final siguen en el disco 1, tras las de la ficha.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-split-discs.ts --albums=1,2 [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: disco doble (CD1/CD2 o CD+DVD) que el orden de Sincopa había aplanado; cada pista vuelve a su medio según la ficha";
const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const decode = (s: string): string => s.replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&#(\d+);/gu, (_, n: string) => String.fromCharCode(Number(n)))
  .replace(/&([a-z]+);/giu, (m, name: string) => ({ aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü", quot: "\"", rsquo: "'", lsquo: "'" } as Record<string, string>)[name] ?? m);

/** Secciones de la lista de pistas de la ficha: cada medio con los títulos de sus entradas numeradas. */
function sections(html: string): Array<{ label: string; titles: string[] }> {
  const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/giu, "").replace(/<[^>]+>/gu, "\n"));
  const tokens = text.split("\n").map((t) => t.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const start = tokens.indexOf("Tracks");
  const out: Array<{ label: string; titles: string[] }> = [{ label: "", titles: [] }];
  let current: string[] | null = null;
  for (const token of tokens.slice(start + 1)) {
    if (/^(Musicians|Other|Credits|Guest Musicians:?)$/u.test(token)) break;
    if (/^(CD|DVD|Dis[ck]o?)\s*\d?$/iu.test(token)) {
      if (out[out.length - 1]!.titles.length) out.push({ label: token, titles: [] }); else out[out.length - 1]!.label = token;
      current = null; continue;
    }
    const numbered = /^(\d{1,2})-\s*(.*)$/u.exec(token);
    if (numbered) { out[out.length - 1]!.titles.push(numbered[2] ?? ""); current = out[out.length - 1]!.titles; continue; }
    if (token === "*" || /^(Bonus|Side|Lado)/iu.test(token)) { current = null; continue; }
    if (current) current[current.length - 1] = `${current[current.length - 1]} ${token}`.trim();
  }
  return out.filter((section) => section.titles.length);
}

const same = (a: string, b: string): boolean => {
  const x = fold(a); const y = fold(b.replace(/\(\s*featuring.*$/iu, ""));
  return x === y || x.replace(/ /gu, "") === y.replace(/ /gu, "") || x.startsWith(y) || y.startsWith(x) || (x.split(" ")[0] === y.split(" ")[0] && x.slice(0, 6) === y.slice(0, 6));
};

interface Plan { albumId: number; status: string; detail: string[] }

async function planAlbum(client: PoolClient, albumId: number, apply: boolean): Promise<Plan> {
  const { rows: pages } = await client.query<{ stored_path: string }>(`
    SELECT DISTINCT r.stored_path FROM ingest.claims c JOIN public.tracks t ON t.id=c.track_id JOIN ingest.raw_pages r ON r.id=c.raw_page_id
     WHERE t.album_id=$1 AND c.source_id=7`, [albumId]);
  if (pages.length !== 1) return { albumId, status: "omitido", detail: [`${pages.length} fichas`] };
  const parts = sections(readFileSync(`data/${pages[0]!.stored_path}`, "latin1"));
  if (parts.length < 2) return { albumId, status: "omitido", detail: ["un solo medio"] };
  const { rows: tracks } = await client.query<{ id: string; disc_number: number; track_number: number; title: string }>(
    "SELECT id::text, disc_number, track_number, title FROM public.tracks WHERE album_id=$1 ORDER BY disc_number, track_number", [albumId]);
  if (tracks.some((t) => t.disc_number !== 1)) return { albumId, status: "omitido", detail: ["ya tiene varios discos"] };
  const flat = parts.flatMap((part, disc) => part.titles.map((title, index) => ({ disc: disc + 1, number: index + 1, title })));
  const detail: string[] = [];
  const moves: Array<{ id: number; disc: number; number: number }> = [];
  for (const track of tracks) {
    const slot = flat[track.track_number - 1];
    if (!slot) continue;
    if (!same(track.title, slot.title)) detail.push(`${track.track_number} «${track.title}» ≠ «${slot.title}»`);
    moves.push({ id: Number(track.id), disc: slot.disc, number: slot.number });
  }
  if (detail.length) return { albumId, status: "manual", detail };
  const extras = tracks.filter((t) => t.track_number > flat.length);
  const disc1 = parts[0]!.titles.length;
  extras.forEach((track, index) => moves.push({ id: Number(track.id), disc: 1, number: disc1 + index + 1 }));
  detail.push(parts.map((p) => `${p.label || "?"}:${p.titles.length}`).join(" "), ...extras.map((t) => `al final del disco 1: «${t.title}»`));
  if (apply) {
    await client.query("UPDATE public.tracks SET track_number=track_number+10000 WHERE album_id=$1", [albumId]);
    for (const move of moves) await client.query("UPDATE public.tracks SET disc_number=$2, track_number=$3 WHERE id=$1", [move.id, move.disc, move.number]);
    const { rows: left } = await client.query("SELECT id FROM public.tracks WHERE album_id=$1 AND track_number>10000", [albumId]);
    if (left.length) throw new Error(`disco ${albumId}: ${left.length} pistas sin numerar`);
  }
  return { albumId, status: "cambia", detail };
}

const albums = arg("albums")!.split(",").map(Number);
const plans: Plan[] = [];
const run = async (client: PoolClient): Promise<void> => {
  for (const albumId of albums) {
    await client.query("SAVEPOINT a");
    try { plans.push(await planAlbum(client, albumId, true)); await client.query("RELEASE SAVEPOINT a"); }
    catch (error) { await client.query("ROLLBACK TO SAVEPOINT a"); plans.push({ albumId, status: "error", detail: [String(error)] }); }
  }
};
const confirm = process.argv.includes("--confirm");
if (confirm) {
  const { runId } = await withOperatorRun({ name: "curation:split-flattened-discs", operator: "claude-code", note: NOTE }, ({ client }) => run(client));
  console.log(`run ${runId}`);
} else {
  const client = await getPool().connect();
  try { await client.query("BEGIN"); await run(client); } finally { await client.query("ROLLBACK"); client.release(); }
}
for (const plan of plans) console.log(plan.albumId, plan.status, plan.detail.join(" | "));
writeFileSync(`reports/curaduria-2026-10-05/split-discs-${confirm ? "confirm" : "dry-run"}.json`, JSON.stringify(plans, null, 1));
await closeDb();
