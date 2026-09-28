import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { migrateUp } from "../../src/db/migrate.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { createRelation, updateRelation, withOperatorRun } from "../../src/merge/operator.js";
import { mergeInto } from "../../src/review/duplicates.js";
import { undoRun } from "../../src/merge/run-undo.js";
import { applyVenezuelanEvidence, readVenezuelanEvidence } from "../../src/review/person-venezuelan.js";

// 0029 + `crv review derive-venezuelan`: is_venezuelan admite NULL (sin dato)
// y se deriva de membresías y créditos de músico/invitado en discos venezolanos.
describe("venezolano/a en personas (0029)", () => {
  let container: PgContainer;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    // Una persona de antes de 0029: el DEFAULT le puso false sin que nadie lo dijera.
    await getPool().query("INSERT INTO public.persons(name) VALUES('Previa a 0029')");
    await migrateUp();
  }, 120_000);

  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await getPool().query<{ id: string }>(sql, params)).rows[0]!.id);
  const venezuelan = async (id: number): Promise<boolean | null> =>
    (await getPool().query<{ v: boolean | null }>("SELECT is_venezuelan AS v FROM public.persons WHERE id=$1", [id])).rows[0]!.v;

  it("el false del DEFAULT pasa a sin dato y las personas nuevas nacen sin dato", async () => {
    const previous = await one("SELECT id FROM public.persons WHERE name='Previa a 0029'");
    expect(await venezuelan(previous)).toBeNull();
    expect(await venezuelan(await one("INSERT INTO public.persons(name) VALUES('Nueva') RETURNING id"))).toBeNull();
  });

  it("marca miembros y músicos/invitados de discos venezolanos; deja técnicos, extranjeros y lo afirmado", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Venezolana') RETURNING id");
    const foreign = await one("INSERT INTO public.artists(name,origin_country) VALUES('Banda Italiana','Italia') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco VE') RETURNING id", [band]);
    const foreignAlbum = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco IT') RETURNING id", [foreign]);
    const track = await one("INSERT INTO public.tracks(album_id,title,disc_number,track_number) VALUES($1,'Pista',1,1) RETURNING id", [album]);

    const member = await one("INSERT INTO public.persons(name) VALUES('Miembro') RETURNING id");
    const musician = await one("INSERT INTO public.persons(name) VALUES('Músico') RETURNING id");
    const guest = await one("INSERT INTO public.persons(name) VALUES('Invitado') RETURNING id");
    const engineer = await one("INSERT INTO public.persons(name) VALUES('Ingeniero') RETURNING id");
    const abroad = await one("INSERT INTO public.persons(name) VALUES('Músico italiano') RETURNING id");
    const asserted = await one("INSERT INTO public.persons(name,is_venezuelan) VALUES('Extranjero afirmado',false) RETURNING id");

    await getPool().query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES($1,$2,'Voz')", [band, member]);
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Bajo')", [album, musician]);
    await getPool().query("INSERT INTO public.track_credits(track_id,person_id,credit_type,role) VALUES($1,$2,'guest','Saxo')", [track, guest]);
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'mastering','Mastering')", [album, engineer]);
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Guitarra')", [foreignAlbum, abroad]);
    await getPool().query("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES($1,$2,'musician','Batería')", [album, asserted]);

    const summary = await readVenezuelanEvidence(getPool());
    expect(summary.evidence.map((item) => item.personId).sort((a, b) => a - b)).toEqual([member, musician, guest]);
    expect(summary.alreadyFalse).toBe(1);

    const applied = await applyVenezuelanEvidence(summary.evidence, { note: "prueba", operator: "prueba" });
    expect(applied).toMatchObject({ updated: 3, skipped: 0 });
    for (const id of [member, musician, guest]) expect(await venezuelan(id)).toBe(true);
    for (const id of [engineer, abroad]) expect(await venezuelan(id)).toBeNull();
    expect(await venezuelan(asserted)).toBe(false);

    const { rows } = await getPool().query<{ reason: string; run_id: string }>(
      "SELECT reason, run_id::text FROM ingest.merge_audit WHERE person_id=$1 AND field='is_venezuelan'", [member]);
    expect(rows).toEqual([{ reason: "derivado del catálogo: miembro de Banda Venezolana", run_id: String(applied.runs[0]) }]);

    // Repetir no encuentra nada que marcar.
    expect((await readVenezuelanEvidence(getPool())).evidence).toEqual([]);

    // El run se deshace con el diario: vuelven a sin dato.
    await withOperatorRun({ name: "test:undo", operator: "prueba", note: "deshacer la derivación" },
      (context) => undoRun(context, applied.runs[0]!));
    for (const id of [member, musician, guest]) expect(await venezuelan(id)).toBeNull();
  });

  it("el alta de un crédito de músico marca a la persona en el acto; uno de mastering no, hasta que pasa a invitado", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Alta') RETURNING id");
    const album = await one("INSERT INTO public.albums(artist_id,title) VALUES($1,'Disco Alta') RETURNING id", [band]);
    const player = await one("INSERT INTO public.persons(name) VALUES('Tecladista Alta') RETURNING id");
    const engineer = await one("INSERT INTO public.persons(name) VALUES('Ingeniera Alta') RETURNING id");
    const note = "prueba del alta";
    const { runId } = await withOperatorRun({ name: "test:credit", operator: "prueba", note },
      (context) => createRelation(context, "album_credit", { albumId: album, personId: player }, { credit_role: "Teclados", credit_type: "musician" }));
    expect(await venezuelan(player)).toBe(true);
    const audit = await getPool().query<{ run_id: string }>("SELECT run_id::text FROM ingest.merge_audit WHERE person_id=$1 AND field='is_venezuelan'", [player]);
    expect(audit.rows).toEqual([{ run_id: String(runId) }]);

    const { result: credit } = await withOperatorRun({ name: "test:credit", operator: "prueba", note },
      (context) => createRelation(context, "album_credit", { albumId: album, personId: engineer }, { credit_role: "Mastering", credit_type: "mastering" }));
    expect(await venezuelan(engineer)).toBeNull();
    await withOperatorRun({ name: "test:credit", operator: "prueba", note },
      (context) => updateRelation(context, "album_credit", credit.id, { credit_type: "guest" }));
    expect(await venezuelan(engineer)).toBe(true);
  });

  it("al fusionar, la ficha que queda hereda la evidencia del duplicado", async () => {
    const band = await one("INSERT INTO public.artists(name) VALUES('Banda Fusión') RETURNING id");
    const keep = await one("INSERT INTO public.persons(name) VALUES('Fusión A') RETURNING id");
    const drop = await one("INSERT INTO public.persons(name) VALUES('Fusión B') RETURNING id");
    // Membresía escrita a mano, sin pasar por el alta: la derivación no la vio.
    await getPool().query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES($1,$2,'Batería')", [band, drop]);
    await withOperatorRun({ name: "test:merge", operator: "prueba", note: "fusión" },
      (context) => mergeInto(context.client, "person", keep, drop, "fusión", context.runId));
    expect(await venezuelan(keep)).toBe(true);
  });
});
