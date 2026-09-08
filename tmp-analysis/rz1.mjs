import { readdirSync, readFileSync } from "node:fs";
const seen = new Map();
for (const f of readdirSync("data/raw/rockzuela")) {
  if (!f.endsWith(".json") || f.includes(".headers")) continue;
  let j; try { j = JSON.parse(readFileSync(`data/raw/rockzuela/${f}`,"utf8")); } catch { continue; }
  for (const e of j.feed?.entry ?? []) { const u=e.link?.find(l=>l.rel==="alternate")?.href ?? Math.random(); if(!seen.has(u)) seen.set(u,e); }
}
const posts=[...seen.values()];
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const SECTION=/^(?:rock nacional|musica|música|videos|video|eventos|evento|internacional|noticias|entrevistas?|resenas?|reseñas?|conciertos?|fotos|prensa|especiales?|radio|podcast)$/i;
// combos de sección
const combo=new Map(); let bandLabels=[];
for(const p of posts){
  const cats=(p.category??[]).map(c=>clean(c.term)).filter(Boolean);
  const secs=cats.filter(c=>SECTION.test(c)).map(s=>s.toLowerCase()).sort();
  const bands=cats.filter(c=>!SECTION.test(c));
  const key=secs.join("+")||"(ninguna)";
  combo.set(key,(combo.get(key)??0)+1);
  bandLabels.push(bands.length);
}
console.log("COMBOS DE SECCIÓN:");
[...combo].sort((a,b)=>b[1]-a[1]).slice(0,14).forEach(([k,v])=>console.log(`  ${String(v).padStart(4)}  ${k}`));
const dist=new Map(); bandLabels.forEach(n=>dist.set(n,(dist.get(n)??0)+1));
console.log("\nETIQUETAS DE BANDA POR POST:", [...dist].sort((a,b)=>a[0]-b[0]));
// labels que no son sección y aparecen mucho -> ¿alguna es sección disfrazada?
const lc=new Map();
for(const p of posts) for(const c of (p.category??[]).map(c=>clean(c.term)).filter(Boolean)) if(!SECTION.test(c)) lc.set(c,(lc.get(c)??0)+1);
console.log("\nTOP NO-SECCIÓN:", [...lc].sort((a,b)=>b[1]-a[1]).slice(0,12));
