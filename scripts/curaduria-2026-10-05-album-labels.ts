// CRV · Curaduría 2026-10-05: sello de los discos desde Sincopa (solo vacíos).
//
// Sincopa da el sello de ~5.000 discos (claim `label`, aceptado) pero el motor
// no lo escribe: `label` es texto y `albums.label_id` es una ficha. Las fichas
// de sello sí se crearon (claims `organization`), y como ningún disco las
// apunta, Curaduría las ve «sin vínculos». Aquí se resuelve el texto a su ficha
// (nombre o alias, sin tildes ni mayúsculas, y solo si es una) y se rellena
// `label_id` donde está vacío. Regla de las fuentes: rellenan vacíos, nunca
// pisan. «Independent» no es un sello. Con varios sellos (fichas de distintas
// ediciones) manda la ficha cuyo año coincide con el del disco, luego el más
// citado; un empate queda fuera.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-album-labels.ts [--confirm]
import { writeFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const OPERATOR = "claude-code";
const NOTE = "Curaduría 2026-10-05: sello del disco según Sincopa (claim label aceptado), solo donde el disco no tenía sello";
const fold = (s: string): string => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();
const GENERIC = new Set(["independent", "independiente", "indie", "independiente ve", "self released", "autoproduccion", "autoproducido", "n a", "none", "private", "privado"]);

async function work(client: PoolClient): Promise<Record<string, unknown>> {
  const { rows: orgs } = await client.query<{ id: string; name: string }>("SELECT id::text, name FROM public.organizations");
  const { rows: aliases } = await client.query<{ id: string; alias: string }>("SELECT organization_id::text AS id, alias FROM ingest.organization_aliases");
  const byKey = new Map<string, Set<number>>();
  const add = (key: string, id: number): void => { if (!byKey.has(key)) byKey.set(key, new Set()); byKey.get(key)!.add(id); };
  for (const org of orgs) add(fold(org.name), Number(org.id));
  for (const alias of aliases) add(fold(alias.alias), Number(alias.id));
  const { rows: claims } = await client.query<{ album_id: string; value: string; year: number | null; page_year: string | null }>(`
    SELECT c.album_id::text, c.raw_value #>> '{}' AS value, a.release_year AS year,
           (SELECT substring(y.raw_value #>> '{}' from '(\\d{4})') FROM ingest.claims y
             WHERE y.raw_page_id=c.raw_page_id AND y.source_id=c.source_id AND y.album_id=c.album_id AND y.field='release_year' LIMIT 1) AS page_year
      FROM ingest.claims c JOIN public.albums a ON a.id=c.album_id
     WHERE c.source_id=(SELECT id FROM ingest.sources WHERE slug='sincopa') AND c.field='label' AND c.status='accepted' AND a.label_id IS NULL`);
  const perAlbum = new Map<number, Array<{ org: number; sameYear: boolean }>>();
  const unresolved = new Map<string, number>();
  for (const claim of claims) {
    const key = fold(claim.value);
    if (!key || GENERIC.has(key)) continue;
    const ids = byKey.get(key);
    if (!ids || ids.size !== 1) { unresolved.set(claim.value, (unresolved.get(claim.value) ?? 0) + 1); continue; }
    const list = perAlbum.get(Number(claim.album_id)) ?? [];
    list.push({ org: [...ids][0]!, sameYear: claim.page_year !== null && Number(claim.page_year) === claim.year });
    perAlbum.set(Number(claim.album_id), list);
  }
  let linked = 0; let tied = 0;
  for (const [albumId, list] of perAlbum) {
    const score = new Map<number, number>();
    for (const item of list) score.set(item.org, (score.get(item.org) ?? 0) + 1 + (item.sameYear ? 100 : 0));
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) { tied += 1; continue; }
    const result = await client.query("UPDATE public.albums SET label_id=$2 WHERE id=$1 AND label_id IS NULL", [albumId, ranked[0]![0]]);
    linked += result.rowCount ?? 0;
  }
  const report = { claims: claims.length, albums: perAlbum.size, linked, tied, unresolved: [...unresolved.entries()].sort((a, b) => b[1] - a[1]) };
  return report;
}

async function main(): Promise<void> {
  let report: Record<string, unknown>;
  if (process.argv.includes("--confirm")) {
    const { runId, result } = await withOperatorRun({ name: "curation:album-labels-from-sincopa", operator: OPERATOR, note: NOTE }, (context) => work(context.client));
    report = { runId, ...result };
  } else {
    const client = await getPool().connect();
    try { await client.query("BEGIN"); report = await work(client); } finally { await client.query("ROLLBACK"); client.release(); }
  }
  writeFileSync(`reports/curaduria-2026-10-05/album-labels-${process.argv.includes("--confirm") ? "confirm" : "dry-run"}.json`, JSON.stringify(report, null, 1));
  const { unresolved, ...rest } = report as { unresolved: unknown[] };
  console.log(rest, `${unresolved.length} textos sin ficha única`);
  await closeDb();
}
void main();
