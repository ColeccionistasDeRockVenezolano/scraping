import { readdirSync, readFileSync } from "node:fs";
const dir = `data/raw/${process.argv[2]}`;
const seen = new Map();
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json") || f.includes(".headers")) continue;
  let j; try { j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); } catch { continue; }
  for (const e of j.feed?.entry ?? []) { const u = e.link?.find(l=>l.rel==="alternate")?.href ?? Math.random(); if (!seen.has(u)) seen.set(u, e); }
}
const posts = [...seen.values()];
const clean = s => (s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const labelCount = new Map(); let noLabel=0, emptyTitle=0;
const perPost = [];
for (const p of posts) {
  const cats = (p.category ?? []).map(c => clean(c.term)).filter(Boolean);
  if (!cats.length) noLabel++;
  perPost.push(cats.length);
  for (const c of cats) labelCount.set(c, (labelCount.get(c) ?? 0) + 1);
  if (!clean(p.title?.$t)) emptyTitle++;
}
console.log({ posts: posts.length, emptyTitle, noLabel,
  labelsPerPost: (perPost.reduce((a,b)=>a+b,0)/posts.length).toFixed(2), distinctLabels: labelCount.size });
console.log("\nTOP 25 ETIQUETAS:");
[...labelCount].sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v])=>console.log(`  ${String(v).padStart(4)}  ${k}`));
console.log("\n20 TÍTULOS:");
posts.slice(0,20).forEach(p=>console.log("   ", clean(p.title?.$t).slice(0,95), "  ⟨", (p.category??[]).map(c=>clean(c.term)).join(", ").slice(0,60), "⟩"));
