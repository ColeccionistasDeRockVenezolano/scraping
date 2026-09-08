import { readdirSync, readFileSync } from "node:fs";
import { load } from "cheerio";
const seen=new Map();
for(const f of readdirSync("data/raw/rockzuela")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rockzuela/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const posts=[...seen.values()];
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const byFile=new Map(); const byUrl=new Map();
let styleOnly=0, withAttr=0;
for(const p of posts){
  const $=load(p.content?.$t??"");
  $("img[src]").each((_,n)=>{
    const src=$(n).attr("src")??"";
    const file=(src.split("/").pop()??"").split("?")[0];
    byFile.set(file,(byFile.get(file)??0)+1);
    byUrl.set(src,(byUrl.get(src)??0)+1);
    if($(n).attr("width")) withAttr++; else if($(n).attr("style")) styleOnly++;
  });
}
console.log({distinctFiles:byFile.size, distinctUrls:byUrl.size, withWidthAttr:withAttr, styleOnly});
console.log("\nARCHIVOS REPETIDOS (>2):");
[...byFile].filter(([,v])=>v>2).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log(`  ${String(v).padStart(4)}  ${k}`));
