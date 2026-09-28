// CRV · Fase de géneros de la revisión de ingesta (2026-09-23).
//
// Lee los 294 casos `genre_unknown` abiertos, interpreta el texto crudo de la
// fuente según la guía editorial (el primer término manda; un compuesto «A/B
// Cosa» se lee con el sufijo compartido) y clasifica cada caso:
//   aplicable  → todo el texto queda cubierto por términos vigentes
//   termino_nuevo → hay una pieza que parece un género real ausente de la taxonomía
//   no_genero  → la pieza no es un género (formato, lugar, texto raro)
// Solo `aplicable` se aplica (decideGenre: un run propio, diario e historial);
// el resto queda abierto y se informa. SOLO LECTURA sin --confirm.
import { closeDb, getPool } from "../src/db/client.js";
import { decideGenre } from "../src/genres/curation.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { resolveGenreValue } from "../src/genres/taxonomy.js";
import { normalizeGenreText } from "../src/genres/normalize.js";
import { writeFileSync } from "node:fs";

const OPERATOR = "hermes-deepseek";
const PLAN = "tmp-analysis/ingesta-review/plan-generos.json";

/** Interpretación del texto con sufijo compartido de 1..n palabras finales. */
function extendedResolve(taxonomy: Awaited<ReturnType<typeof loadTaxonomy>>, raw: string) {
  const base = resolveGenreValue(taxonomy, raw);
  const names = new Map([...taxonomy.genres.values()].map((genre) => [genre.id, genre]));
  const items: Array<{ kind: "genre"; genreId: number; slug: string; fragment: string; via: "alias" | "shared_suffix" } | { kind: "unresolved"; fragment: string }> = base.items.map((item) => item.kind === "genre"
    ? { kind: "genre" as const, genreId: item.genreId, slug: names.get(item.genreId)!.slug, fragment: item.fragment, via: item.via }
    : { kind: "unresolved" as const, fragment: item.fragment });
  // Sufijo compartido extendido: si el último tramo trae varias palabras, el
  // tramo previo sin resolver se prueba con 1..n palabras de ese sufijo.
  const unresolvedIdx = items.map((item, index) => (item.kind === "unresolved" ? index : -1)).filter((index) => index >= 0);
  const last = items[items.length - 1];
  if (unresolvedIdx.length > 0 && items.length > 1 && last?.kind === "genre") {
    const lastWords = normalizeGenreText(last.fragment).split(" ");
    for (const index of unresolvedIdx) {
      const fragment = items[index]!.fragment;
      for (let take = Math.min(2, lastWords.length - 1); take >= 1; take -= 1) {
        const suffix = lastWords.slice(-take).join(" ");
        const candidate = `${normalizeGenreText(fragment)} ${suffix}`;
        const found = taxonomy.aliases.get(candidate);
        if (found && found.kind === "genre") {
          const genre = taxonomy.genres.get(found.genreId);
          if (genre?.active) { items[index] = { kind: "genre", genreId: genre.id, slug: genre.slug, fragment, via: "shared_suffix" }; break; }
        }
      }
    }
  }
  return { raw, items, notAGenre: base.notAGenre, primaryPending: base.items[0]?.kind === "unresolved" };
}

const NOT_GENRE_HINT = /^(souvenir|el mismo feeling|rock&roll$|varios|diversos?$|recopilaci)/iu;

async function main(): Promise<number> {
  const confirm = process.argv.includes("--confirm");
  const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? "0") || Number.MAX_SAFE_INTEGER;
  const pool = getPool();
  const client = await pool.connect();
  const cases = (await pool.query<{ id: string; payload: Record<string, unknown>; entity_kind: string; entity_id: string; raw: string }>(`
    SELECT r.id::text, r.payload, c.entity_kind::text, c.identity_key AS entity_id,
           COALESCE((SELECT e.excerpt FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1), '') AS raw
      FROM ingest.review_queue r
      LEFT JOIN ingest.claims c ON c.id = r.claim_a_id
     WHERE r.kind='genre_unknown' AND r.status='open'
     ORDER BY r.id`)).rows;
  // El payload trae entityId/rawValue; el LEFT JOIN del claim puede no existir.
  const taxonomy = await loadTaxonomy(client);
  client.release();

  const plan: Array<{ reviewId: number; entityKind: string; entityId: number; raw: string; resolution: unknown; class: string; applies?: Array<{ slug: string; role: "primary" | "secondary" }>; note: string }> = [];
  for (const row of cases) {
    const payload = row.payload ?? {};
    const raw = String(payload["rawValue"] ?? "").trim();
    const entityKind = String(payload["entityKind"] ?? "album");
    const entityId = Number(payload["entityId"] ?? 0);
    const resolution = extendedResolve(taxonomy, raw);
    const genres = resolution.items.filter((item) => item.kind === "genre") as Array<{ slug: string; fragment: string }>;
    const unresolved = resolution.items.filter((item) => item.kind === "unresolved") as Array<{ fragment: string }>;
    let klass: string; let note: string; let applies: Array<{ slug: string; role: "primary" | "secondary" }> | undefined;
    if (unresolved.length === 0 && genres.length > 0) {
      klass = "aplicable";
      applies = genres.map((item, index) => ({ slug: item.slug, role: index === 0 ? "primary" : "secondary" }));
      note = `Todo el texto «${raw}» queda cubierto: ${genres.map((item) => item.slug).join(", ")}`;
    } else if (unresolved.length > 0 && unresolved.every((item) => NOT_GENRE_HINT.test(item.fragment)) ) {
      klass = "no_genero"; note = `Piezas que no son género: ${unresolved.map((item) => item.fragment).join(", ")}`;
    } else {
      klass = unresolved.length > 0 ? "termino_nuevo" : "revision";
      note = `Sin resolver: ${unresolved.map((item) => item.fragment).join(", ")}`;
    }
    plan.push({ reviewId: Number(row.id), entityKind, entityId, raw, resolution, class: klass, ...(applies === undefined ? {} : { applies }), note });
  }
  writeFileSync(PLAN, `${JSON.stringify(plan, null, 2)}\n`);
  const byClass = new Map<string, number>();
  for (const item of plan) byClass.set(item.class, (byClass.get(item.class) ?? 0) + 1);
  console.log(`casos: ${plan.length} · ${[...byClass].map(([k, n]) => `${k}=${n}`).join(" · ")}`);
  console.log(`plan → ${PLAN}`);
  for (const item of plan.filter((entry) => entry.class === "aplicable").slice(0, 12)) {
    console.log(`  rev ${item.reviewId} · ${item.entityKind} ${item.entityId} · «${item.raw}» → ${(item.applies ?? []).map((a) => `${a.role}:${a.slug}`).join(", ")}`);
  }
  if (!confirm) { console.log("(previsualización) para aplicar: --confirm"); await closeDb(); return 0; }

  const todo = plan.filter((entry) => entry.class === "aplicable").slice(0, limit);
  let applied = 0; let failed = 0;
  for (const item of todo) {
    try {
      for (const [index, target] of (item.applies ?? []).entries()) {
        await decideGenre({
          action: target.role === "primary" ? "confirm_primary" : "add_secondary",
          kind: item.entityKind as "album" | "artist", entityId: item.entityId, genreSlug: target.slug,
          actor: OPERATOR, reason: `Guía editorial §«el primero manda»: texto de fuente «${item.raw}» (revisión ${item.reviewId}).`,
          closeCases: index === 0,
          ...(index === 0 ? { reviewIds: [item.reviewId] } : {}),
        } as never);
      }
      applied += 1;
      console.log(`  ✓ rev ${item.reviewId} (${item.entityKind} ${item.entityId}) ${(item.applies ?? []).map((a) => a.slug).join(", ")}`);
    } catch (error) {
      failed += 1;
      console.log(`  ! rev ${item.reviewId}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  console.log(`resultado géneros: ${applied} aplicados, ${failed} con error`);
  await closeDb();
  return 0;
}

await main();
