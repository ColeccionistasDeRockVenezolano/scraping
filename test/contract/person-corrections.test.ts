import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { applyPersonCorrections, type PersonCorrectionPlan } from "../../src/review/person-corrections.js";

// Las correcciones del caso Caramelos sobre una base desechable: personas,
// créditos y claims como los dejó la ingesta, y el plan aplicado dos veces.
describe("correcciones de personas contra PostgreSQL", () => {
  let container: PgContainer;
  const ids: Record<string, number> = {};
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  let plan: PersonCorrectionPlan;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    const pool = getPool();
    const one = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ id: string }>(sql, params)).rows[0]!.id);
    ids["source"] = await one("INSERT INTO ingest.sources(slug,name,site_type,trust_level) VALUES ('sincopa-test','Sincopa','website','medium') RETURNING id");
    ids["artist"] = await one("INSERT INTO public.artists(name) VALUES ('Caramelos De Cianuro') RETURNING id");
    ids["album"] = await one("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Las Paticas De La Abuela',1992,'ep') RETURNING id", [ids["artist"]]);
    for (const [key, name] of [["boris", "Boris Milán"], ["car", "Car"], ["rondon", "los Rondon"], ["golding", "Luis \"Golding\" Barrios"], ["luis", "Luis Barrios"], ["band", "Caramelos de Cianuro"]] as const) {
      ids[key] = await one("INSERT INTO public.persons(name) VALUES ($1) RETURNING id", [name]);
      await pool.query("INSERT INTO ingest.person_aliases(person_id,alias,normalized_alias) VALUES ($1,$2::text,lower($2::text))", [ids[key], name]);
      await pool.query(`INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status)
        VALUES ($1,'person',$2,'name',to_jsonb($3::text),$4,'accepted')`, [ids["source"], ids[key], name, hash(`person:${name}`)]);
      await pool.query(`INSERT INTO ingest.merge_audit(entity_kind,person_id,field,new_value,reason,confidence,performed_by)
        VALUES ('person',$1,'name',to_jsonb($2::text),'alta de prueba','high','human')`, [ids[key], name]);
    }
    const credit = async (key: string, target: "person_id" | "artist_id", targetId: number, type: string, role: string) => {
      ids[key] = await one(`INSERT INTO public.album_credits(album_id,${target},credit_type,role) VALUES ($1,$2,$3::credit_type,$4) RETURNING id`, [ids["album"], targetId, type, role]);
      await pool.query(`INSERT INTO ingest.claims(source_id,entity_kind,album_credit_id,field,raw_value,raw_hash,status)
        VALUES ($1,'album_credit',$2,'credit_role',to_jsonb($3::text),$4,'accepted')`, [ids["source"], ids[key], role, hash(`credit:${key}`)]);
    };
    await credit("c_boris", "person_id", ids["boris"]!, "mixing", "mixed");
    await credit("c_car", "person_id", ids["car"]!, "photography", "Photos");
    await credit("c_rondon", "person_id", ids["rondon"]!, "photography", "Photos");
    await credit("c_golding", "person_id", ids["golding"]!, "musician", "Guitar & Backing Vocals");
    await credit("c_luis", "person_id", ids["luis"]!, "musician", "Guitar & Backing Vocals");
    await credit("c_band_artist", "artist_id", ids["artist"]!, "producer", "produced");
    await credit("c_band_person", "person_id", ids["band"]!, "producer", "Produced by");
    await pool.query("INSERT INTO public.artist_members(artist_id,person_id,role) VALUES ($1,$2,'Bass')", [ids["artist"], ids["luis"]]);
    // Crédito de pista acotado por número: su claim guarda la FK de otra pista
    // y la evidencia de esta fila solo existe a través de su auditoría.
    const track = await one("INSERT INTO public.tracks(album_id,track_number,title) VALUES ($1,1,'Chan², Chaca², Chan²') RETURNING id", [ids["album"]]);
    const trackCredit = await one("INSERT INTO public.track_credits(track_id,person_id,credit_type,role) VALUES ($1,$2,'producer','Produced by') RETURNING id", [track, ids["band"]]);
    const creation = await one(`INSERT INTO ingest.merge_audit(entity_kind,track_credit_id,field,new_value,reason,confidence,performed_by)
      VALUES ('track_credit',$1,'insert','{}'::jsonb,'crédito nuevo de prueba','high','human') RETURNING id`, [trackCredit]);
    const bandClaim = (await pool.query<{ id: string }>("SELECT id::text FROM ingest.claims WHERE person_id=$1", [ids["band"]])).rows[0]!.id;
    await pool.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES ($1,$2)", [creation, bandClaim]);

    plan = {
      decidedAt: "2026-09-14", evidence: "prueba de contrato",
      corrections: [
        { op: "rename", person: { id: ids["boris"]!, name: "Boris Milán" }, to: "Boris Milan", keepOldNameAsAlias: true, why: "grafía del video" },
        { op: "rename", person: { id: ids["car"]!, name: "Car" }, to: "Carlos Rondon", keepOldNameAsAlias: false, why: "nombre cortado" },
        { op: "merge", keep: { id: ids["car"]!, name: "Carlos Rondon" }, drop: { id: ids["rondon"]!, name: "los Rondon" }, keepDropNameAsAlias: false, why: "nombre cortado" },
        { op: "drop_aliases", person: { id: ids["car"]!, name: "Carlos Rondon" }, aliases: ["Car", "los Rondon"], why: "fragmentos" },
        { op: "merge", keep: { id: ids["golding"]!, name: "Luis \"Golding\" Barrios" }, drop: { id: ids["luis"]!, name: "Luis Barrios" }, keepDropNameAsAlias: true, why: "misma persona" },
        { op: "to_artist", person: { id: ids["band"]!, name: "Caramelos de Cianuro" }, artist: { id: ids["artist"]!, name: "Caramelos De Cianuro" }, keepNameAsAlias: false, why: "la banda produce" },
      ],
    };
  }, 120_000);
  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("--dry-run no deja rastro", async () => {
    const result = await applyPersonCorrections(plan, "prueba", { dryRun: true });
    expect(result.outcomes.every((item) => item.status === "applied")).toBe(true);
    const persons = await getPool().query("SELECT count(*)::int AS n FROM public.persons");
    expect(persons.rows[0]!.n).toBe(6);
  });

  it("aplica el plan sin perder evidencia y la segunda vez no cambia nada", async () => {
    const pool = getPool();
    const first = await applyPersonCorrections(plan, "decisión del propietario");
    expect(first.outcomes.map((item) => item.status)).toEqual(["applied", "applied", "applied", "applied", "applied", "applied"]);
    expect(first.creditsMerged).toBe(3);

    const persons = await pool.query<{ id: string; name: string }>("SELECT id::text,name FROM public.persons ORDER BY id");
    expect(persons.rows.map((row) => row.name)).toEqual(["Boris Milan", "Carlos Rondon", "Luis \"Golding\" Barrios"]);
    const aliases = await pool.query<{ person_id: string; alias: string }>("SELECT person_id::text,alias FROM ingest.person_aliases ORDER BY person_id,alias");
    expect(aliases.rows.filter((row) => Number(row.person_id) === ids["car"]).map((row) => row.alias)).toEqual([]);
    expect(aliases.rows.filter((row) => Number(row.person_id) === ids["golding"]).map((row) => row.alias).sort()).toEqual(["Luis \"Golding\" Barrios", "Luis Barrios"].sort());

    const credits = await pool.query<{ credit_type: string; role: string; person: string | null; artist: string | null }>(`
      SELECT ac.credit_type::text, ac.role, p.name AS person, ar.name AS artist FROM public.album_credits ac
        LEFT JOIN public.persons p ON p.id=ac.person_id LEFT JOIN public.artists ar ON ar.id=ac.artist_id ORDER BY ac.credit_type, ac.id`);
    expect(credits.rows).toEqual([
      { credit_type: "musician", role: "Guitar & Backing Vocals", person: "Luis \"Golding\" Barrios", artist: null },
      { credit_type: "producer", role: "produced", person: null, artist: "Caramelos De Cianuro" },
      { credit_type: "mixing", role: "mixed", person: "Boris Milan", artist: null },
      { credit_type: "photography", role: "Photos", person: "Carlos Rondon", artist: null },
    ]);
    const member = await pool.query("SELECT person_id::int FROM public.artist_members");
    expect(member.rows[0]!.person_id).toBe(ids["golding"]);

    // Ningún claim se borró: los de créditos fusionados apuntan al que quedó y
    // los de nombre de la «persona» banda quedaron rechazados y sin destino.
    const claims = await pool.query<{ n: number; rejected: number; orphan: number }>(`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE status='rejected')::int AS rejected,
             count(*) FILTER (WHERE person_id IS NULL AND album_credit_id IS NULL)::int AS orphan FROM ingest.claims`);
    expect(claims.rows[0]).toEqual({ n: 13, rejected: 1, orphan: 1 });
    const unlinked = await pool.query("SELECT count(*)::int AS n FROM ingest.merge_audit m WHERE m.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ingest.merge_audit_claims x WHERE x.merge_audit_id=m.id)");
    expect(unlinked.rows[0]!.n).toBe(0);
    const absorbed = await pool.query("SELECT old_value->'person'->>'name' AS name FROM ingest.merge_audit WHERE field='absorbed_person'");
    expect(absorbed.rows).toEqual([{ name: "Caramelos de Cianuro" }]);

    const second = await applyPersonCorrections(plan, "decisión del propietario");
    expect(second.outcomes.map((item) => item.status)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(second.creditsMerged).toBe(0);
  });

  it("una «persona» que es un estudio pasa a la organización y deja su nombre como alias", async () => {
    const pool = getPool();
    const one = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ id: string }>(sql, params)).rows[0]!.id);
    const studio = await one("INSERT INTO public.organizations(name,organization_type) VALUES ('Killdom Imaging','other') RETURNING id");
    const killdom = await one("INSERT INTO public.persons(name) VALUES ('Killdom') RETURNING id");
    await pool.query(`INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,raw_hash,status)
      VALUES ($1,'person',$2,'name','"Killdom"',$3,'accepted')`, [ids["source"], killdom, hash("person:Killdom")]);
    const credit = await one("INSERT INTO public.album_credits(album_id,person_id,credit_type,role) VALUES ($1,$2,'photography','photos') RETURNING id", [ids["album"], killdom]);
    await pool.query(`INSERT INTO ingest.claims(source_id,entity_kind,album_credit_id,field,raw_value,raw_hash,status)
      VALUES ($1,'album_credit',$2,'credit_role','"photos"',$3,'accepted')`, [ids["source"], credit, hash("credit:killdom")]);

    const result = await applyPersonCorrections({ decidedAt: "2026-09-14", evidence: "prueba", corrections: [
      { op: "to_organization", person: { id: killdom, name: "Killdom" }, organization: { id: studio, name: "Killdom Imaging" }, keepNameAsAlias: true, why: "es el estudio" },
    ] }, "decisión del propietario");
    expect(result.outcomes[0]!.status).toBe("applied");
    const moved = await pool.query("SELECT organization_id::int, person_id FROM public.album_credits WHERE id=$1", [credit]);
    expect(moved.rows[0]).toEqual({ organization_id: studio, person_id: null });
    const alias = await pool.query("SELECT alias FROM ingest.organization_aliases WHERE organization_id=$1", [studio]);
    expect(alias.rows).toEqual([{ alias: "Killdom" }]);
    const gone = await pool.query("SELECT count(*)::int AS n FROM public.persons WHERE id=$1", [killdom]);
    expect(gone.rows[0]!.n).toBe(0);
  });

  it("aborta entero si la base no tiene lo que el plan espera", async () => {
    const wrong: PersonCorrectionPlan = { ...plan, corrections: [{ op: "rename", person: { id: ids["golding"]!, name: "Otro Nombre" }, to: "X", keepOldNameAsAlias: false, why: "prueba" }] };
    await expect(applyPersonCorrections(wrong, "prueba")).rejects.toThrow(/el plan espera/);
  });
});
