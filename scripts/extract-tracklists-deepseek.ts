// CRV · Lista de pistas de los discos que no tienen ninguna, leída por DeepSeek
// flash (Brian, 2026-09-28) de las páginas YA guardadas en data/raw: el post o
// la entrada de la que salió el disco. Una llamada por disco.
//
// DeepSeek no escribe nada: propone la lista y este script la valida contra el
// texto. Se acepta solo si
//   * el título del disco aparece en el texto que se le pasó;
//   * cada título de pista aparece literalmente en ese texto (sin distinguir
//     mayúsculas, tildes ni espacios);
//   * los números van 1..N sin huecos en cada cara/disco;
//   * cada duración propuesta aparece también en el texto.
// Lo demás queda como rechazado con el motivo. Aplica scripts/apply-tracklists.ts.
//
//   npx tsx scripts/extract-tracklists-deepseek.ts [--ids=1,2] [--limit=N] [--concurrency=8]
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { z } from "zod";
import { createDeepSeekGateway } from "../src/ai/gateway.js";
import { closeDb, getPool } from "../src/db/client.js";

const DATE = "2026-09-28";
const OUT = `reports/tracklists-deepseek-${DATE}.jsonl`;
const MAX_TEXT = 9000;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ids = (arg("ids") ?? "").split(",").filter(Boolean).map(Number);
const limit = Number(arg("limit") ?? Infinity);
const concurrency = Number(arg("concurrency") ?? 8);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’‘`´]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, " ").trim();

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|td)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&quot;/gu, '"').replace(/&#39;|&#039;/gu, "'")
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&#(\d+);/gu, (_m, n: string) => String.fromCodePoint(Number(n)))
    .split("\n").map((l) => l.replace(/[ \t]+/gu, " ").trim()).filter(Boolean).join("\n");
}

interface Page { slug: string; url: string; storedPath: string; evidenceUrl: string | null }
interface Dossier { albumId: number; artist: string; title: string; year: number | null; texts: Array<{ url: string; text: string }> }

/** El texto del post/página del disco dentro del archivo guardado. */
function pageText(page: Page): { url: string; text: string } | null {
  const file = `data/${page.storedPath}`;
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "latin1");
  const body = /^\s*[[{]/u.test(raw) ? readFileSync(file, "utf8") : raw;
  if (/^\s*[[{]/u.test(body)) {
    const data = JSON.parse(body) as unknown;
    // Blogger: feed.entry[]; WordPress: array de páginas/posts.
    const entries = (data as { feed?: { entry?: unknown[] } }).feed?.entry ?? (Array.isArray(data) ? data : []);
    for (const entry of entries as Array<Record<string, unknown>>) {
      const links = (entry["link"] as Array<{ rel?: string; href?: string }> | string | undefined);
      const href = typeof links === "string" ? links : (links ?? []).find((l) => l.rel === "alternate")?.href;
      if (!page.evidenceUrl || href !== page.evidenceUrl) continue;
      const title = (entry["title"] as { $t?: string; rendered?: string } | undefined);
      const content = (entry["content"] as { $t?: string; rendered?: string } | undefined);
      const text = htmlToText(`${title?.$t ?? title?.rendered ?? ""}\n${content?.$t ?? content?.rendered ?? ""}`);
      return { url: href, text };
    }
    return null;
  }
  // Sincopa (latin1) y WordPress en HTML: la página entera.
  const html = /charset=["']?utf-8/iu.test(raw.slice(0, 2000)) ? readFileSync(file, "utf8") : raw;
  return { url: page.url, text: htmlToText(html) };
}

/** Ventana del texto alrededor de la primera mención del título del disco. */
function windowAround(text: string, title: string): string | null {
  const folded = fold(text);
  const key = fold(title);
  if (!key) return null;
  // fold() conserva la longitud salvo en espacios: se busca en una versión alineada.
  const lines = text.split("\n");
  const foldedLines = lines.map(fold);
  const hit = foldedLines.findIndex((l) => l.includes(key));
  if (hit < 0) return folded.includes(key) ? text.slice(0, MAX_TEXT) : null;
  const start = Math.max(0, hit - 15);
  let out = lines.slice(start, start + 400).join("\n");
  if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT);
  return out;
}

async function loadDossiers(): Promise<Dossier[]> {
  const rows = (await getPool().query<{ album_id: string; artist: string; title: string; year: number | null; slug: string; url: string; stored_path: string; evidence_url: string | null }>(`
    SELECT DISTINCT a.id::text AS album_id, ar.name AS artist, a.title, a.release_year AS year, so.slug, rp.url, rp.stored_path, ce.url AS evidence_url
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
      JOIN ingest.claims c ON c.album_id=a.id AND c.raw_page_id IS NOT NULL
      JOIN ingest.raw_pages rp ON rp.id=c.raw_page_id JOIN ingest.sources so ON so.id=rp.source_id
      LEFT JOIN ingest.claim_evidence ce ON ce.claim_id=c.id
     WHERE NOT EXISTS (SELECT 1 FROM public.tracks t WHERE t.album_id=a.id)
       AND (cardinality($1::bigint[])=0 OR a.id=ANY($1::bigint[]))
     ORDER BY 1`, [ids])).rows;
  const byAlbum = new Map<number, Dossier>();
  const seenText = new Set<string>();
  for (const row of rows) {
    const albumId = Number(row.album_id);
    const dossier = byAlbum.get(albumId) ?? { albumId, artist: row.artist, title: row.title, year: row.year, texts: [] };
    byAlbum.set(albumId, dossier);
    const page = pageText({ slug: row.slug, url: row.url, storedPath: row.stored_path, evidenceUrl: row.evidence_url });
    if (!page) continue;
    const windowed = windowAround(page.text, row.title);
    if (!windowed) continue;
    const key = `${albumId}:${page.url}`;
    if (seenText.has(key) || dossier.texts.length >= 3) continue;
    seenText.add(key);
    dossier.texts.push({ url: page.url, text: windowed });
  }
  return [...byAlbum.values()];
}

const trackSchema = z.object({
  disc: z.number().int().positive().default(1),
  position: z.number().int().positive(),
  title: z.string().min(1),
  duration: z.string().nullable().default(null),
});
const responseSchema = z.object({
  albumId: z.number().int(),
  found: z.boolean(),
  sourceUrl: z.string().nullable().default(null),
  tracks: z.array(trackSchema).default([]),
  note: z.string().nullable().default(null),
});

const INSTRUCTIONS = [
  "Recibes UN disco (albumId, artista, título, año) y uno o varios textos de páginas guardadas donde aparece ese disco.",
  "Tarea: si algún texto trae la LISTA DE PISTAS de ESTE disco (no de otro disco del mismo artista), devuélvela.",
  "Devuelve un objeto JSON: {albumId, found, sourceUrl, tracks:[{disc, position, title, duration}], note}.",
  "Reglas:",
  "- Copia cada título EXACTAMENTE como está en el texto (misma ortografía y mayúsculas), sin el número de pista, sin la duración y sin",
  "  créditos entre paréntesis que no sean parte del título (p. ej. el autor de la canción). No traduzcas ni corrijas.",
  "- position: número de la pista dentro de su disco/cara, empezando en 1. Si el disco tiene caras A/B, numera seguido (A1=1, A2=2, B1=3…) con disc=1.",
  "  Si hay CD1/CD2 usa disc=1 y disc=2 y reinicia position.",
  "- duration: solo si el texto la da junto a esa pista (formato m:ss o mm:ss tal cual aparece); si no, null.",
  "- Si el texto habla de varios discos, usa solo la lista que corresponde a ESTE título (y año, si lo hay).",
  "- Si no hay lista de pistas clara para este disco, found=false y tracks=[]. Nunca inventes ni completes pistas que no estén en el texto.",
  "- sourceUrl: la url del texto del que sacaste la lista.",
].join("\n");

function validate(dossier: Dossier, answer: z.infer<typeof responseSchema>): string[] {
  const problems: string[] = [];
  if (!answer.found || answer.tracks.length === 0) return ["sin lista"];
  const source = dossier.texts.find((t) => t.url === answer.sourceUrl) ?? dossier.texts[0]!;
  const text = fold(dossier.texts.map((t) => t.text).join("\n"));
  const sourceText = fold(source.text);
  for (const track of answer.tracks) {
    if (!sourceText.includes(fold(track.title)) && !text.includes(fold(track.title))) problems.push(`título no literal: «${track.title}»`);
    if (track.duration && !text.includes(track.duration)) problems.push(`duración no literal: ${track.duration}`);
    if (/^\s*\d{1,2}\s*[-.)]/u.test(track.title)) problems.push(`título con número: «${track.title}»`);
  }
  const byDisc = new Map<number, number[]>();
  for (const track of answer.tracks) byDisc.set(track.disc, [...(byDisc.get(track.disc) ?? []), track.position]);
  for (const [disc, positions] of byDisc) {
    const sorted = [...positions].sort((a, b) => a - b);
    if (sorted.some((p, i) => p !== i + 1)) problems.push(`numeración irregular en disco ${disc}: ${sorted.join(",")}`);
  }
  if (answer.tracks.length > 40) problems.push(`demasiadas pistas: ${answer.tracks.length}`);
  return problems;
}

async function main(): Promise<void> {
  const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { albumId: number }).albumId) : []);
  const dossiers = (await loadDossiers()).filter((d) => !done.has(d.albumId)).slice(0, limit);
  const noText = dossiers.filter((d) => d.texts.length === 0);
  for (const d of noText) appendFileSync(OUT, JSON.stringify({ albumId: d.albumId, artist: d.artist, title: d.title, status: "sin_texto", problems: ["el título no aparece en ninguna página guardada"] }) + "\n");
  const queue = dossiers.filter((d) => d.texts.length > 0);
  console.log(`${dossiers.length} discos; ${queue.length} con texto, ${noText.length} sin texto`);
  const gateway = createDeepSeekGateway();
  const stats = { ok: 0, rejected: 0, notFound: 0, failed: 0 };
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      try {
        const result = await gateway.propose({
          taskKind: "narrative_extraction", modelClass: "fast", schemaVersion: "crv-tracklist.v1", instructions: INSTRUCTIONS, responseSchema,
          input: { albumId: d.albumId, artista: d.artist, titulo: d.title, anio: d.year, textos: d.texts },
        });
        const answer = result.proposal;
        const problems = answer.albumId === d.albumId ? validate(d, answer) : [`albumId devuelto ${answer.albumId}`];
        const status = problems.length === 0 ? "ok" : problems[0] === "sin lista" ? "sin_lista" : "rechazado";
        if (status === "ok") stats.ok += 1; else if (status === "sin_lista") stats.notFound += 1; else stats.rejected += 1;
        appendFileSync(OUT, JSON.stringify({ albumId: d.albumId, artist: d.artist, title: d.title, status, problems, sourceUrl: answer.sourceUrl ?? d.texts[0]!.url,
          tracks: answer.tracks, note: answer.note, model: result.model, promptHash: result.promptHash }) + "\n");
      } catch (error) {
        stats.failed += 1;
        console.error(d.albumId, (error as Error).message.slice(0, 200));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  console.log(JSON.stringify(stats));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
