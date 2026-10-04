// Membresías repetidas (caso Abaddon, Brian, 2026-10-04). La clave de
// idempotencia por rol literal dejaba a la misma persona dos veces en una
// banda («Guitar» de Sincopa y «Guitars» de Metal Archives); 202 pares en 72
// artistas. Además el adaptador de Sincopa < 1.3.5 daba a toda una celda de
// miembros el primer rol («Bass & Vocals» para los trombonistas de Dimensión
// Latina). Se corrige contra el core, sin reingerir:
//
//   --phase=sincopa     roles de Sincopa releídos con el adaptador 1.3.5 en las
//                       fichas que cambian; solo se corrige la fila cuyo rol
//                       sigue siendo el que Sincopa afirmó (el resto se informa).
//   --phase=periodos    los 8 pares con años contradictorios, por la regla de
//                       Brian: Metal Archives > Sincopa > biografías.
//   --phase=misma-ficha los pares que la misma ficha nombra en varias secciones.
//   --phase=separar     «O'Brien» (6213) y Ezequiel Serrano (883) eran varias personas.
//   --phase=consolidar  una fila por persona y etapa en cada banda
//                       (consolidateMemberships): rol unido, años completados,
//                       los textos de rol que desaparecen quedan en las notas.
//
// Sin --confirm todo corre en una transacción que se revierte y deja el
// informe *-dry-run.json. Cada fase confirmada es un run deshacible.
//
//   tsx scripts/fix-membresias-repetidas.ts --phase=sincopa|consolidar|periodos|misma-ficha|separar [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { closeDb, getPool } from "../src/db/client.js";
import { consolidateMemberships } from "../src/merge/equivalent-relations.js";
import { combineRoles } from "../src/merge/membership-roles.js";
import { createRelation, updateEntity, updateRelation, withOperatorRun, type OperatorContext } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const DATE = "2026-10-04";
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length);
const confirm = process.argv.includes("--confirm");
if (phase !== "sincopa" && phase !== "consolidar" && phase !== "periodos" && phase !== "misma-ficha" && phase !== "separar") throw new Error("uso: --phase=sincopa|consolidar|periodos|misma-ficha|separar [--confirm]");

class DryRun extends Error {
  constructor(readonly result: unknown) { super("ensayo: se revierte"); }
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface SincopaFix { artistId: number; artist: string; url: string; membershipId: number; person: string; before: string; after: string }
interface SincopaSkip { artistId: number; url: string; record: string; oldRole: string; newRole: string; reason: string; rows?: string[] }

async function sincopa(context: OperatorContext): Promise<{ fixed: SincopaFix[]; skipped: SincopaSkip[]; pages: number }> {
  const { client } = context;
  const adapter = new SincopaAdapter();
  const pages = (await client.query<{ url: string; stored_path: string; ids: string[] }>(`
    SELECT url, (array_agg(stored_path ORDER BY id DESC))[1] AS stored_path, array_agg(id::text) AS ids
      FROM ingest.raw_pages
     WHERE source_id=(SELECT id FROM ingest.sources WHERE slug='sincopa')
       AND EXISTS (SELECT 1 FROM ingest.claims c WHERE c.raw_page_id=raw_pages.id AND c.entity_kind='artist_membership')
     GROUP BY url ORDER BY url`)).rows;
  const fixed: SincopaFix[] = [];
  const skipped: SincopaSkip[] = [];
  let touchedPages = 0;
  for (const page of pages) {
    let body: string;
    try { body = new TextDecoder("windows-1252").decode(readFileSync(`data/${page.stored_path}`)); } catch { continue; }
    const records = adapter.extractSnapshot({ url: page.url, kind: "html", rawPageId: Number(page.ids[0]), body })
      .filter((record) => record.entityKind === "artist_membership")
      .map((record) => Object.fromEntries(record.fields.map((field) => [field.field, String(field.value)])));
    // Lo que Sincopa afirmó antes: rol por nombre, desde los claims de la página.
    const claimed = (await client.query<{ person: string; role: string; artist_id: string | null }>(`
      SELECT p.raw_value#>>'{}' AS person, r.raw_value#>>'{}' AS role, m.artist_id::text
        FROM ingest.claims p
        JOIN ingest.claims r ON r.raw_page_id=p.raw_page_id AND r.identity_key=p.identity_key AND r.field='role'
                            AND r.entity_kind='artist_membership'
        LEFT JOIN public.artist_members m ON m.id=COALESCE(p.artist_membership_id, r.artist_membership_id)
       WHERE p.raw_page_id=ANY($1::bigint[]) AND p.entity_kind='artist_membership' AND p.field='person_name'`,
    [page.ids])).rows;
    const artistId = claimed.find((row) => row.artist_id)?.artist_id;
    let pageChanged = false;
    for (const record of records) {
      const name = record["person_name"]!;
      const newRole = record["role"]!;
      const old = claimed.find((row) => row.person === name);
      if (!old || old.role === newRole) continue;
      pageChanged = true;
      // El mismo nombre dos veces en la ficha (otra alineación, «Ex-Members»):
      // no se sabe qué rol viejo corresponde a cuál nuevo.
      if (records.filter((other) => other["person_name"] === name).length > 1
        || new Set(claimed.filter((row) => row.person === name).map((row) => row.role)).size > 1) {
        skipped.push({ artistId: Number(artistId ?? 0), url: page.url, record: name, oldRole: old.role, newRole, reason: "nombre repetido en la ficha" });
        continue;
      }
      if (!artistId) {
        skipped.push({ artistId: 0, url: page.url, record: name, oldRole: old.role, newRole, reason: "la ficha no llegó al core" });
        continue;
      }
      // La fila puede seguir con el nombre de Sincopa o venir de dividir un
      // nombre compuesto («Fucho González, Hernán Omero & José Rodríguez»).
      const rows = (await client.query<{ id: string; role: string; person: string }>(`
        SELECT m.id::text, m.role, p.name AS person FROM public.artist_members m JOIN public.persons p ON p.id=m.person_id
         WHERE m.artist_id=$1 ORDER BY m.id`, [artistId])).rows
        .filter((row) => [name, name.replace(/["“”][^"“”]*["“”]/gu, " ")]
          .some((variant) => ` ${fold(variant)} `.includes(` ${fold(row.person)} `)));
      const target = rows.filter((row) => row.role === old.role);
      if (!target.length) {
        skipped.push({ artistId: Number(artistId), url: page.url, record: name, oldRole: old.role, newRole,
          reason: rows.length ? "la fila ya no tiene el rol de Sincopa" : "sin fila con ese nombre en la banda",
          rows: rows.map((row) => `${row.id} ${row.person}: ${row.role}`) });
        continue;
      }
      for (const row of target) {
        await updateRelation(context, "artist_membership", Number(row.id), { role: newRole });
        fixed.push({ artistId: Number(artistId), artist: "", url: page.url, membershipId: Number(row.id), person: row.person, before: row.role, after: newRole });
      }
    }
    if (pageChanged) touchedPages += 1;
  }
  const names = new Map((await client.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM public.artists WHERE id=ANY($1::bigint[])", [[...new Set(fixed.map((item) => item.artistId))]])).rows
    .map((row) => [Number(row.id), row.name]));
  for (const item of fixed) item.artist = names.get(item.artistId) ?? "";
  return { fixed, skipped, pages: touchedPages };
}

async function consolidate(context: OperatorContext) {
  const { client, runId, note } = context;
  const artists = (await client.query<{ artist_id: string }>(`
    SELECT DISTINCT artist_id::text FROM public.artist_members
     GROUP BY artist_id, person_id HAVING count(*)>1 ORDER BY 1`)).rows.map((row) => Number(row.artist_id));
  // La misma página nombra dos veces a la persona en la banda (otra
  // alineación, o hermanos que la ficha confunde: los O'Brien de Las Cuatro
  // Monedas). Unirlas sería decidir una identidad: decide una persona.
  const samePage = (await client.query<{ artist_id: string; person_id: string; url: string; ids: string[] }>(`
    SELECT m.artist_id::text, m.person_id::text, rp.url, array_agg(DISTINCT m.id::text) AS ids
      FROM public.artist_members m
      JOIN ingest.claims c ON c.artist_membership_id=m.id
      JOIN ingest.raw_pages rp ON rp.id=c.raw_page_id
     WHERE (m.artist_id, m.person_id) IN (SELECT artist_id, person_id FROM public.artist_members GROUP BY 1,2 HAVING count(*)>1)
     GROUP BY 1,2,3 HAVING count(DISTINCT m.id)>1`)).rows;
  const apart = new Set(samePage.map((row) => `${row.artist_id}|${row.person_id}`));
  let reviewsOpened = 0;
  for (const row of samePage) {
    const open = await client.query(`
      SELECT 1 FROM ingest.review_queue WHERE kind='manual_review' AND status IN ('open','in_progress')
         AND payload->>'detector'='membership-same-page' AND payload->>'artistId'=$1 AND payload->>'personId'=$2`,
    [row.artist_id, row.person_id]);
    if (open.rowCount) continue;
    await client.query("INSERT INTO ingest.review_queue(kind,priority,payload,notes) VALUES('manual_review',5,$1::jsonb,$2)", [
      JSON.stringify({ detector: "membership-same-page", version: 1, runId, artistId: Number(row.artist_id), personId: Number(row.person_id),
        ids: row.ids.map(Number), url: row.url }),
      `La misma ficha (${row.url}) nombra dos veces a la persona en la banda: ¿otra alineación o dos personas con el mismo nombre?`,
    ]);
    reviewsOpened += 1;
  }
  const groups = [];
  let merged = 0;
  for (const artistId of artists) {
    const outcome = await consolidateMemberships(client, { artistId }, note, runId,
      { skip: (artist, person) => apart.has(`${artist}|${person}`) });
    merged += outcome.merged;
    reviewsOpened += outcome.reviewsOpened;
    groups.push(...outcome.groups);
  }
  const names = await client.query<{ kind: string; id: string; name: string }>(`
    SELECT 'artist' AS kind, id::text, name FROM public.artists WHERE id=ANY($1::bigint[])
    UNION ALL SELECT 'person', id::text, name FROM public.persons WHERE id=ANY($2::bigint[])`,
  [artists, [...new Set(groups.map((group) => group.personId))]]);
  const label = new Map(names.rows.map((row) => [`${row.kind}:${row.id}`, row.name]));
  const remaining = (await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM (SELECT 1 FROM public.artist_members GROUP BY artist_id, person_id HAVING count(*)>1) pairs")).rows[0]!.n;
  return {
    artists: artists.length, merged, reviewsOpened, pairsLeft: Number(remaining), samePage,
    groups: groups.map((group) => ({
      artist: label.get(`artist:${group.artistId}`), person: label.get(`person:${group.personId}`), ...group,
    })),
  };
}

// Períodos que se contradicen (revisión membership-periods). Regla de Brian
// (2026-10-04): manda la fuente estructurada — Metal Archives > Sincopa > los
// integrantes sacados de biografías o créditos (runs 10992–11016); entre filas
// de la misma fuente, el período más amplio. Submarino es la excepción
// razonada: el 2001–2001 sale del año del disco donde aparece acreditado, que
// no es un período, y no contradice el «desde 1999» de la biografía.
const PERIODS: Array<{ review: number; keep: number; drop: number; from: number; to: number | null; why: string }> = [
  { review: 1831962, keep: 422, drop: 1974, from: 2008, to: 2015, why: "2008–2013 Sincopa (fila 422), 2008–2015 Metal Archives (fila 1974); manda Metal Archives" },
  { review: 1831961, keep: 4848, drop: 10211, from: 2010, to: 2015, why: "2009– biografía (fila 4848), 2010–2015 Sincopa (fila 10211); manda Sincopa" },
  { review: 1831963, keep: 2905, drop: 3083, from: 2016, to: 2023, why: "2016–2018 (fila 2905) y 2018–2023 (fila 3083), las dos de Metal Archives; período más amplio" },
  { review: 1831957, keep: 5317, drop: 9760, from: 1972, to: 1984, why: "1972–1986 biografía (fila 5317), 1972–1984 Sincopa (fila 9760); manda Sincopa" },
  { review: 1831959, keep: 5320, drop: 9759, from: 1972, to: 1977, why: "1972–1985 biografía (fila 5320), 1972–1977 Sincopa (fila 9759); manda Sincopa" },
  { review: 1831960, keep: 9171, drop: 9786, from: 1982, to: 1984, why: "1981–1990 biografía (fila 9171), 1982–1984 Sincopa (fila 9786); manda Sincopa" },
  { review: 1831958, keep: 5318, drop: 9761, from: 1972, to: 1984, why: "1972–1986 biografía (fila 5318), 1972–1984 Sincopa (fila 9761); manda Sincopa" },
  { review: 1831956, keep: 5232, drop: 9318, from: 1999, to: null, why: "1999– biografía (fila 5232), 2001 año del disco acreditado (fila 9318), que no es un período" },
];

interface Union {
  review: number; ids: number[]; why: string;
  role?: string; from?: number | null; to?: number | null; isCurrent?: boolean;
}

/**
 * Une varias filas de la misma persona en la misma banda en la de id menor:
 * `mergeInto` mueve los claims y deja las filas borradas en la auditoría; el
 * rastro `membership_consolidated` guarda los valores de antes (deshacer la
 * run los devuelve). Lo que cada fila decía queda en las notas.
 */
async function unite(context: OperatorContext, item: Union) {
  const { client, runId, note } = context;
  const rows = (await client.query<{ id: string; role: string; is_current: boolean; notes: string | null; from_year: number | null; to_year: number | null; review: string | null }>(`
    SELECT m.id::text, m.role, m.is_current, m.notes, m.from_year, m.to_year,
           (SELECT status::text FROM ingest.review_queue WHERE id=$2) AS review
      FROM public.artist_members m WHERE m.id=ANY($1::bigint[]) ORDER BY m.id FOR UPDATE`, [item.ids, item.review])).rows;
  if (rows.length !== item.ids.length || rows[0]!.review !== "open") throw new Error(`el grupo ${item.ids.join("/")} cambió`);
  const [keep, ...drops] = rows;
  const lines = [...new Set(rows.map((row) => row.notes?.trim()).filter((text): text is string => Boolean(text)))];
  if (new Set(rows.map((row) => row.role.trim().toLowerCase())).size > 1) {
    lines.push(`Roles según las fuentes antes de unir (run ${runId}): ${rows.map((row) => `«${row.role.trim()}» (fila ${row.id})`).join(", ")}`);
  }
  lines.push(`Unidas (run ${runId}): ${item.why}`);
  const years = (column: "from_year" | "to_year", pick: (values: number[]) => number) => {
    const values = rows.map((row) => row[column]).filter((value): value is number => value !== null);
    return values.length ? pick(values) : null;
  };
  const wanted = {
    role: item.role ?? combineRoles(rows.map((row) => row.role)),
    from_year: item.from !== undefined ? item.from : years("from_year", (values) => Math.min(...values)),
    to_year: item.to !== undefined ? item.to : years("to_year", (values) => Math.max(...values)),
    is_current: item.isCurrent ?? rows.some((row) => row.is_current),
    notes: lines.join("\n"),
  };
  for (const drop of drops) await mergeInto(client, "artist_membership", Number(keep!.id), Number(drop.id), note, runId, { alias: false });
  const current = (await client.query<typeof wanted>(
    "SELECT role, from_year, to_year, is_current, notes FROM public.artist_members WHERE id=$1", [keep!.id])).rows[0]!;
  const changed = (Object.keys(wanted) as Array<keyof typeof wanted>).filter((column) => current[column] !== wanted[column]);
  await client.query(
    `UPDATE public.artist_members SET ${changed.map((column, index) => `${column}=$${index + 2}`).join(",")} WHERE id=$1`,
    [keep!.id, ...changed.map((column) => wanted[column])]);
  await client.query(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,artist_membership_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,'artist_membership',$2,'membership_consolidated',$3::jsonb,$4::jsonb,$5,'high','human')`,
  [runId, keep!.id, JSON.stringify(Object.fromEntries(changed.map((column) => [column, current[column]]))),
    JSON.stringify(Object.fromEntries(changed.map((column) => [column, wanted[column]]))), `membresías repetidas unidas: ${note}`]);
  await resolveReview(context, item.review, `Unidas en la fila ${keep!.id} (run ${runId}): ${item.why}`);
  return { ...item, keep: Number(keep!.id), before: rows.map((row) => `${row.id}: ${row.role} ${row.from_year ?? "?"}–${row.to_year ?? ""}`),
    role: wanted.role, from_year: wanted.from_year, to_year: wanted.to_year };
}

async function resolveReview(context: OperatorContext, review: number, why: string): Promise<void> {
  await context.client.query(`
    UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolved_at=now(), updated_at=now(), resolution_note=$2
     WHERE id=$1`, [review, why]);
}

async function periods(context: OperatorContext) {
  const done = [];
  for (const item of PERIODS) {
    done.push(await unite(context, { review: item.review, ids: [item.keep, item.drop], from: item.from, to: item.to, why: `años: ${item.why}` }));
  }
  return { merged: done.length, done };
}

// La misma ficha de Sincopa nombra dos veces a la persona porque la ordena por
// instrumento o por formación (Brian, 2026-10-04: «Unir los 10»). Los años de
// Sonero Clásico salen de la ficha (el adaptador no leyó los de los
// exintegrantes); Equilibrio Vital: original «(1980-)» y sigue en la actual.
const SAME_PAGE: Union[] = [
  { review: 1831951, ids: [9734, 9737], why: "Bailatino: la ficha lo nombra en Bass y en Backing Vocals" },
  { review: 1831942, ids: [624, 628], why: "Dame pa Matala: la ficha lo nombra en Timbales y en Drums & Timbales" },
  { review: 1831947, ids: [9623, 9624, 9632], why: "El Trabuco Venezolano: la ficha ordena por instrumento (dirección, timbales, percusión)" },
  { review: 1831950, ids: [9630, 9633, 9642], why: "El Trabuco Venezolano: la ficha ordena por instrumento (congas, percusión, coros)" },
  { review: 1831948, ids: [9634, 9643], why: "El Trabuco Venezolano: la ficha ordena por instrumento (percusión, coros)" },
  { review: 1831949, ids: [9636, 9637], why: "El Trabuco Venezolano: la ficha ordena por instrumento (trompeta, fliscorno)" },
  { review: 1831954, ids: [762, 769], from: 1980, to: null, isCurrent: true, why: "Equilibrio Vital: miembro original «(1980-)» y en la formación actual" },
  { review: 1831955, ids: [764, 765], from: 1980, to: null, isCurrent: true, why: "Equilibrio Vital: miembro original «(1980-)» y en la formación actual" },
  { review: 1831944, ids: [162, 167], role: "Vocals", why: "Mirada Interna: la ficha la nombra en Vocals y bajo «Ex-Members», que es una sección, no un rol" },
  { review: 1831952, ids: [9999, 10014], from: 1991, to: 1997, why: "Sonero Clásico del Caribe: exintegrante en Vocals (1991-1997) y Tres (1991), años de la ficha" },
  { review: 1831953, ids: [10001, 10011], from: 1991, to: 1991, why: "Sonero Clásico del Caribe: exintegrante en Vocals (1991) y Bass (1991), años de la ficha" },
];

// Seguridad Nacional: dos formaciones en la ficha, «Original Members» y «2005
// Members»; el recopilatorio de 2005 se titula «Seguridad Nacional 1983-1993».
const STAGES: Array<{ review: number; original: number; reunion: number; why: string }> = [
  { review: 1831946, original: 1194, reunion: 1192, why: "Abraham García" },
  { review: 1831945, original: 1197, reunion: 1199, why: "Juan Bautista López «Yatú»" },
];

async function samePage(context: OperatorContext) {
  const done = [];
  for (const item of SAME_PAGE) done.push(await unite(context, item));
  const stages = [];
  for (const item of STAGES) {
    await updateRelation(context, "artist_membership", item.original, { from_year: 1983, to_year: 1993 });
    await updateRelation(context, "artist_membership", item.reunion, { from_year: 2005, to_year: 2005 });
    await resolveReview(context, item.review, `Dos etapas (run ${context.runId}): ${item.why} en la formación original (fila ${item.original}, 1983–1993) y en la de 2005 (fila ${item.reunion})`);
    stages.push(item);
  }
  return { merged: done.length, done, stages };
}

// ── Personas mezcladas ──────────────────────────────────────────────────
// «O'Brien» (6213): Sincopa partió «Kenny / O'Brien» y dejó el apellido como
// persona; los hermanos ya existen. Membresías según la ficha de la banda;
// créditos de disco según el rol que da la ficha de cada disco.
const OBRIEN = 6213;
const OBRIEN_MEMBERSHIPS: Record<number, number> = { 1097: 758, 1101: 756, 1095: 759, 1096: 760 };
const OBRIEN_ROLES: Record<string, number> = {
  "Lead Guitar & Vocals": 758, "Second Guitar & Vocals": 756, "Bass & Vocals": 759, "Drums & Vocals": 760, Vocals: 2624,
};
// Ezequiel Serrano: el padre (Ezequiel Serrano Calderón, 1953, saxo y flauta,
// productor; «Ezequiel Serrano» o «Ezequiel Serrano C.») y el hijo (Ezequiel
// Serrano Valencia, guitarra y voz desde 2000). Las fusiones 10448 y 11014
// los juntaron en 883; el disco de Cabezón Key acredita a los dos por separado.
const SON = 883;
const FATHER = 2568;
const FATHER_DUPLICATE = 20739;
const FATHER_MEMBERSHIPS = ["Melao", "Adrenalina Caribe"];
const FATHER_ALIASES = ["Ezequiel Serrano", "Ezequiel Serrano C", "Ezequiel Serrano C."];
/** Del hijo por la biografía que tenía antes de la fusión (claim 643783). */
const SON_ARTISTS = ["Nana Cadavieco"];
/** Sin señal suficiente: se quedan en 883 y van a la cola. */
const DOUBTFUL_ARTISTS = ["Luz Verde"];

type Kind = "album_credit" | "track_credit";

/** Reapunta un crédito; si el destino ya tiene el mismo crédito, lo une a ese. */
async function moveCredit(context: OperatorContext, kind: Kind, id: number, personId: number): Promise<"moved" | "merged"> {
  const { client, runId, note } = context;
  await client.query("SAVEPOINT move_credit");
  try {
    await updateRelation(context, kind, id, { person_id: personId });
    await client.query("RELEASE SAVEPOINT move_credit");
    return "moved";
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT move_credit");
    const existing = /\(id (\d+)\)/.exec(error instanceof Error ? error.message : "")?.[1];
    if (!existing) throw error;
    await mergeInto(client, kind, Number(existing), id, note, runId, { alias: false });
    return "merged";
  }
}

async function credits(client: OperatorContext["client"], personId: number) {
  return (await client.query<{ kind: Kind; id: string; role: string; artist: string; year: number | null; title: string; names: string | null }>(`
    SELECT 'album_credit' AS kind, ac.id::text, ac.role, a.name AS artist, al.release_year AS year, al.title,
           (SELECT string_agg(DISTINCT c.raw_value#>>'{}', ' / ') FROM ingest.claims c
             WHERE c.album_credit_id=ac.id AND c.field IN ('credited_name','person_name','name')) AS names
      FROM public.album_credits ac JOIN public.albums al ON al.id=ac.album_id JOIN public.artists a ON a.id=al.artist_id
     WHERE ac.person_id=$1
    UNION ALL
    SELECT 'track_credit', tc.id::text, tc.role, a.name, al.release_year, t.title,
           (SELECT string_agg(DISTINCT c.raw_value#>>'{}', ' / ') FROM ingest.claims c
             WHERE c.track_credit_id=tc.id AND c.field IN ('credited_name','person_name','name'))
      FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id JOIN public.albums al ON al.id=t.album_id
      JOIN public.artists a ON a.id=al.artist_id
     WHERE tc.person_id=$1
     ORDER BY 1, 2`, [personId])).rows;
}

async function openMixedReview(context: OperatorContext, personId: number, items: unknown[], text: string): Promise<void> {
  await context.client.query("INSERT INTO ingest.review_queue(kind,priority,payload,notes,person_a_id) VALUES('manual_review',5,$1::jsonb,$2,$3)", [
    JSON.stringify({ detector: "person-mixed", version: 1, runId: context.runId, personId, items }), text, personId]);
}

async function separate(context: OperatorContext) {
  const { client, runId, note } = context;
  // O'Brien
  const obrien = { memberships: [] as unknown[], credits: [] as unknown[], left: [] as unknown[] };
  for (const [membership, personId] of Object.entries(OBRIEN_MEMBERSHIPS)) {
    await updateRelation(context, "artist_membership", Number(membership), { person_id: personId });
    obrien.memberships.push({ membership: Number(membership), personId });
  }
  for (const credit of await credits(client, OBRIEN)) {
    const target = credit.kind === "album_credit" ? OBRIEN_ROLES[credit.role] : undefined;
    if (!target) { obrien.left.push(credit); continue; }
    obrien.credits.push({ ...credit, personId: target, action: await moveCredit(context, credit.kind, Number(credit.id), target) });
  }
  await openMixedReview(context, OBRIEN, obrien.left,
    `«O'Brien» juntaba a los hermanos de Las Cuatro Monedas (run ${runId}: membresías y créditos de disco repartidos). Quedan créditos de pista que dicen solo «O'Brien»: ¿de qué hermano son?`);
  for (const review of [1831943]) {
    await resolveReview(context, review, `«O'Brien» eran cuatro personas: membresías repartidas a Kenny, Gary, Marlene y Brenda O'Brien (run ${runId})`);
  }

  // Ezequiel Serrano
  await mergeInto(client, "person", FATHER, FATHER_DUPLICATE, note, runId);
  const ezequiel = { father: [] as unknown[], son: [] as unknown[], doubtful: [] as unknown[] };
  for (const credit of await credits(client, SON)) {
    const names = credit.names ?? "";
    const side = /valencia/i.test(names) || SON_ARTISTS.includes(credit.artist) ? "son"
      : DOUBTFUL_ARTISTS.includes(credit.artist) ? "doubtful" : "father";
    if (side !== "father") { ezequiel[side].push(credit); continue; }
    ezequiel.father.push({ ...credit, action: await moveCredit(context, credit.kind, Number(credit.id), FATHER) });
  }
  const memberships = (await client.query<{ id: string; artist: string; role: string; notes: string | null }>(`
    SELECT m.id::text, a.name AS artist, m.role, m.notes FROM public.artist_members m JOIN public.artists a ON a.id=m.artist_id
     WHERE m.person_id=$1 ORDER BY m.id`, [SON])).rows;
  for (const membership of memberships.filter((row) => FATHER_MEMBERSHIPS.includes(row.artist))) {
    await updateRelation(context, "artist_membership", Number(membership.id), { person_id: FATHER });
    ezequiel.father.push({ membership: Number(membership.id), artist: membership.artist });
  }
  // Cabezón Key: la run 12132 unió el saxo y la flauta del padre al rol del hijo.
  const cabezon = memberships.find((row) => row.artist === "Cabezón Key");
  if (!cabezon) throw new Error("falta la membresía de Cabezón Key");
  await updateRelation(context, "artist_membership", Number(cabezon.id), {
    role: "guitarra, teclados, programación, percusión, bajo, voz",
    notes: "biografía: «una formación integrada por Ezequiel Serrano Valencia en guitarra, teclados, programación, percusión, bajo y voz»",
  });
  const artistId = Number((await client.query<{ artist_id: string }>("SELECT artist_id::text FROM public.artist_members WHERE id=$1", [cabezon.id])).rows[0]!.artist_id);
  const created = await createRelation(context, "artist_membership", { artistId, personId: FATHER }, {
    role: "Soprano Sax & Flute", from_year: 2008, to_year: 2008, is_current: false,
    notes: "Músico acreditado en sus discos propios (2008; «Ezequiel Serrano C.» en Sincopa); regla de Brian 2026-10-01",
  });
  ezequiel.father.push({ membership: created.id, artist: "Cabezón Key", role: "Soprano Sax & Flute" });
  const aliases = await client.query(
    "UPDATE ingest.person_aliases SET person_id=$1 WHERE person_id=$2 AND alias=ANY($3::text[]) RETURNING id", [FATHER, SON, FATHER_ALIASES]);
  await client.query(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,'person',$2,'split_from',$3::jsonb,$4::jsonb,$5,'high','human')`,
  [runId, FATHER, JSON.stringify({ person_id: SON, aliases: aliases.rows.map((row) => Number(row.id)) }), JSON.stringify({ person_id: FATHER }),
    `Separación de fichas mezcladas: ${note}`]);
  const bios = new Map((await client.query<{ id: string; text: string }>(
    "SELECT id::text, raw_value#>>'{}' AS text FROM ingest.claims WHERE id=ANY($1::bigint[])", [[668042, 643783]])).rows.map((row) => [Number(row.id), row.text]));
  await updateEntity(context, "person", FATHER, { biography: bios.get(668042), birth_date: "1953-06-03", birth_city: "Bucaramanga" });
  await updateEntity(context, "person", SON, {
    biography: bios.get(643783),
    notes: "Separado de su padre, Ezequiel Serrano Calderón (#2568), el 2026-10-04: las fusiones de las runs 10448 y 11014 los habían juntado.",
  });
  if (ezequiel.doubtful.length) {
    await openMixedReview(context, SON, ezequiel.doubtful,
      `Ezequiel Serrano padre (#${FATHER}) o hijo (#${SON}): créditos sin señal suficiente tras separarlos (run ${runId}).`);
  }
  return { obrien, ezequiel, aliasesMoved: aliases.rowCount };
}

async function main(): Promise<void> {
  const note = phase === "sincopa"
    ? "Membresías repetidas (Brian, 2026-10-04): roles de Sincopa releídos con el adaptador 1.3.5 (varios roles por celda)"
    : phase === "periodos"
      ? "Membresías repetidas (Brian, 2026-10-04): períodos contradictorios unidos; manda Metal Archives > Sincopa > biografías"
      : phase === "misma-ficha"
        ? "Membresías repetidas (Brian, 2026-10-04): la misma ficha nombra a la persona en varias secciones; unidas, Seguridad Nacional en dos etapas"
        : phase === "separar"
          ? "Membresías repetidas (Brian, 2026-10-04): personas mezcladas separadas — «O'Brien» repartido entre los hermanos; Ezequiel Serrano padre (Calderón) e hijo (Valencia)"
      : "Membresías repetidas (Brian, 2026-10-04): una fila por persona y etapa en cada banda; roles unidos, textos originales en notas";
  const work = (context: OperatorContext) => (phase === "sincopa" ? sincopa(context) : phase === "periodos" ? periods(context)
    : phase === "misma-ficha" ? samePage(context) : phase === "separar" ? separate(context) : consolidate(context));
  let runId: number | null = null;
  let result: unknown;
  try {
    const done = await withOperatorRun({ name: `membresias-repetidas-${phase}`, operator: "brian", note, params: { phase } }, async (context) => {
      const output = await work(context);
      if (!confirm) throw new DryRun(output);
      return output;
    });
    runId = done.runId;
    result = done.result;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    result = error.result;
  }
  const file = `reports/membresias-repetidas-${DATE}-${phase}-${confirm ? `run${runId}` : "dry-run"}.json`;
  writeFileSync(file, `${JSON.stringify({ phase, confirm, runId, ...(result as object) }, null, 2)}\n`);
  const summary = Object.fromEntries(Object.entries(result as Record<string, unknown>)
    .map(([key, value]) => [key, Array.isArray(value) ? value.length : value]));
  console.log(JSON.stringify({ runId, file, ...summary }));
  await closeDb();
}

await main();
