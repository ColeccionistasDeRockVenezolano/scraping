import { readdirSync, readFileSync } from "node:fs";
const seen=new Map();
for(const f of readdirSync("data/raw/rhv-blogspot")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rhv-blogspot/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const ENDYEAR=/^(.*?)\s*\(\s*((?:19|20)\d{2})\s*\)$/u;
let endsYear=0, withColon=0;
const withC=[], withoutC=[];
for(const p of [...seen.values()]){
  const t=clean(p.title?.$t); if(!t) continue;
  const m=ENDYEAR.exec(t); if(!m) continue;
  endsYear++;
  const head=clean(m[1]);
  const c=/^([^:]{2,60}):\s*(.+)$/u.exec(head);
  if(c){ withColon++; if(withC.length<30) withC.push(`${clean(c[1])}  ▸  ${clean(c[2])}  ▸  ${m[2]}`); }
  else if(withoutC.length<15) withoutC.push(t);
}
console.log({terminanEnAño:endsYear, conDosPuntos:withColon});
console.log("\nCON DOS PUNTOS:"); withC.forEach(s=>console.log("   ",s.slice(0,100)));
console.log("\nSIN DOS PUNTOS:"); withoutC.forEach(s=>console.log("   ",s.slice(0,90)));
