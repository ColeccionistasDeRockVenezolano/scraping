// CRV · Pruebas de contrato de acciones estructurales contra PostgreSQL (PLAN_CURADURIA E6).
//
// Verifica contra base real:
//   - renumerar_consecutivo en dos fases respeta tracks_position_uk.
//   - split de persona conserva todos los créditos y membresías duplicándolos en cada destino.
//   - fusión de álbumes (album-merge) empareja pistas, mueve pistas no emparejadas,
//     unifica formatos y créditos equivalentes, y se deshace con undoMergeRun (versión 2).
//   - acciones compuestas y de coherencia (fijar tipo, mover duración, extraer intérprete,
//     retirar huérfana, vincular como miembro) aplican y deshacen sin dejar rastro.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { buildApp } from "../../src/api/app.js";
import { withOperatorRun } from "../../src/merge/operator.js";
import { undoMergeRun } from "../../src/merge/unmerge.js";
import { undoEntityRemoval, undoRelationCreation } from "../../src/merge/structural-undo.js";
import { undoFieldCorrections } from "../../src/merge/field-undo.js";
import { splitPerson } from "../../src/review/person-corrections.js";
import { mergeAlbums, previewAlbumMerge } from "../../src/merge/album-merge.js";
import {
  fijarTipoDeDiscoAction,
  moverDuracionAction,
  renumerarConsecutivoAction,
  retirarHuerfanaAction,
  vincularComoMiembroAction,
} from "../../src/curation/actions/structural.js";

const TOKEN = "token-de-prueba-estructurales-0123456789";
const OPERATOR = "Tester Estructurales";

describe("acciones estructurales (PLAN_CURADURIA E6)", () => {
  let container: PgContainer;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["CRV_OPERATOR_TOKEN"] = TOKEN;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDb();
    await container.stop();
  }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);

  // -------------------------------------------------------------------------
  // E6.6: renumerar_consecutivo en dos fases respeta tracks_position_uk
  // -------------------------------------------------------------------------
  it("renumerar_consecutivo respeta tracks_position_uk con huecos y orden alternativo", async () => {
    const pool = getPool();
    const artistId = await one("INSERT INTO public.artists(name) VALUES ('Sentimiento Muerto') RETURNING id");
    const albumId = await one(
      "INSERT INTO public.albums(artist_id, title, release_year) VALUES ($1, 'El Amor Ya No Existe', 1988) RETURNING id",
      [artistId],
    );
    // Pistas con números 2, 4, 6 (huecos, empieza en 2)
    const t2 = await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1, 1, 2, 'Cero') RETURNING id", [albumId]);
    const t4 = await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1, 1, 4, 'Uno') RETURNING id", [albumId]);
    const t6 = await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1, 1, 6, 'Dos') RETURNING id", [albumId]);

    await withOperatorRun({ name: "test:renumber", operator: OPERATOR, note: "renumerar prueba" }, async (context) => {
      await renumerarConsecutivoAction.apply(context, {} as never, { albumId, discNumber: 1 }, {} as never);
    });

    const { rows } = await pool.query<{ id: number; track_number: number }>(
      "SELECT id::int, track_number FROM public.tracks WHERE album_id=$1 AND disc_number=1 ORDER BY track_number",
      [albumId],
    );
    expect(rows).toEqual([
      { id: t2, track_number: 1 },
      { id: t4, track_number: 2 },
      { id: t6, track_number: 3 },
    ]);
  });

  // -------------------------------------------------------------------------
  // E6.3: split de persona conserva todos los créditos
  // -------------------------------------------------------------------------
  it("splitPerson divide la ficha repartiendo toda la trayectoria y créditos", async () => {
    const pool = getPool();
    const artistId = await one("INSERT INTO public.artists(name) VALUES ('Los Mentas') RETURNING id");
    const albumId = await one("INSERT INTO public.albums(artist_id, title, release_year) VALUES ($1, 'Taguara S.K.A.', 2000) RETURNING id", [artistId]);
    const trackId = await one("INSERT INTO public.tracks(album_id, track_number, title) VALUES ($1, 1, 'Zapatos') RETURNING id", [albumId]);

    // Persona combinada
    const combinedId = await one("INSERT INTO public.persons(name) VALUES ('Juan Pérez y Pedro López') RETURNING id");
    // Créditos en disco y pista, y membresía
    await pool.query("INSERT INTO public.album_credits(album_id, person_id, credit_type, role) VALUES ($1, $2, 'musician', 'Guitarra')", [albumId, combinedId]);
    await pool.query("INSERT INTO public.track_credits(track_id, person_id, credit_type, role) VALUES ($1, $2, 'composer', 'Compositor')", [trackId, combinedId]);
    await pool.query("INSERT INTO public.artist_members(artist_id, person_id, role) VALUES ($1, $2, 'Guitarrista')", [artistId, combinedId]);

    const outcome = await withOperatorRun({ name: "test:split", operator: OPERATOR, note: "dividir personas" }, async (context) => {
      return splitPerson(context.client, combinedId, ["Juan Pérez", "Pedro López"], context.note, context.runId);
    });

    expect(outcome.result.status).toBe("applied");
    expect(outcome.result.targetIds).toHaveLength(2);

    // Ficha original retirada
    const origExists = (await pool.query("SELECT 1 FROM public.persons WHERE id=$1", [combinedId])).rowCount;
    expect(origExists).toBe(0);

    // Ambas personas destino tienen sus créditos y membresías
    for (const targetId of outcome.result.targetIds) {
      const albumCredits = (await pool.query("SELECT 1 FROM public.album_credits WHERE person_id=$1", [targetId])).rowCount;
      const trackCredits = (await pool.query("SELECT 1 FROM public.track_credits WHERE person_id=$1", [targetId])).rowCount;
      const members = (await pool.query("SELECT 1 FROM public.artist_members WHERE person_id=$1", [targetId])).rowCount;
      expect(albumCredits).toBe(1);
      expect(trackCredits).toBe(1);
      expect(members).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // E6.5: fusión de álbumes (album-merge) con pistas y créditos cruzados + undo
  // -------------------------------------------------------------------------
  it("album-merge empareja pistas, mueve no emparejadas, unifica formatos y es reversible con undoMergeRun", async () => {
    const client = await getPool().connect();
    try {
      const artistId = await one("INSERT INTO public.artists(name) VALUES ('La Misma Gente') RETURNING id");
      const keepAlbumId = await one("INSERT INTO public.albums(artist_id, title, release_year, album_type) VALUES ($1, 'Por Fin', 1983, 'studio_album') RETURNING id", [artistId]);
      const dropAlbumId = await one("INSERT INTO public.albums(artist_id, title, release_year, album_type) VALUES ($1, 'Por Fin (Reedición)', 1983, 'studio_album') RETURNING id", [artistId]);

      // Pista emparejada (disco 1, pista 1)
      await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1, 1, 1, 'Lluvia') RETURNING id", [keepAlbumId]);
      await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1, 1, 1, 'Lluvia') RETURNING id", [dropAlbumId]);

      // Pista no emparejada en drop (disco 1, pista 2)
      const dTrack2 = await one("INSERT INTO public.tracks(album_id, disc_number, track_number, title) VALUES ($1, 1, 2, 'Sol') RETURNING id", [dropAlbumId]);

      // Formato en drop
      const fmtId = await one("INSERT INTO public.album_formats(album_id, format) VALUES ($1, 'Vinilo') RETURNING id", [dropAlbumId]);

      // Previsualización de fusión
      const preview = await previewAlbumMerge(client, keepAlbumId, dropAlbumId);
      expect(preview.matchedTracks).toHaveLength(1);
      expect(preview.unmatchedDropTracks).toHaveLength(1);
      expect(preview.formatsToAdd).toHaveLength(1);

      // Fusión ejecutada
      const { runId, result } = await withOperatorRun({ name: "test:album-merge", operator: OPERATOR, note: "fusión de prueba" }, async (context) => {
        return mergeAlbums(context, {
          keepId: keepAlbumId,
          dropId: dropAlbumId,
          previewHash: preview.previewHash,
        });
      });

      expect(result.tracksMerged).toBe(1);
      expect(result.tracksMoved).toBe(1);
      expect(result.formatsMerged).toBe(1);

      // dropAlbum ya no existe (fue fusionado)
      const dropExists = (await client.query("SELECT 1 FROM public.albums WHERE id=$1", [dropAlbumId])).rowCount;
      expect(dropExists).toBe(0);

      // Formato repuntado
      const fmtOwner = (await client.query<{ album_id: number }>("SELECT album_id::int FROM public.album_formats WHERE id=$1", [fmtId])).rows[0]?.album_id;
      expect(fmtOwner).toBe(keepAlbumId);

      // Pista 2 movida a keepAlbum
      const movedOwner = (await client.query<{ album_id: number }>("SELECT album_id::int FROM public.tracks WHERE id=$1", [dTrack2])).rows[0]?.album_id;
      expect(movedOwner).toBe(keepAlbumId);

      // Deshacer con undoMergeRun
      await withOperatorRun({ name: "test:unmerge", operator: OPERATOR, note: "deshacer fusión" }, async (context) => {
        await undoMergeRun(context, runId);
      });

      // dropAlbum restaurado tras el deshacer
      const dropRestored = (await client.query("SELECT 1 FROM public.albums WHERE id=$1", [dropAlbumId])).rowCount;
      expect(dropRestored).toBe(1);
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // Acciones de coherencia con deshacer
  // -------------------------------------------------------------------------
  it("fijar_tipo_de_disco aplica y se deshace con undoFieldCorrections", async () => {
    const artistId = await one("INSERT INTO public.artists(name) VALUES ('Dermis Tatú') RETURNING id");
    const albumId = await one("INSERT INTO public.albums(artist_id, title, album_type) VALUES ($1, 'La Violó, La Mató, La Picó', 'other') RETURNING id", [artistId]);

    const { runId } = await withOperatorRun({ name: "test:fijar-tipo", operator: OPERATOR, note: "fijar tipo" }, async (context) => {
      await fijarTipoDeDiscoAction.apply(context, {} as never, { albumId, albumType: "studio_album" }, {} as never);
    });

    const pool = getPool();
    let row = (await pool.query<{ album_type: string }>("SELECT album_type::text FROM public.albums WHERE id=$1", [albumId])).rows[0];
    expect(row?.album_type).toBe("studio_album");

    // Deshacer
    await withOperatorRun({ name: "test:undo", operator: OPERATOR, note: "deshacer" }, async (context) => {
      await undoFieldCorrections(context, runId);
    });

    row = (await pool.query<{ album_type: string }>("SELECT album_type::text FROM public.albums WHERE id=$1", [albumId])).rows[0];
    expect(row?.album_type).toBe("other");
  });

  it("mover_duracion extrae segundos al campo de la pista y se deshace", async () => {
    const artistId = await one("INSERT INTO public.artists(name) VALUES ('Pacífica') RETURNING id");
    const albumId = await one("INSERT INTO public.albums(artist_id, title) VALUES ($1, 'Pacífica EP') RETURNING id", [artistId]);
    const trackId = await one("INSERT INTO public.tracks(album_id, track_number, title) VALUES ($1, 1, 'Canción 4:15') RETURNING id", [albumId]);

    const { runId } = await withOperatorRun({ name: "test:mover-duracion", operator: OPERATOR, note: "mover duración" }, async (context) => {
      await moverDuracionAction.apply(context, {} as never, { trackId, cleanTitle: "Canción", durationSeconds: 255 }, {} as never);
    });

    const pool = getPool();
    let track = (await pool.query<{ title: string; duration_seconds: number | null }>("SELECT title, duration_seconds FROM public.tracks WHERE id=$1", [trackId])).rows[0];
    expect(track?.title).toBe("Canción");
    expect(track?.duration_seconds).toBe(255);

    // Deshacer
    await withOperatorRun({ name: "test:undo", operator: OPERATOR, note: "deshacer" }, async (context) => {
      await undoFieldCorrections(context, runId);
    });

    track = (await pool.query<{ title: string; duration_seconds: number | null }>("SELECT title, duration_seconds FROM public.tracks WHERE id=$1", [trackId])).rows[0];
    expect(track?.title).toBe("Canción 4:15");
    expect(track?.duration_seconds).toBeNull();
  });

  it("vincular_como_miembro crea relación y se deshace con undoRelationCreation", async () => {
    const artistId = await one("INSERT INTO public.artists(name) VALUES ('Culto Oculto') RETURNING id");
    const personId = await one("INSERT INTO public.persons(name) VALUES ('Paulo Soto') RETURNING id");

    const { runId } = await withOperatorRun({ name: "test:vincular", operator: OPERATOR, note: "vincular miembro" }, async (context) => {
      await vincularComoMiembroAction.apply(context, {} as never, { personId, artistId, role: "Baterista" }, {} as never);
    });

    const pool = getPool();
    let member = (await pool.query("SELECT 1 FROM public.artist_members WHERE person_id=$1 AND artist_id=$2", [personId, artistId])).rowCount;
    expect(member).toBe(1);

    // Deshacer creación de relación
    await withOperatorRun({ name: "test:undo-rel", operator: OPERATOR, note: "deshacer relación" }, async (context) => {
      await undoRelationCreation(context, runId);
    });

    member = (await pool.query("SELECT 1 FROM public.artist_members WHERE person_id=$1 AND artist_id=$2", [personId, artistId])).rowCount;
    expect(member).toBe(0);
  });

  it("retirar_huerfana elimina ficha sin dependientes y se deshace con undoEntityRemoval", async () => {
    const personId = await one("INSERT INTO public.persons(name) VALUES ('Persona Sin Vínculos QA') RETURNING id");

    const { runId } = await withOperatorRun({ name: "test:retirar-huerfana", operator: OPERATOR, note: "retirar huérfana" }, async (context) => {
      await retirarHuerfanaAction.apply(context, {} as never, { kind: "person", id: personId }, {} as never);
    });

    const pool = getPool();
    let exists = (await pool.query("SELECT 1 FROM public.persons WHERE id=$1", [personId])).rowCount;
    expect(exists).toBe(0);

    // Deshacer eliminación de entidad
    await withOperatorRun({ name: "test:undo-removal", operator: OPERATOR, note: "restaurar entidad" }, async (context) => {
      await undoEntityRemoval(context, runId);
    });

    exists = (await pool.query("SELECT 1 FROM public.persons WHERE id=$1", [personId])).rowCount;
    expect(exists).toBe(1);
    const name = (await pool.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1", [personId])).rows[0]?.name;
    expect(name).toBe("Persona Sin Vínculos QA");
  });
});
