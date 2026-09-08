import { readdirSync, readFileSync } from "node:fs";
const seen=new Map();
for(const f of readdirSync("data/raw/rockzuela")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rockzuela/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const musica=[...seen.values()].filter(p=>(p.category??[]).some(c=>/^m[uú]sica$/i.test(clean(c.term))));
const n=Number(process.argv[2]??0), k=Number(process.argv[3]??2);
for(const p of musica.slice(n,n+k)){
  console.log("=".repeat(70));
  console.log("TÍTULO:", clean(p.title?.$t));
  console.log("ETIQ  :", (p.category??[]).map(c=>clean(c.term)).join(" | "));
  console.log((p.content?.$t??"").slice(0,1800));
}
