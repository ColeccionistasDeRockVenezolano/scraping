// CRV · Análisis incremental de Curaduría contra PostgreSQL real
// (PLAN_CURADURIA E9, cierra A9): antes, cada escritura disparaba un análisis
// completo de 4,6 s sobre ~50k filas.
//
// Contratos de la etapa:
//  - una verificación dirigida mira la vecindad de lo que se tocó y solo los
//    detectores locales: lo global —duplicados, cola, «Otros»— sigue en pie sin
//    que nadie lo toque, que es la forma de no resolver lo que no se miró (C1);
//  - se guarda solo la diferencia: una fila que no cambió no se reescribe;
//  - medida con el DOBLE del catálogo real en el contenedor: análisis completo
//    por debajo de 5 s y verificación dirigida por debajo de 1 s (E9.5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { loadCatalogCopies } from "../support/curation-load-fixture.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { runCurationScan, waitForCurationScans, type ScanSummary } from "../../src/curation/scan.js";
import { resetLexiconCache } from "../../src/curation/lexicon-cache.js";

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface FindingRow { id: number; detector: string; status: string; title: string; last_seen: number }

describe("análisis incremental de Curaduría (E9)", () => {
  let container: PgContainer;
  let dirty: number;
  let twinA: number;
  let twinB: number;
  let pairFindingId: number;
  let fullScanId: number;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await waitForCurationScans(); resetLexiconCache(); await closeDb(); await container?.stop(); }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const findings = async (detector: string): Promise<FindingRow[]> =>
    (await getPool().query<{ id: string; detector: string; status: string; title: string; last_seen: string | null }>(
      `SELECT id::text, detector, status, title, last_seen_scan_id::text AS last_seen
         FROM ingest.curation_findings WHERE detector = $1 ORDER BY id`, [detector]))
      .rows.map((row) => ({ id: Number(row.id), detector: row.detector, status: row.status, title: row.title, last_seen: Number(row.last_seen) }));
  const counters = async (scanId: number): Promise<Record<string, number>> =>
    (await getPool().query<{ counters: Record<string, number> }>("SELECT counters FROM ingest.curation_scans WHERE id = $1", [scanId])).rows[0]!.counters;

  it("una verificación dirigida solo resuelve lo que miró: lo global sigue en pie (E9.1)", async () => {
    dirty = await one("INSERT INTO public.artists(name, origin_city) VALUES($1, 'Caracas') RETURNING id", [`Trueno${ZERO_WIDTH_SPACE} Negro`]);
    twinA = await one("INSERT INTO public.artists(name, origin_city) VALUES('Sentimiento Muerto', 'Caracas') RETURNING id");
    twinB = await one("INSERT INTO public.artists(name, origin_city) VALUES('Los Sentimiento Muerto', 'Caracas') RETURNING id");
    for (const artist of [dirty, twinA, twinB]) {
      const album = await one("INSERT INTO public.albums(artist_id, title) VALUES($1, $2) RETURNING id", [artist, `Disco ${artist}`]);
      await getPool().query("INSERT INTO public.tracks(album_id, track_number, title, duration_seconds) VALUES($1, 1, 'Calle Sola', 210)", [album]);
    }

    const full = await runCurationScan({ trigger: "manual" });
    expect(full).toMatchObject({ status: "ok", scope: "completo" });
    expect(full.timings.lexicon).toBe("catalogo");
    const pairs = await findings("artistas_equivalentes");
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ status: "open", last_seen: full.scanId });
    pairFindingId = pairs[0]!.id;
    fullScanId = full.scanId!;

    // La escritura: se limpia el invisible del artista de al lado.
    await getPool().query("UPDATE public.artists SET name = 'Trueno Negro' WHERE id = $1", [dirty]);
    const directed = await runCurationScan({ trigger: "correccion", focus: [{ kind: "artist", id: dirty }] });
    expect(directed).toMatchObject({ status: "ok", scope: "dirigido" });
    // Miró una vecindad, no el catálogo: el artista, su disco y su pista.
    expect(directed.timings.covered).toBeLessThanOrEqual(4);
    // El vocabulario salió de la caché sin cargar el catálogo. Si dice «cache»
    // o «cache_anterior» depende de si las estadísticas de PostgreSQL ya se
    // enteraron de la escritura, que llegan tarde a propósito.
    expect(["cache", "cache_anterior"]).toContain(directed.timings.lexicon);
    expect(directed.timings.lexiconMs).toBe(0);

    expect((await findings("caracteres_invisibles"))[0]).toMatchObject({ status: "resolved" });
    // Y el par de duplicados sigue exactamente donde estaba: el análisis
    // dirigido no corre detectores globales, así que tampoco los da por mirados.
    expect((await findings("artistas_equivalentes"))[0]).toMatchObject({ id: pairFindingId, status: "open", last_seen: full.scanId });
  }, 90_000);

  it("guarda solo la diferencia: lo que no cambió no se reescribe (E9.4)", async () => {
    // Se altera a mano el título guardado. Si el análisis reescribiera la fila
    // sin mirar, el cambio desaparecería; como la huella del contenido no se
    // movió, la fila solo recibe «te he vuelto a ver».
    const ALTERADO = "TÍTULO ALTERADO A MANO";
    await getPool().query("UPDATE ingest.curation_findings SET title = $2 WHERE id = $1", [pairFindingId, ALTERADO]);

    // Este completo es además la prueba de que el dirigido no se desvía: si la
    // verificación de la corrección hubiera dejado algo abierto que ya no está,
    // o se hubiera perdido algo que sigue, el completo lo diría aquí.
    const quiet = await runCurationScan({ trigger: "manual" });
    expect(quiet).toMatchObject({ status: "ok", inserted: 0, reopened: 0, resolved: 0 });
    expect((await counters(quiet.scanId!))["unchanged"]).toBeGreaterThan(0);
    // Intacta: ni el título alterado ni la marca del análisis que la vio.
    expect((await findings("artistas_equivalentes"))[0]).toMatchObject({ id: pairFindingId, title: ALTERADO, last_seen: fullScanId });

    // Cambia lo que el detector ve del par (uno de los dos se renombra, siguen
    // siendo equivalentes): misma huella de hallazgo, otro contenido, y ahora
    // sí se reescribe la fila entera.
    await getPool().query("UPDATE public.artists SET name = 'The Sentimiento Muerto' WHERE id = $1", [twinB]);
    const rewritten = await runCurationScan({ trigger: "manual" });
    const pair = (await findings("artistas_equivalentes"))[0]!;
    expect(pair).toMatchObject({ id: pairFindingId, status: "open", last_seen: rewritten.scanId });
    expect(pair.title).not.toBe(ALTERADO);
    expect(pair.title).toContain("The Sentimiento Muerto");
  }, 90_000);

  it("con el doble del catálogo real: completo por debajo de 5 s y dirigida por debajo de 1 s (E9.5)", async () => {
    // Mesa limpia: lo que midan estos números es el catálogo real por dos, no
    // los restos de las pruebas de arriba (que además chocan con nombres de
    // verdad: «Sentimiento Muerto» está en la foto).
    await getPool().query("TRUNCATE public.artists, public.persons, public.organizations RESTART IDENTITY CASCADE");
    await getPool().query("DELETE FROM ingest.curation_findings");
    const loaded = await loadCatalogCopies(getPool(), 2);
    expect(loaded.rows).toBeGreaterThan(88_000);

    // Primera pasada: da de alta todo lo que encuentra en un catálogo que
    // nunca se analizó. No es el caso que mide A9 (el análisis de régimen),
    // pero queda su número para saber cuánto cuesta arrancar.
    const cold = await runCurationScan({ trigger: "manual" });
    expect(cold.status).toBe("ok");

    // El de régimen: el que corre cada vez que el catálogo se mueve.
    const warm = await runCurationScan({ trigger: "manual" });
    expect(warm.status).toBe("ok");
    expect(warm.inserted).toBe(0);
    expect((await counters(warm.scanId!))["unchanged"]).toBeGreaterThan(1000);

    // La verificación de una corrección: la vecindad de una ficha y los
    // detectores locales, con el vocabulario que dejó el completo.
    const big = await one("SELECT id FROM public.artists ORDER BY id DESC LIMIT 1");
    await getPool().query("UPDATE public.artists SET name = name || $2 WHERE id = $1", [big, `${ZERO_WIDTH_SPACE}`]);
    const directed = await runCurationScan({ trigger: "correccion", focus: [{ kind: "artist", id: big }] });
    expect(directed).toMatchObject({ status: "ok", scope: "dirigido" });
    expect(directed.timings.lexiconMs).toBe(0);

    const line = (label: string, scan: ScanSummary) =>
      `${label}: ${scan.durationMs} ms (foto ${scan.timings.snapshotMs} · vocabulario ${scan.timings.lexiconMs} · detectores ${scan.timings.detectMs} · guardar ${scan.timings.persistMs}) · ${scan.total} hallazgos`;
    // La medida es el resultado de la prueba (E9.5): se imprime para que quede
    // en la salida de `npm run test:contract`.
    console.log([`E9.5 · ${loaded.rows} filas (${loaded.artists} artistas, ${loaded.persons} personas, ${loaded.albums} discos, ${loaded.tracks} pistas)`,
      line("  completo en frío", cold), line("  completo de régimen", warm), line("  dirigido", directed)].join("\n"));

    expect(warm.durationMs).toBeLessThan(5_000);
    expect(directed.durationMs).toBeLessThan(1_000);
  }, 300_000);
});
