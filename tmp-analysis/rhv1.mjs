import { readdirSync, readFileSync } from "node:fs";
import { load } from "cheerio";
const seen=new Map();
for(const f of readdirSync("data/raw/rhv-blogspot")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rhv-blogspot/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const posts=[...seen.values()];
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
// BANDA: Álbum (Año)  — la banda en mayúsculas antes de dos puntos
const COLON=/^([^:]{2,60}):\s*(.+)$/u;
const YEAR=/\((?:[^()]*?\b((?:19|20)\d{2})\b[^()]*?)\)\s*$/u;
let colon=0, colonUpper=0, withYear=0;
const yes=[], noYear=[], notUpper=[];
for(const p of posts){
  const t=clean(p.title?.$t); if(!t) continue;
  const m=COLON.exec(t); if(!m) continue;
  colon++;
  const band=clean(m[1]), rest=clean(m[2]);
  const upper = band===band.toUpperCase() && /\p{L}/u.test(band);
  if(!upper){ if(notUpper.length<12) notUpper.push(t); continue; }
  colonUpper++;
  const y=YEAR.exec(rest);
  if(y){ withYear++; if(yes.length<25) yes.push(`${band}  ▸  ${clean(rest.replace(YEAR,""))}  ▸  ${y[1]}`); }
  else if(noYear.length<12) noYear.push(t);
}
console.log({posts:posts.length, conDosPuntos:colon, bandaEnMayusculas:colonUpper, conAño:withYear});
console.log("\nFICHAS RECONOCIDAS:"); yes.forEach(s=>console.log("   ",s.slice(0,95)));
console.log("\nMAYÚSCULAS SIN AÑO:"); noYear.forEach(s=>console.log("   ",s.slice(0,90)));
console.log("\nDOS PUNTOS PERO NO MAYÚSCULAS:"); notUpper.forEach(s=>console.log("   ",s.slice(0,90)));
