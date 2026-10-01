// CRV · Plan de limpieza del apodo final en el nombre de las personas.
//
// REGLA DE BRIAN (2026-10-01, caso Canserbero): el nombre de una persona no
// lleva el apodo pegado. «Tirone González "Canserbero"» se guarda como
// «Tirone González» con «Canserbero» de alias: la búsqueda mira nombres y
// aliases, así que se sigue encontrando por los dos, y los créditos de los
// discos muestran el nombre de la persona, no el del proyecto.
//
// Escribe el plan para `crv review persons --plan=…` y un informe con todo lo
// que NO toca y por qué. Con `--open-reviews` abre además una revisión
// `person_duplicate` por cada nombre limpio que caiga sobre otra ficha: el
// mismo nombre tras quitar el apodo es una señal de nombre, y una señal de
// nombre sola no funde a nadie (regla de Brian: hace falta proyecto común).
//   tsx scripts/plan-person-nicknames.ts [--out=<plan.json>] [--report=<informe.jsonl>] [--open-reviews]
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { normalizeEntityName, splitTrailingNickname } from "../src/normalization/entity-name.js";
import { openPersonCandidateReviews } from "../src/review/person-candidates.js";

const TODAY = new Date().toISOString().slice(0, 10);
const EVIDENCE = "Regla de Brian (2026-10-01, caso Canserbero): el nombre de la persona es su nombre; el apodo que la fuente pegó al final pasa a alias. El nombre anterior se conserva como alias, así que nada deja de encontrarse.";

interface Skipped { id: number; name: string; base: string | null; nicknames: string[]; reason: string; collidesWith?: { id: number; name: string } }

function argOf(flag: string, fallback: string): string {
  return process.argv.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? fallback;
}

async function main(): Promise<void> {
  const planPath = argOf("out", `docs/decisions/${TODAY}-apodos-en-nombres-de-persona.json`);
  const reportPath = argOf("report", `reports/person-nicknames-${TODAY}.jsonl`);
  const pool = getPool();
  const persons = (await pool.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.persons ORDER BY id")).rows
    .map((row) => ({ id: Number(row.id), name: row.name }));
  const aliases = new Map<number, Set<string>>();
  for (const row of (await pool.query<{ person_id: string; alias: string }>(
    "SELECT person_id::text, alias FROM ingest.person_aliases")).rows) {
    const id = Number(row.person_id);
    aliases.set(id, (aliases.get(id) ?? new Set<string>()).add(normalizeEntityName(row.alias).primaryKey));
  }
  // Índice por nombre comparable: un renombre que caiga sobre otra ficha no se
  // aplica a ciegas (podría ser la misma persona, pero fusionar exige evidencia
  // de proyecto común, que este barrido no mira).
  const byKey = new Map<string, Array<{ id: number; name: string }>>();
  for (const person of persons) {
    const key = normalizeEntityName(person.name).primaryKey;
    byKey.set(key, [...(byKey.get(key) ?? []), person]);
  }

  const corrections: unknown[] = [];
  const skipped: Skipped[] = [];
  let renamed = 0;
  let aliasesAdded = 0;
  for (const person of persons) {
    if (!/["“”«»]/u.test(person.name)) continue;
    const split = splitTrailingNickname(person.name);
    if (!split) {
      const trailing = /["\u201c\u201d\u00ab]([^"\u201c\u201d\u00ab\u00bb]+)["\u201c\u201d\u00bb]\s*$/u.exec(person.name);
      skipped.push({ id: person.id, name: person.name,
        base: trailing ? person.name.slice(0, trailing.index).trim() : null,
        nicknames: trailing?.[1] ? [trailing[1].trim()] : [],
        reason: !trailing ? "el apodo va intercalado en el nombre: así se nombra a la persona (decisión de Brian)"
          : "sin el apodo quedaría un nombre de una sola palabra, que no identifica a nadie" });
      continue;
    }
    const key = normalizeEntityName(split.name).primaryKey;
    const collision = (byKey.get(key) ?? []).find((other) => other.id !== person.id);
    if (collision) {
      skipped.push({ id: person.id, name: person.name, base: split.name, nicknames: split.nicknames,
        reason: "el nombre limpio ya es de otra ficha: puede ser la misma persona, pero eso se decide con la regla de proyecto común", collidesWith: collision });
      continue;
    }
    corrections.push({
      op: "rename", person: { id: person.id, name: person.name }, to: split.name, keepOldNameAsAlias: true,
      why: `El apodo «${split.nicknames.join(" / ")}» iba pegado al nombre; pasa a alias y el nombre anterior se conserva como alias.`,
    });
    renamed += 1;
    const known = aliases.get(person.id) ?? new Set<string>();
    for (const nickname of split.nicknames) {
      if (known.has(normalizeEntityName(nickname).primaryKey)) continue;
      corrections.push({
        op: "add_alias", person: { id: person.id, name: split.name }, alias: nickname,
        why: `Apodo que la fuente escribió dentro del nombre «${person.name}».`,
      });
      aliasesAdded += 1;
    }
  }

  let reviews: { runId: number; opened: number; skipped: number } | null = null;
  const collisions = skipped.filter((row) => row.collidesWith !== undefined);
  if (process.argv.includes("--open-reviews") && collisions.length) {
    reviews = await openPersonCandidateReviews(collisions.map((row) => ({
      a: { id: row.id, name: row.name },
      b: { id: row.collidesWith!.id, name: row.collidesWith!.name },
      score: 0.5,
      features: [{ key: "nickname_same_base", value: 1,
        evidence: `«${row.name}» sin el apodo «${row.nicknames.join(" / ")}» queda «${row.base}», que ya es el nombre de ${row.collidesWith!.id}` }],
      priority: 6 as const,
    })), "Apodo final en el nombre: el nombre limpio ya es de otra ficha (regla de Brian, 2026-10-01)", "brian");
  }

  writeFileSync(planPath, `${JSON.stringify({ decidedAt: TODAY, evidence: EVIDENCE, corrections }, null, 2)}\n`);
  writeFileSync(reportPath, skipped.map((row) => JSON.stringify(row)).join("\n") + (skipped.length ? "\n" : ""));
  console.log(JSON.stringify({ plan: planPath, report: reportPath, renamed, aliasesAdded, skipped: skipped.length, reviews,
    skippedByReason: skipped.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.reason]: (acc[row.reason] ?? 0) + 1 }), {}) }, null, 2));
}

main().then(() => closeDb()).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
