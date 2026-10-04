// CRV · Desacuerdos de género abiertos en «Revisión de ingesta» (Brian, 2026-10-04).
//
// Decisión por pregunta: entran los dos géneros (una fuente basta) y el
// principal es el MÁS ESPECÍFICO (más hondo en la taxonomía). Empate entre dos
// específicos → Descargas Metal (especialista). Fusiones: queda el principal
// conservado y el degradado pasa a secundario. Contradicción con humano: manda
// lo humano (se reconfirma su principal).
//
//   ./scripts/with-node22.sh npx tsx scripts/resolve-genre-disagreements-2026-10-04.ts [--confirm]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { decideGenre } from "../src/genres/curation.js";

const ACTOR = "brian";
const NOTE = "Revisión de ingesta 2026-10-04: principal = género más específico; empate → Descargas Metal; ambos entran";
const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();

interface Review { id: number; payload: Record<string, any> }
interface Plan { reviewId: number; kind: "album" | "artist"; entityId: number; primary: string; secondary: string | null; why: string }

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const pool = getPool();
  const genres = (await pool.query<{ id: string; slug: string; name: string; parent: string | null }>(
    "SELECT id::text, slug, name, parent_genre_id::text AS parent FROM ingest.genres")).rows;
  const byId = new Map(genres.map((g) => [Number(g.id), g]));
  const depth = (id: number): number => { let d = 0; let g = byId.get(id); while (g?.parent) { d += 1; g = byId.get(Number(g.parent)); } return d; };
  const aliases = new Map<string, number>();
  for (const g of genres) aliases.set(fold(g.name), Number(g.id));
  for (const a of (await pool.query<{ a: string; g: string }>("SELECT alias_normalized AS a, genre_id::text AS g FROM ingest.genre_aliases WHERE genre_id IS NOT NULL")).rows) {
    aliases.set(fold(a.a), Number(a.g));
  }
  const firstOf = (raw: string): number | undefined => {
    const piece = raw.split(/[\/|,]| - /u).map((s) => s.trim()).find(Boolean) ?? raw;
    return aliases.get(fold(piece)) ?? aliases.get(fold(piece.replace(/-/gu, " ")));
  };
  const reviews = (await pool.query<{ id: string; payload: Record<string, any> }>(
    "SELECT id::text, payload FROM ingest.review_queue WHERE status IN ('open','in_progress') AND kind='genre_unknown' ORDER BY id")).rows
    .map((r): Review => ({ id: Number(r.id), payload: r.payload }));

  const plans: Plan[] = [];
  const skipped: string[] = [];
  for (const review of reviews) {
    const p = review.payload;
    const kind = p["entityKind"] as "album" | "artist";
    const entityId = Number(p["entityId"]);
    let primary: number | undefined;
    let secondary: number | undefined;
    let why = "";
    if (p["origin"] === "genres-merge") {
      primary = Number(p["keptPrimaryGenreId"]); secondary = Number(p["demotedGenreId"]); why = "fusión: se conserva el principal";
    } else if (p["genreCase"] === "human_contradiction") {
      const human = (await pool.query<{ g: string }>(
        `SELECT genre_id::text AS g FROM ingest.${kind}_genres WHERE id=$1`, [p["humanAssignmentId"]])).rows[0];
      primary = human ? Number(human.g) : undefined; why = "manda lo humano";
    } else {
      const units = (p["units"] ?? []) as Array<{ rawValue: string; sourceSlug: string; primaryGenreId?: number }>;
      const dm = units.find((u) => u.sourceSlug === "descargas-metal-venezolano");
      const other = units.find((u) => u !== dm);
      const a = dm ? (dm.primaryGenreId ?? firstOf(dm.rawValue)) : undefined;
      const b = other ? (other.primaryGenreId ?? firstOf(other.rawValue)) : undefined;
      if (a === undefined && b === undefined) { skipped.push(`${review.id}: sin géneros reconocibles ${JSON.stringify(units)}`); continue; }
      if (a === undefined || b === undefined) { primary = a ?? b; why = "solo un lado reconocible"; }
      else if (depth(b) > depth(a)) { primary = b; secondary = a; why = `más específico: ${other?.sourceSlug}`; }
      else { primary = a; secondary = b; why = depth(a) > depth(b) ? "más específico: descargas-metal" : "empate → descargas-metal"; }
      if (secondary === primary) secondary = undefined;
    }
    const pg = primary === undefined ? undefined : byId.get(primary);
    if (!pg) { skipped.push(`${review.id}: principal desconocido`); continue; }
    plans.push({ reviewId: review.id, kind, entityId, primary: pg.slug, secondary: secondary === undefined ? null : byId.get(secondary)?.slug ?? null, why });
  }

  const lines: string[] = [];
  let applied = 0;
  for (const plan of plans) {
    const label = `${plan.kind} ${plan.entityId}: principal ${plan.primary}${plan.secondary ? ` + secundario ${plan.secondary}` : ""} (${plan.why})`;
    if (!confirm) { lines.push(`- ${label}`); continue; }
    try {
      if (plan.secondary) {
        // La familia de un género ya asignado sobra: el hijo ya la implica.
        await decideGenre({ action: "add_secondary", kind: plan.kind, entityId: plan.entityId, genreSlug: plan.secondary, actor: ACTOR, reason: NOTE, reviewIds: [plan.reviewId], closeCases: false })
          .catch((error: Error) => { if (!/familia de un género/u.test(error.message)) throw error; });
      }
      const result = await decideGenre({ action: "confirm_primary", kind: plan.kind, entityId: plan.entityId, genreSlug: plan.primary, actor: ACTOR, reason: NOTE, reviewIds: [plan.reviewId] });
      applied += 1;
      lines.push(`- ${label} · run ${result.runId}`);
    } catch (error) {
      lines.push(`- FALLÓ ${label}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  const file = `reports/revision-ingesta-2026-10-04/generos-${confirm ? "confirm" : "dry-run"}.md`;
  writeFileSync(file, [`# Desacuerdos de género (${confirm ? "confirm" : "dry-run"})`, "", NOTE, "", `planes ${plans.length} · aplicados ${applied} · saltados ${skipped.length}`, "", ...lines, "", "## Saltados", ...skipped, ""].join("\n"));
  console.log(`planes ${plans.length} · aplicados ${applied} · saltados ${skipped.length} → ${file}`);
}

main().then(() => closeDb()).then(() => process.exit(0), async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
