import { readdirSync, readFileSync } from "node:fs";
import { load } from "cheerio";
const seen=new Map();
for(const f of readdirSync("data/raw/rockzuela")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rockzuela/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const buckets={"<100":0,"100-199":0,"200+":0,"sin ancho":0};
const small=[];
for(const p of [...seen.values()]){
  const $=load(p.content?.$t??"");
  $("img[src]").each((_,n)=>{
    const st=$(n).attr("style")??""; const at=$(n).attr("width")??"";
    const w=Number.parseInt(at,10) || Number.parseInt(/(?:^|[;\s])width:\s*(\d+)/i.exec(st)?.[1]??"",10);
    if(!Number.isInteger(w)) buckets["sin ancho"]++;
    else if(w<100){buckets["<100"]++; if(small.length<12) small.push(`${w}px  ${($(n).attr("src")??"").split("/").pop()?.slice(0,50)}`);}
    else if(w<200) buckets["100-199"]++;
    else buckets["200+"]++;
  });
}
console.log(buckets);
console.log("\nPEQUEÑAS:"); small.forEach(s=>console.log("   ",s));
