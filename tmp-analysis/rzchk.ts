import { readdirSync, readFileSync } from "node:fs";
import { adapterFor } from "../src/adapters/registry.js";
import type { StoredPage } from "../src/adapters/contracts.js";
const a = adapterFor({ slug: "rockzuela", siteType: "blogspot" })!;
const recs = [];
for (const f of readdirSync("data/raw/rockzuela")) { if (!f.endsWith(".json") || f.includes(".headers")) continue;
  recs.push(...(a.extractSnapshot?.({ url: "https://x/f", kind: "json", rawPageId: 1, body: readFileSync(`data/raw/rockzuela/${f}`, "utf8") } as StoredPage) ?? [])); }
const albums = recs.filter(r => r.entityKind === "album");
const v = (r: typeof albums[number], f: string) => r.fields.find(x => x.field === f)?.value as string | undefined;
const noYear = albums.filter(r => !v(r, "release_year"));
console.log("álbumes:", albums.length, "| sin año:", noYear.length, "| homónimos:", albums.filter(r => v(r, "title") === v(r, "artist_name")).length);
console.log("\nSIN AÑO (12):"); noYear.slice(0, 12).forEach(r => console.log("   ", r.identity.slice(0, 70)));
console.log("\nHOMÓNIMOS (8):"); albums.filter(r => v(r, "title") === v(r, "artist_name")).slice(0, 8).forEach(r => console.log("   ", r.identity.slice(0, 50), "→", v(r, "release_year")));
console.log("\nTÍTULOS MÁS LARGOS:"); [...albums].sort((x, y) => (v(y, "title") ?? "").length - (v(x, "title") ?? "").length).slice(0, 5).forEach(r => console.log("   ", v(r, "title")?.slice(0, 95)));
console.log("\nALIAS (10):"); recs.filter(r => r.entityKind === "artist").flatMap(r => r.fields.filter(x => x.field === "alias").map(x => `${r.identity}  ←  ${x.value}`)).slice(0, 10).forEach(s => console.log("   ", s));
