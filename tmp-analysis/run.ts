import { readdirSync, readFileSync } from "node:fs";
import { adapterFor } from "../src/adapters/registry.js";
import { normalizeRecord } from "../src/normalization/claims.js";
import type { StoredPage } from "../src/adapters/contracts.js";
const slug = process.argv[2]!;
const adapter = adapterFor({ slug, siteType: "blogspot" })!;
const records = [];
for (const f of readdirSync(`data/raw/${slug}`)) {
  if (!f.endsWith(".json") || f.includes(".headers")) continue;
  records.push(...(adapter.extractSnapshot?.({ url: `https://${slug}/feed`, kind: "json", rawPageId: 1, body: readFileSync(`data/raw/${slug}/${f}`, "utf8") } as StoredPage) ?? []));
}
const claims = records.flatMap(normalizeRecord);
const uniq = (k: string) => new Set(records.filter(r => r.entityKind === k).map(r => r.identity)).size;
const f = (k: string, field: string) => claims.filter(c => c.entityKind === k && c.field === field).length;
console.log({ records: records.length, claims: claims.length, artists: uniq("artist"), albums: uniq("album"),
  tracks: records.filter(r => r.entityKind === "track").length,
  covers: f("album", "cover_url"), types: f("album", "album_type"), aliases: f("artist", "alias"),
  web: f("artist", "web_url"), sinEvidenciaHttp: claims.filter(c => !/^https?:/.test(c.evidence.url)).length });
console.log("\nmuestra:");
for (const r of records.filter(r => r.entityKind === "album").slice(0, 8)) console.log("  ", r.identity.slice(0, 52).padEnd(52), r.fields.filter(x => x.field !== "source_url").map(x => `${x.field}=${String(x.value).slice(0, 30)}`).join(" · "));
