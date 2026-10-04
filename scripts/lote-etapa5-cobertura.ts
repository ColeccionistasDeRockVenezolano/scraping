// CRV · Etapa 5 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §3):
// cobertura por ficha y lista final de huecos. NO escribe en la base.
//
// Fichas: las de los dos lotes, por la etapa 2 (creadas y corregidas) o por el
// cruce de la etapa 0, siguiendo las fusiones posteriores (entity_redirects).
// Por ficha: biografía, foto, género principal confirmado, titular o miembros,
// y de sus discos: cuántos, sin pistas, pistas sin duración, sin portada, sin
// sello y sin género.
//
// Salida: reports/nuevo-lote-2026-10-02/etapa5-cobertura.{md,json}
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa5-cobertura.ts
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getPool } from "../src/db/client.js";
import { loteFileSchema, type LoteArtist } from "../src/ingest/lote-investigacion.js";

const DESKTOP = path.join(os.homedir(), "Desktop");
const OUT_DIR = "reports/nuevo-lote-2026-10-02";
const LOTES = [
  { key: "lote1", file: path.join(DESKTOP, "Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json"), cross: OUT_DIR },
  { key: "lote2", file: path.join(DESKTOP, "Nuevo lote 2/catalogo_artistas_venezolanos_generos_faltantes_2026-10-02.json"), cross: `${OUT_DIR}/lote2` },
];

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

type Row = {
  id: number; name: string; artist_type: string; lote: string[]; created: boolean;
  bio: boolean; photo: boolean; primary_genre: string | null; members: number;
  albums: number; no_tracks: number; tracks: number; no_duration: number; no_cover: number; no_label: number; no_genre: number;
};

async function main(): Promise<void> {
  const stage2 = (JSON.parse(readFileSync(`${OUT_DIR}/etapa2-identidades.json`, "utf8")) as { identities: Record<string, { artistId: number | null; created: boolean }> }).identities;
  const fichas = new Map<number, { lote: Set<string>; loteIds: string[]; created: boolean }>();
  const missing: string[] = [];
  for (const lote of LOTES) {
    const cross = new Map((JSON.parse(readFileSync(path.join(lote.cross, "identidades.json"), "utf8")) as Array<{ lote_id: string; estado: string; artistas: Array<{ id: number }> }>)
      .map((row) => [row.lote_id, row]));
    for (const artist of loteFileSchema.parse(JSON.parse(readFileSync(lote.file, "utf8"))).artists as LoteArtist[]) {
      const stage = stage2[artist.id]?.artistId;
      const crossed = artist.id === "arca" || artist.id === "simon-diaz" ? undefined : cross.get(artist.id);
      const original = stage ?? (crossed?.estado === "existe" ? crossed.artistas[0]?.id : undefined);
      const id = original ? await liveArtist(original) : null;
      if (id === null) { missing.push(`${lote.key}:${artist.id}`); continue; }
      const entry = fichas.get(id) ?? { lote: new Set<string>(), loteIds: [], created: false };
      entry.lote.add(lote.key);
      entry.loteIds.push(artist.id);
      entry.created ||= stage2[artist.id]?.created === true;
      fichas.set(id, entry);
    }
  }
  const ids = [...fichas.keys()];
  const rows = (await getPool().query<Omit<Row, "lote" | "created"> & { id: string }>(`
    WITH al AS (
      SELECT al.id, al.artist_id, al.cover_url IS NULL AS no_cover, al.label_id IS NULL AS no_label,
             (SELECT count(*) FROM public.tracks t WHERE t.album_id=al.id) AS tracks,
             (SELECT count(*) FROM public.tracks t WHERE t.album_id=al.id AND t.duration_seconds IS NULL) AS no_duration,
             NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=al.id AND g.status IN ('confirmed','suggested')) AS no_genre
        FROM public.albums al WHERE al.artist_id = ANY($1::bigint[]))
    SELECT ar.id::text, ar.name, ar.artist_type::text,
           coalesce(btrim(ar.biography),'') <> '' AS bio,
           coalesce(btrim(ar.picture_url),'') <> '' AS photo,
           (SELECT g.name FROM ingest.artist_genres ag JOIN ingest.genres g ON g.id=ag.genre_id
             WHERE ag.artist_id=ar.id AND ag.role='primary' AND ag.status='confirmed' LIMIT 1) AS primary_genre,
           (SELECT count(*) FROM public.artist_members m WHERE m.artist_id=ar.id)::int AS members,
           count(al.id)::int AS albums,
           count(al.id) FILTER (WHERE al.tracks=0)::int AS no_tracks,
           coalesce(sum(al.tracks),0)::int AS tracks,
           coalesce(sum(al.no_duration),0)::int AS no_duration,
           count(al.id) FILTER (WHERE al.no_cover)::int AS no_cover,
           count(al.id) FILTER (WHERE al.no_label)::int AS no_label,
           count(al.id) FILTER (WHERE al.no_genre)::int AS no_genre
      FROM public.artists ar LEFT JOIN al ON al.artist_id=ar.id
     WHERE ar.id = ANY($1::bigint[])
     GROUP BY ar.id ORDER BY ar.name`, [ids])).rows;
  const data: Row[] = rows.map((row) => {
    const entry = fichas.get(Number(row.id))!;
    return { ...row, id: Number(row.id), lote: [...entry.lote].sort(), created: entry.created };
  });

  const sum = (pick: (row: Row) => number) => data.reduce((acc, row) => acc + pick(row), 0);
  const count = (test: (row: Row) => boolean) => data.filter(test).length;
  const totals = {
    fichas: data.length, creadas: count((r) => r.created), existentes: count((r) => !r.created),
    sinBio: count((r) => !r.bio), sinFoto: count((r) => !r.photo), sinPrincipal: count((r) => !r.primary_genre),
    sinPersonas: count((r) => r.members === 0), sinDiscos: count((r) => r.albums === 0),
    discos: sum((r) => r.albums), discosSinPistas: sum((r) => r.no_tracks), pistas: sum((r) => r.tracks),
    pistasSinDuracion: sum((r) => r.no_duration), discosSinPortada: sum((r) => r.no_cover),
    discosSinSello: sum((r) => r.no_label), discosSinGenero: sum((r) => r.no_genre),
  };
  const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)} %` : "—");
  const yes = (flag: boolean) => (flag ? "sí" : "**no**");
  const link = (r: Row) => `${r.name} (${r.id})`;

  const lines: string[] = [];
  lines.push("# Nuevo lote 2026-10-02 · Etapa 5: cobertura y huecos", "");
  lines.push(`Generado ${new Date().toISOString().slice(0, 10)} con \`scripts/lote-etapa5-cobertura.ts\` (solo lectura). Fichas de los dos lotes siguiendo las fusiones posteriores.`, "");
  lines.push("## Resumen", "");
  lines.push("| Dato | Valor |", "|---|---|");
  lines.push(`| Fichas | ${totals.fichas} (${totals.creadas} creadas por el lote, ${totals.existentes} ya existían) |`);
  lines.push(`| Sin biografía | ${totals.sinBio} |`);
  lines.push(`| Sin foto | ${totals.sinFoto} (${pct(totals.sinFoto, totals.fichas)}) |`);
  lines.push(`| Sin género principal confirmado | ${totals.sinPrincipal} |`);
  lines.push(`| Sin titular ni miembros | ${totals.sinPersonas} |`);
  lines.push(`| Sin discos | ${totals.sinDiscos} |`);
  lines.push(`| Discos | ${totals.discos} |`);
  lines.push(`| Discos sin pistas | ${totals.discosSinPistas} (${pct(totals.discosSinPistas, totals.discos)}) |`);
  lines.push(`| Pistas sin duración | ${totals.pistasSinDuracion} de ${totals.pistas} (${pct(totals.pistasSinDuracion, totals.pistas)}) |`);
  lines.push(`| Discos sin portada | ${totals.discosSinPortada} (${pct(totals.discosSinPortada, totals.discos)}) |`);
  lines.push(`| Discos sin sello | ${totals.discosSinSello} (${pct(totals.discosSinSello, totals.discos)}) |`);
  lines.push(`| Discos sin género | ${totals.discosSinGenero} (${pct(totals.discosSinGenero, totals.discos)}) |`);
  if (missing.length) lines.push("", `Artistas del lote sin ficha viva (${missing.length}): ${missing.join(", ")}.`);

  lines.push("", "## Huecos de ficha", "");
  const gapList = (title: string, list: Row[], extra: (r: Row) => string = () => "") => {
    lines.push(`### ${title} (${list.length})`, "");
    lines.push(list.length ? list.map((r) => `- ${link(r)}${extra(r)}`).join("\n") : "Ninguna.");
    lines.push("");
  };
  gapList("Sin biografía", data.filter((r) => !r.bio));
  gapList("Sin foto", data.filter((r) => !r.photo), (r) => ` · ${r.artist_type}`);
  gapList("Sin género principal", data.filter((r) => !r.primary_genre));
  gapList("Sin titular ni miembros", data.filter((r) => r.members === 0), (r) => ` · ${r.artist_type}`);
  gapList("Sin discos", data.filter((r) => r.albums === 0), (r) => ` · ${r.artist_type}`);

  lines.push("## Huecos de discos por ficha", "", "Solo fichas con algún disco sin pistas, sin portada o sin género.", "");
  lines.push("| Ficha | Discos | Sin pistas | Pistas sin duración | Sin portada | Sin sello | Sin género |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const r of [...data].filter((r) => r.no_tracks || r.no_cover || r.no_genre).sort((a, b) => (b.no_tracks + b.no_cover) - (a.no_tracks + a.no_cover))) {
    lines.push(`| ${link(r)} | ${r.albums} | ${r.no_tracks} | ${r.no_duration} | ${r.no_cover} | ${r.no_label} | ${r.no_genre} |`);
  }

  lines.push("", "## Cobertura por ficha", "");
  lines.push("| Ficha | Tipo | Lote | Bio | Foto | Principal | Personas | Discos | Sin pistas | Sin portada |", "|---|---|---|---|---|---|---:|---:|---:|---:|");
  for (const r of data) {
    lines.push(`| ${link(r)}${r.created ? " ✚" : ""} | ${r.artist_type} | ${r.lote.join("+")} | ${yes(r.bio)} | ${yes(r.photo)} | ${r.primary_genre ?? "**—**"} | ${r.members} | ${r.albums} | ${r.no_tracks} | ${r.no_cover} |`);
  }
  lines.push("", "✚ = ficha creada por el lote (etapa 2).", "");

  writeFileSync(`${OUT_DIR}/etapa5-cobertura.md`, `${lines.join("\n")}\n`);
  writeFileSync(`${OUT_DIR}/etapa5-cobertura.json`, `${JSON.stringify({ generatedAt: new Date().toISOString(), totals, missing, fichas: data }, null, 2)}\n`);
  console.log(JSON.stringify(totals, null, 2));
}

main().finally(() => closeDb());
