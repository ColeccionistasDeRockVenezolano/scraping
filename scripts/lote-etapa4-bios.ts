// CRV · Etapa 4 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §2.6 y §3):
// expedientes de biografía para las fichas del lote SIN biografía. NO escribe en la base.
//
// Parte de los expedientes del exportador de siempre
// (BIO_DOSSIERS_DIR=data/raw/etapa4-bio-export tsx scripts/export-biography-dossiers.ts --kinds=artist),
// que ya traen los datos del catálogo y los textos de las fuentes del proyecto,
// y les añade:
//   · la biografía del lote (fuente `lote-investigacion-2026-10-02`), si el
//     exportador no la trajo ya, y
//   · las páginas que el lote cita para esa ficha (Wikipedia por su API; el
//     resto, la página en texto). De una página larga o de una lista solo se
//     toma lo que rodea al nombre de la ficha; si no la nombra, se descarta.
// Salida en reports/nuevo-lote-2026-10-02/bio-dossiers/artist-001.jsonl, para
// synth-biographies-deepseek.ts y apply-biographies.ts con
// BIO_DOSSIERS_DIR/BIO_SYNTH_DIR apuntando a esa carpeta.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-bios.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { compareKey, loteFileSchema, type LoteArtist } from "../src/ingest/lote-investigacion.js";

const DESKTOP = path.join(os.homedir(), "Desktop");
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const EXPORT_DIR = "data/raw/etapa4-bio-export";
const DOSSIER_DIR = `${OUT_DIR}/bio-dossiers`;
const CACHE_DIR = "data/raw/etapa4-bio-paginas";
const USER_AGENT = "CRV-biografias/1.0 (+coleccionistasderockvenezolano.com)";
const MAX_TEXT = 3500;
const LOTES = [
  { file: path.join(DESKTOP, "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json"), cross: OUT_DIR, label: "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json" },
  { file: path.join(DESKTOP, "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json"), cross: `${OUT_DIR}/lote2`, label: "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json" },
];

interface Source { ref: string; source: string; url: string | null; lang: string; identity: string | null; text: string }
interface Dossier { caseId: string; kind: "artist"; entityId: number; name: string; catalog: Record<string, unknown>; currentText: string | null; sources: Source[] }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url: string): Promise<string | null> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${createHash("sha1").update(url).digest("hex")}.json`);
  if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { text: string | null }).text;
  let text: string | null = null;
  try {
    const wiki = /^https?:\/\/([a-z]{2,3})\.(?:m\.)?wikipedia\.org\/wiki\/([^#?]+)/.exec(url);
    if (wiki) {
      const api = `https://${wiki[1]}.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", format: "json", titles: decodeURIComponent(wiki[2]!) })}`;
      const body = (await (await fetch(api, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) })).json()) as { query?: { pages?: Record<string, { extract?: string }> } };
      text = Object.values(body.query?.pages ?? {})[0]?.extract ?? null;
    } else {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
      if (response.ok && /html|text/.test(response.headers.get("content-type") ?? "")) {
        text = (await response.text())
          .replace(/<(script|style|noscript|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "'").replace(/&[a-z]+;/g, " ")
          .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
      }
    }
  } catch {
    text = null;
  }
  writeFileSync(file, JSON.stringify({ url, text }));
  await sleep(500);
  return text;
}

/** Lo que la página dice de la ficha: el principio si la nombra ahí; si no, ventanas alrededor del nombre. */
function relevant(text: string, names: string[]): string | null {
  const folded = compareKey(text);
  const keys = names.map(compareKey).filter((key) => key.length >= 3);
  if (!keys.some((key) => folded.includes(key))) return null;
  const head = text.slice(0, MAX_TEXT);
  if (keys.some((key) => compareKey(head).includes(key))) return head.length < text.length ? `${head.replace(/\s+\S*$/u, "")} […]` : head;
  // Listas («List of Venezuelans»): buscar por líneas, que conservan el texto original.
  const lines = text.split("\n");
  const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => keys.some((key) => compareKey(line).includes(key))).slice(0, 3);
  return hits.map(({ index }) => lines.slice(Math.max(0, index - 1), index + 2).join("\n")).join("\n[…]\n").slice(0, MAX_TEXT);
}

async function liveArtist(id: number): Promise<number | null> {
  let current = id;
  for (let hop = 0; hop < 10; hop += 1) {
    const next = await getPool().query<{ to_id: string }>(
      "SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind='artist' AND from_id=$1 ORDER BY created_at DESC LIMIT 1", [current]);
    if (!next.rowCount) break;
    current = Number(next.rows[0]!.to_id);
  }
  return (await getPool().query("SELECT 1 FROM public.artists WHERE id=$1", [current])).rowCount ? current : null;
}

async function main(): Promise<void> {
  const stage2 = (JSON.parse(readFileSync(`${OUT_DIR}/etapa2-identidades.json`, "utf8")) as { identities: Record<string, { artistId: number | null }> }).identities;
  // Ficha del catálogo de cada artista del lote: etapa 2 (creadas y corregidas) o el cruce de la etapa 0.
  const loteByArtist = new Map<number, Array<{ artist: LoteArtist; file: string }>>();
  for (const lote of LOTES) {
    const cross = new Map((JSON.parse(readFileSync(path.join(lote.cross, "identidades.json"), "utf8")) as Array<{ lote_id: string; estado: string; artistas: Array<{ id: number }> }>)
      .map((row) => [row.lote_id, row]));
    for (const artist of loteFileSchema.parse(JSON.parse(readFileSync(lote.file, "utf8"))).artists as LoteArtist[]) {
      const stage = stage2[artist.id]?.artistId;
      const crossed = artist.id === "arca" || artist.id === "simon-diaz" ? undefined : cross.get(artist.id);
      const original = stage ?? (crossed?.estado === "existe" ? crossed.artistas[0]?.id : undefined);
      const id = original ? await liveArtist(original) : null;
      if (id === null) continue;
      loteByArtist.set(id, [...(loteByArtist.get(id) ?? []), { artist, file: lote.label }]);
    }
  }
  const empty = new Set((await getPool().query<{ id: string }>(
    "SELECT id::text FROM public.artists WHERE id = ANY($1::bigint[]) AND coalesce(btrim(biography),'')=''", [[...loteByArtist.keys()]])).rows.map((row) => Number(row.id)));

  const exported = new Map<number, Dossier>();
  for (const file of readdirSync(EXPORT_DIR).filter((name) => /^artist-\d+\.jsonl$/.test(name))) {
    for (const line of readFileSync(path.join(EXPORT_DIR, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const dossier = JSON.parse(line) as Dossier;
      if (empty.has(dossier.entityId)) exported.set(dossier.entityId, dossier);
    }
  }

  const dossiers: Dossier[] = [];
  const report = { targets: empty.size, missingExport: [] as number[], pages: { fetched: 0, used: 0, discarded: 0 } };
  for (const artistId of [...empty].sort((a, b) => a - b)) {
    const dossier = exported.get(artistId);
    // Sin expediente: ficha con corrección humana de la bio (el exportador la protege).
    if (!dossier) { report.missingExport.push(artistId); continue; }
    const sources = [...dossier.sources];
    const seenUrls = new Set(sources.map((source) => source.url).filter(Boolean));
    const nextRef = () => `s${sources.length + 1}`;
    for (const { artist, file } of loteByArtist.get(artistId) ?? []) {
      const names = [...new Set([artist.artist_name, dossier.name, ...(artist.aliases ?? []), ...(artist.real_name ? [artist.real_name] : [])])];
      // El exportador ya trae la bio del lote cuando su claim está enganchado a la ficha.
      if (artist.bio?.trim() && !sources.some((source) => source.text.trim() === artist.bio!.trim())) {
        sources.push({
          ref: nextRef(), source: "lote-investigacion-2026-10-02", url: null, lang: /\b(the|and|was|with|his|her)\b/i.test(artist.bio) ? "en" : "es",
          identity: `ficha «${artist.id}» del catálogo de investigación (${file}), enlazada al catálogo en las etapas 0–2`,
          text: artist.bio.trim(),
        });
      }
      for (const cited of artist.sources ?? []) {
        const url = cited.url;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        report.pages.fetched += 1;
        const raw = await fetchText(url);
        const text = raw ? relevant(raw, names) : null;
        if (!text || text.length < 80) { report.pages.discarded += 1; continue; }
        report.pages.used += 1;
        sources.push({
          ref: nextRef(), source: new URL(url).hostname.replace(/^www\./, ""), url, lang: /wikipedia\.org/.test(url) ? url.slice(8, 10) : "?",
          identity: "página citada por el catálogo de investigación para esta ficha; el texto la nombra", text,
        });
      }
    }
    dossiers.push({ ...dossier, sources });
  }
  mkdirSync(DOSSIER_DIR, { recursive: true });
  writeFileSync(`${DOSSIER_DIR}/artist-001.jsonl`, dossiers.map((dossier) => JSON.stringify(dossier)).join("\n") + "\n");
  console.log(JSON.stringify({ ...report, dossiers: dossiers.length, withoutSources: dossiers.filter((dossier) => dossier.sources.length === 0).map((dossier) => dossier.caseId) }, null, 1));
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
