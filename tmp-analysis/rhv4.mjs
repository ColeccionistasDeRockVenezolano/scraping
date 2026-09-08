import { readdirSync, readFileSync } from "node:fs";
const seen=new Map();
for(const f of readdirSync("data/raw/rhv-blogspot")){ if(!f.endsWith(".json")||f.includes(".headers"))continue; let j; try{j=JSON.parse(readFileSync(`data/raw/rhv-blogspot/${f}`,"utf8"));}catch{continue;} for(const e of j.feed?.entry??[]){const u=e.link?.find(l=>l.rel==="alternate")?.href??Math.random(); if(!seen.has(u))seen.set(u,e);} }
const clean=s=>(s??"").replace(/ /g," ").replace(/\s+/g," ").trim();
const titles=[...seen.values()].map(p=>clean(p.title?.$t)).filter(Boolean);
const anyYear=titles.filter(t=>/\b(19|20)\d{2}\b/.test(t));
console.log({titulos:titles.length, conAñoEnCualquierSitio:anyYear.length});
const endYear=titles.filter(t=>/\(\s*(19|20)\d{2}\s*\)$/.test(t));
const dash=titles.filter(t=>/^[^:]{2,60}\s+[-–]\s+.+\(\s*(19|20)\d{2}\s*\)$/u.test(t));
console.log({terminanEnAño:endYear.length, formaGuion:dash.length});
console.log("\nAÑO EN EL TÍTULO PERO NO AL FINAL:");
anyYear.filter(t=>!/\(\s*(19|20)\d{2}\s*\)$/.test(t)).slice(0,18).forEach(t=>console.log("   ",t.slice(0,95)));
