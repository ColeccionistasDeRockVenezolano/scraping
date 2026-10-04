// Veredictos de las pistas retenidas por la regla (Brian, 2026-10-04: «promover con ER»).
// Lee los ensayos ensayo2-*.json y escribe overrides-pistas.json + overrides-pistas.md.
import pg from "/home/brian/apps/Coleccionistas De Rock Venezolano/node_modules/pg/lib/index.js";
import fs from "fs";
const R = "reports/revision-ingesta-2026-10-04";
const env = Object.fromEntries(fs.readFileSync("/home/brian/apps/Coleccionistas De Rock Venezolano/.env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const c = new pg.Client({ connectionString: env.DATABASE_URL }); await c.connect();
const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const VERSION = /\((?:[^)]*\b(?:version|versi[oó]n|unplugged|acoustic|remix|remixed|mix|dance|radio|extended|end)\b[^)]*)\)/iu;
const nums = (s) => [...fold(s).matchAll(/\b(?:part|parte|no|n|vol)?\s*(\d+|ii|iii|iv|v|vi)\b/g)].map((m) => m[1]).join(",");
const MANUAL = { // Spiteri: Sincopa traduce los títulos del disco de 1973.
  "Spiteri::Spiteri::Muchacha": 636, "Spiteri::Spiteri::Verano Dspués De Invierno": 623,
  // Revisadas a mano (título traducido, compositor entre paréntesis, «Part II» = «II», título truncado en el core).
  "Ed Calle::Mamblue::Luz De Luna (Moonlight)": 51572, "Ed Calle::Mamblue::Cortadito con Bajo (Cortadito)": 51575,
  "Ed Calle::Mamblue::Isla Urbana (Urban Island)": 51571, "Ed Calle::Mamblue::Por De Lado (Sidewinder)": 51576,
  "Ed Calle::Mamblue::Otoño (Autumn)": 51577, "Alirio Díaz::Classic Portraits The Best Of Alirio Díaz::Fantasía": 46059,
  "Billo's Caracas Boys::Mosaicos A La Billo Del 13 al 18::Mosaico Nº 14": 144877, "Los Dementes::40 Años, 40 Exitos::Floro": 58546,
  "Karina::Karina::Dejaré": 37750, "Frank Quintero::Horas de Vuelo::Feeling": 79208,
  "Equilibrio Vital::Kazmor El Prisionero::Mi Canción (Part II)": 15645,
  "Frank Quintero::De Noche y Con Poca Luz::Sueño De Medianoche Part III/Dirgni": 42150,
  "Gillman::Más Vivo & En Vivo::Procesión De Satanás": 33036,
};
const MANUAL_DISMISS = new Set(["Billo's Caracas Boys::Mosaicos A La Billo Del 13 al 18::Uno Dos Tres"]);
const holds = [];
for (const s of "jazz classic latin_pop new_age traditional ethnic rock_pop".split(" ")) {
  for (const h of JSON.parse(fs.readFileSync(`${R}/ensayo2-${s}.json`)).holds) if (h.kind === "track" && h.rule !== "padre-sin-resolver") holds.push(h);
}
const out = {}; const lines = []; const count = {};
const put = (h, v, why) => { out[h.identityRaw] = v; count[v.rule] = (count[v.rule] ?? 0) + 1; lines.push(`- ${v.kind}${v.targetId ? ` → ${v.targetId}` : ""} · ${h.identityRaw} · ${why}`); };
for (const h of holds) {
  const title = h.identityRaw.split("::").at(-1);
  const ids = [...String(h.detail).matchAll(/(\d+)(?: «|,|$)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const cands = ids.length ? (await c.query("select id, title, track_number from public.tracks where id = any($1::bigint[]) order by id", [ids])).rows : [];
  if (MANUAL_DISMISS.has(h.identityRaw)) { put(h, { kind: "dismiss", rule: "revision-ingesta-parte-de-popurri" }, "parte del mosaico 15"); continue; }
  if (MANUAL[h.identityRaw]) { put(h, { kind: "same", targetId: MANUAL[h.identityRaw], rule: "revision-ingesta-a-mano" }, "revisada a mano"); continue; }
  if (h.rule === "titulo-igual-con-contradiccion") { put(h, { kind: "same", targetId: cands[0].id, rule: "revision-ingesta-mismo-titulo" }, `«${cands[0].title}»`); continue; }
  if (h.rule === "varios-con-el-mismo-titulo") {
    const num = (await c.query("select normalized_value #>> '{}' v from ingest.claims where entity_kind='track' and field='track_number' and identity_raw=$1 limit 1", [h.identityRaw])).rows[0]?.v;
    const pick = cands.find((t) => Number(t.track_number) === Number(num)) ?? cands[0];
    put(h, { kind: "same", targetId: pick.id, rule: "revision-ingesta-repetida-en-el-disco" }, `posición ${num ?? "?"} → «${pick.title}» #${pick.track_number}`); continue;
  }
  const ft = fold(title);
  if (ft.split(" ").length === 1 && ft.length <= 3) { put(h, { kind: "dismiss", rule: "revision-ingesta-titulo-truncado" }, `título truncado «${title}»`); continue; }
  const scored = cands.map((t) => {
    const fc = fold(t.title.replace(/\((?:[^)]*\/[^)]*|en vivo|live|demo|[^)]*cover|[^)]*remix)\)/giu, ""));
    const contains = fc.includes(ft) || ft.includes(fc);
    const shorter = fc.length < ft.length ? fc : ft;
    const strong = contains && (shorter.split(" ").length >= 2 || shorter.length / Math.max(fc.length, ft.length) >= 0.6);
    const medley = /[\/;,]|^(mosaico|guacomania|popurri|potpourri|suite)|\b(parte a|i\.|a\.)/iu.test(t.title) && !/[\/]/u.test(title) && fc !== ft && fc.includes(ft);
    return { t, fc, contains, strong, medley };
  });
  const medley = scored.filter((x) => x.medley);
  if (medley.length) { put(h, { kind: "dismiss", rule: "revision-ingesta-parte-de-popurri" }, `ya nombrada en «${medley[0].t.title}»`); continue; }
  if (VERSION.test(title) && !scored.some((x) => VERSION.test(x.t.title))) { put(h, { kind: "different", rule: "revision-ingesta-otra-version" }, `versión distinta de «${cands[0]?.title}»`); continue; }
  const strong = scored.filter((x) => x.strong);
  if (strong.length === 1 && nums(title) === nums(strong[0].fc)) { put(h, { kind: "same", targetId: strong[0].t.id, rule: "revision-ingesta-titulo-contenido" }, `«${strong[0].t.title}»`); continue; }
  if (strong.length === 1) { put(h, { kind: "different", rule: "revision-ingesta-otro-numero" }, `otro número que «${strong[0].t.title}»`); continue; }
  // Erratas: misma longitud aproximada y pocas diferencias de letras.
  const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const typo = scored.filter((x) => lev(ft, x.fc) / Math.max(ft.length, x.fc.length) <= 0.25 && nums(title) === nums(x.fc));
  if (typo.length === 1) { put(h, { kind: "same", targetId: typo[0].t.id, rule: "revision-ingesta-errata" }, `errata de «${typo[0].t.title}»`); continue; }
  put(h, { kind: "different", rule: "revision-ingesta-otra-pista" }, `sin pareja segura (${cands.map((x) => `«${x.title}»`).join(", ")})`);
}
fs.writeFileSync(`${R}/overrides-pistas.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${R}/overrides-pistas.md`, ["# Pistas retenidas: veredictos", "", JSON.stringify(count), "", ...lines, ""].join("\n"));
console.log(holds.length, count);
await c.end();
