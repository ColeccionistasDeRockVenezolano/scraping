import { readdirSync, readFileSync } from "node:fs";
const seen=new Map();
for(const f of readdirSync("data/raw/rockzuela")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rockzuela/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const SECTION=/^(?:rock nacional|m[uú]sica|videos?|eventos?)$/iu;
const TITLE=/^(.+?)\s+[-–—]\s+(.+)$/u;
const HEAD=/^(.{1,120}?)\s*\(([^()]{1,60})\)\s*$/u; const Y=/\b(?:19|20)\d{2}\b/u;
let musica=0, oneBand=0, titled=0, head=0; const lost=[];
for(const p of [...seen.values()]){
  const cats=(p.category??[]).map(c=>clean(c.term)).filter(Boolean);
  if(!cats.some(c=>/^m[uú]sica$/iu.test(c))) continue;
  musica++;
  const bands=cats.filter(c=>!SECTION.test(c));
  if(bands.length!==1){ if(lost.length<10) lost.push(`[multi ${bands.length}] ${clean(p.title?.$t).slice(0,70)}`); continue; }
  oneBand++;
  const t=TITLE.exec(clean(p.title?.$t)); if(!t){ if(lost.length<20) lost.push(`[sin guion] ${clean(p.title?.$t).slice(0,70)}`); continue; }
  titled++;
  const h=HEAD.exec(clean(t[2])); 
  if(h && Y.test(h[2])) head++;
  else if(lost.length<32) lost.push(`[sin año] ${clean(p.title?.$t).slice(0,80)}`);
}
console.log({musica, oneBand, titled, conAño:head});
console.log("\nPERDIDOS:"); lost.forEach(s=>console.log("   ",s));
