import { readdirSync, readFileSync } from "node:fs";
import { load } from "cheerio";
const seen=new Map();
for(const f of readdirSync("data/raw/rockzuela")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rockzuela/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const posts=[...seen.values()];
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const SECTION=/^(?:rock nacional|musica|música|videos|video|eventos|evento)$/i;
const TRACK=/^(\d{1,3})\s*[.\-)]\s*(.+)$/u;
let musica=0, titled=0, withYear=0, noDash=0, bandMatch=0, bandDiff=0;
let tracks=0, postsTracks=0, imgs=0, postsImg=0;
const noDashS=[], diffS=[], parenS=new Map();
for(const p of posts){
  const cats=(p.category??[]).map(c=>clean(c.term)).filter(Boolean);
  if(!cats.some(c=>/^m[uú]sica$/i.test(c))) continue;
  musica++;
  const bands=cats.filter(c=>!SECTION.test(c));
  const t=clean(p.title?.$t);
  const m=/^(.+?)\s+[-–—]\s+(.+)$/u.exec(t);
  if(!m){ if(noDashS.length<12) noDashS.push(`${t} ⟨${bands.join(",")}⟩`); noDash++; }
  else{
    titled++;
    const tb=clean(m[1]), rest=clean(m[2]);
    if(bands.length===1){ if(tb.toLowerCase()===bands[0].toLowerCase()) bandMatch++; else { bandDiff++; if(diffS.length<12) diffS.push(`${tb}  ≠  ${bands[0]}`);} }
    const pm=/^(.*?)\s*\(([^()]*)\)\s*$/u.exec(rest);
    if(pm && /\b(19|20)\d{2}\b/.test(pm[2])) withYear++;
    if(pm) { const k=clean(pm[2]).replace(/\b(19|20)\d{2}\b/g,"AÑO"); parenS.set(k,(parenS.get(k)??0)+1); }
  }
  const $=load(p.content?.$t??"");
  let tk=0; $("*").each((_,n)=>{ const el=$(n); if(el.children().filter((__,c)=>c.type==="tag"&&c.tagName!=="br").length)return; for(const ch of (el.html()??"").split(/<br\s*\/?>/i)){ const x=clean($(`<div>${ch}</div>`).text()); if(TRACK.test(x))tk++; } });
  tracks+=tk; if(tk)postsTracks++;
  const im=$("img[src]").length; imgs+=im; if(im)postsImg++;
}
console.log({musica, titled, noDash, withYear, bandMatch, bandDiff, postsTracks, tracks, postsImg, imgs});
console.log("\nSIN GUION:"); noDashS.forEach(s=>console.log("   ",s.slice(0,90)));
console.log("\nBANDA TÍTULO ≠ ETIQUETA:"); diffS.forEach(s=>console.log("   ",s.slice(0,90)));
console.log("\nPARÉNTESIS:"); [...parenS].sort((a,b)=>b[1]-a[1]).slice(0,18).forEach(([k,v])=>console.log(`   ${String(v).padStart(4)}  «${k}»`));
