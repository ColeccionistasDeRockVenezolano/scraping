import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterFor, adapterRegistrationFor, functionalAdapterSlugs, registeredAdapterSlugs } from "../../src/adapters/registry.js";
import { normalizeRecord } from "../../src/normalization/claims.js";
import type { StoredPage } from "../../src/adapters/contracts.js";
import { readLinksXlsxRows } from "../../src/ingest/sources.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters");
const slugs = [
  "descargas-metal-venezolano", "rockzuela", "rock-de-vzla", "hippito-y-sus-chatarritas", "rhv-blogspot",
  "rock-hecho-en-venezuela", "sincopa", "coleccionistas-de-rock-venezolano", "el-punk-en-venezuela",
] as const;

// Sincopa tiene DOS tipos de ficha con estructuras distintas: la de artista
// trae formación y miembros; la de disco trae pistas y créditos. Una sola no
// cubre el contrato, y el fixture sintético anterior no se parecía a ninguna.
const SINCOPA_FIXTURES = [
  { file: "sincopa.html", url: "https://fixture.invalid/rock_pop/artist_rock/los_kings.htm" },
  { file: "sincopa-album.html", url: "https://fixture.invalid/rock_pop/cdinfo_rock/fusion4_tarde.htm" },
];

async function parsed(slug: typeof slugs[number]) {
  const adapter = adapterFor({ slug, siteType: slug === "sincopa" ? "database" : slug.includes("wordpress") ? "wordpress" : "blogspot" });
  if (!adapter) throw new Error(`adapter faltante: ${slug}`);
  const inputs = slug === "sincopa"
    ? SINCOPA_FIXTURES
    : [{ file: `${slug}.json`, url: `https://fixture.invalid/${slug}` }];
  const perPage = await Promise.all(inputs.map(async (input) => {
    const body = await readFile(path.join(fixtureDir, input.file), "utf8");
    const page: StoredPage = {
      url: input.url,
      kind: input.file.endsWith(".json") ? "json" : "html",
      rawPageId: 1,
      body,
    };
    return adapter.extractSnapshot?.(page) ?? [];
  }));
  return perPage.flat().flatMap(normalizeRecord);
}

describe("adapters funcionales de las fuentes autorizadas", () => {
  it.each(slugs)("normaliza fixture local de %s con evidencia y sin inferir del título", async (slug) => {
    const claims = await parsed(slug);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.evidence.url.startsWith("https://fixture.invalid/"))).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "artist" && claim.field === "name")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "album" && claim.field === "release_year")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "track" && claim.field === "track_number")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "album_credit" && claim.field === "credit_scope" && claim.rawValue === "album")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "track_credit" && claim.field === "credit_scope" && claim.rawValue === "track")).toBe(true);
  });

  it("Sincopa convierte membresía explícita, rol y periodo; créditos no son membresía", async () => {
    const claims = await parsed("sincopa");
    // Ficha de artista: rol y período leídos de la sección "Group Members".
    expect(claims.some((claim) => claim.entityKind === "artist_membership" && claim.field === "role" && claim.rawValue === "Guitar")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "artist_membership" && claim.field === "from_year" && claim.rawValue === "1970")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "artist_membership" && claim.field === "to_year" && claim.rawValue === "1976")).toBe(true);
    // Acentos tras decodificar windows-1252, sobre la página real.
    expect(claims.some((claim) => claim.entityKind === "person" && claim.rawValue === "Efraín Rodríguez")).toBe(true);

    // Regla dura: un músico acreditado en un disco NO es miembro del grupo.
    // Leo Blanco toca piano en pistas concretas de la ficha de disco.
    expect(claims.some((claim) => claim.entityKind === "track_credit" && claim.field === "credited_name" && claim.rawValue === "Leo Blanco")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "artist_membership" && claim.field === "person_name" && claim.rawValue === "Leo Blanco")).toBe(false);
  });

  it("lee la lista de pistas completa, que vive entera en una celda", async () => {
    const claims = await parsed("sincopa");
    // Toda la discografía de la ficha de disco está en un solo <td>, una
    // línea por <br>: leerla como texto plano dejaba solo la primera pista.
    const titles = claims.filter((claim) => claim.entityKind === "track" && claim.field === "title").map((claim) => claim.rawValue);
    expect(titles).toHaveLength(11);
    expect(titles).toContain("Despertar");
    expect(titles).toContain("A Un Paisano");

    // "01- Despertar (Daniel Somaroo) 3:22": duración y compositor son cosas
    // distintas y ninguna contamina a la otra.
    expect(claims.some((claim) => claim.entityKind === "track" && claim.field === "duration_seconds" && claim.rawValue === "202")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "track_credit" && claim.field === "credited_name" && claim.rawValue === "Daniel Somaroo")).toBe(true);
    expect(claims.some((claim) => claim.entityKind === "track_credit" && claim.field === "credited_name" && String(claim.rawValue).includes(":"))).toBe(false);

    // La ficha de disco afirma su artista: sin esa entidad el álbum no puede
    // existir en el core.
    expect(claims.some((claim) => claim.entityKind === "artist" && claim.field === "name" && claim.rawValue === "Fusión IV")).toBe(true);
  });

  it("Rock Hecho En Venezuela usa solo la raíz y los dos endpoints WP finitos", async () => {
    const adapter = adapterFor({ slug: "rock-hecho-en-venezuela", siteType: "website" });
    expect(adapter).toBeDefined();
    const pages: Array<{ url: string; kind: string }> = [];
    for await (const page of adapter!.listPages("https://rockhechovenezuela.com/")) pages.push(page);
    expect(pages).toEqual([
      { url: "https://rockhechovenezuela.com/", kind: "html" },
      { url: "https://rockhechovenezuela.com/wp-json/wp/v2/posts?per_page=100&page=1", kind: "json" },
      { url: "https://rockhechovenezuela.com/wp-json/wp/v2/pages?per_page=100&page=1", kind: "json" },
    ]);
    const claims = await parsed("rock-hecho-en-venezuela");
    expect(claims.some((claim) => claim.entityKind === "person" && claim.field === "name" && claim.rawValue === "Persona Leyenda")).toBe(true);
  });

  it("registra las once fuentes y expresa las capacidades limitadas sin adapter HTTP", () => {
    expect(registeredAdapterSlugs()).toHaveLength(11);
    expect(functionalAdapterSlugs()).toHaveLength(9);

    const deska = adapterRegistrationFor({ slug: "rock-y-pop-venezuela-merch-store" });
    expect(deska).toMatchObject({ status: "limited", mode: "disabled", automation: "disabled", acceptsManualEvidence: false });
    expect(adapterFor({ slug: "rock-y-pop-venezuela-merch-store", siteType: "website" })).toBeUndefined();

    const hemeroteka = adapterRegistrationFor({ slug: "hemeroteka" });
    expect(hemeroteka).toMatchObject({ status: "limited", mode: "manual", automation: "disabled", acceptsManualEvidence: true });
    expect(adapterFor({ slug: "hemeroteka", siteType: "instagram" })).toBeUndefined();
    if (!hemeroteka || hemeroteka.status !== "limited" || hemeroteka.mode !== "manual") throw new Error("registro manual faltante");
    expect(hemeroteka.isAllowedEvidenceUrl("https://www.instagram.com/hemeroteka/", "https://www.instagram.com/hemeroteka/")).toBe(true);
    expect(hemeroteka.isAllowedEvidenceUrl("https://www.instagram.com/p/AbC_123/", "https://www.instagram.com/hemeroteka/")).toBe(true);
    expect(hemeroteka.isAllowedEvidenceUrl("https://www.instagram.com/otro-perfil/", "https://www.instagram.com/hemeroteka/")).toBe(false);
    expect(hemeroteka.isAllowedEvidenceUrl("https://example.com/p/AbC_123/", "https://www.instagram.com/hemeroteka/")).toBe(false);
  });

  it("el registro cerrado coincide exactamente con las once filas del XLSX", async () => {
    const xlsxSlugs = (await readLinksXlsxRows()).map((row) => row.slug).sort();
    expect(registeredAdapterSlugs().sort()).toEqual(xlsxSlugs);
  });

  it.each(slugs)("normalizar dos veces %s produce hashes equivalentes, sin claims equivalentes extra", async (slug) => {
    const once = await parsed(slug); const twice = await parsed(slug);
    expect(twice.map((claim) => claim.rawHash)).toEqual(once.map((claim) => claim.rawHash));
    expect(new Set(once.map((claim) => claim.rawHash)).size).toBe(once.length);
  });
});
