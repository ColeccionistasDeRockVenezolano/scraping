import { readdirSync, readFileSync } from "node:fs";
import { load } from "cheerio";
const seen=new Map();
for(const f of readdirSync("data/raw/rhv-blogspot")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rhv-blogspot/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const ENDYEAR=/^(.*?)\s*\(\s*((?:19|20)\d{2})\s*\)$/u;
const TRACK=/^(\d{1,3})\s*[.\-)]\s*(.+)$/u;
const fichas=[...seen.values()].filter(p=>ENDYEAR.test(clean(p.title?.$t)));
let tot=0, withTracks=0, withImg=0;
for(const p of fichas){
  const $=load(p.content?.$t??"");
  let tk=0; $("*").each((_,n)=>{const el=$(n); if(el.children().filter((__,c)=>c.type==="tag"&&c.tagName!=="br").length)return; for(const ch of (el.html()??"").split(/<br\s*\/?>/i)){const x=clean($(`<div>${ch}</div>`).text()); if(TRACK.test(x))tk++;}});
  const im=$("img[src]").length;
  tot+=tk; if(tk)withTracks++; if(im)withImg++;
}
console.log({fichas:fichas.length, conTracklist:withTracks, pistas:tot, conImagen:withImg});
const p=fichas[Number(process.argv[2]??0)];
console.log("\n=== TÍTULO:", clean(p.title?.$t));
const $=load(p.content?.$t??"");
console.log("IMÁGENES:", $("img[src]").map((_,n)=>($(n).attr("src")??"").split("/").slice(-2).join("/")).get().slice(0,6).join("\n          "));
const lines=[]; $("*").each((_,n)=>{const el=$(n); if(el.children().filter((__,c)=>c.type==="tag"&&c.tagName!=="br").length)return; for(const ch of (el.html()??"").split(/<br\s*\/?>/i)){const x=clean($(`<div>${ch}</div>`).text()); if(x)lines.push(x);}});
console.log("\nLÍNEAS (" + lines.length + "):"); lines.slice(0,28).forEach((l,i)=>console.log(`  ${i}: ${l.slice(0,110)}`));
