// Registro cerrado de adapters. Los parsers específicos permanecen mínimos
// hasta caracterizar cada fuente sobre snapshots; no se inventa scraping web.
import type { AdapterRegistration, SourceAdapter } from "./contracts.js";
import { DescargasMetalVenezolanoAdapter, RhvBlogspotAdapter, RockzuelaAdapter } from "./blogger.js";
import { RockDeVzlaAdapter } from "./rock-de-vzla.js";
import { HippitoYSusChatarritasAdapter } from "./hippito.js";
import { SincopaAdapter } from "./sincopa.js";
import { ColeccionistasWordpressAdapter, ElPunkEnVenezuelaAdapter, RockHechoEnVenezuelaAdapter } from "./wordpress.js";

function automatic(adapter: SourceAdapter, reason: string): AdapterRegistration {
  return { slug: adapter.slug, status: "functional", mode: "automatic", automation: "enabled", adapter, reason };
}

function isAllowedHemerotekaEvidenceUrl(value: string, rootUrl: string): boolean {
  try {
    const candidate = new URL(value);
    const root = new URL(rootUrl);
    if (candidate.origin !== root.origin || candidate.username || candidate.password) return false;
    const path = candidate.pathname.replace(/\/+$/, "/");
    const rootPath = root.pathname.replace(/\/+$/, "/");
    // Los permalinks no codifican el propietario; al aceptarlos el operador
    // afirma manualmente que pertenecen al perfil raíz. Nunca se consultan.
    return path === rootPath || /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/$/.test(path);
  } catch {
    return false;
  }
}

// Registro cerrado: exactamente los once slugs derivados del XLSX. Las
// fuentes limitadas están presentes, pero deliberadamente no implementan
// SourceAdapter ni exponen listPages/extract.
const registrations = new Map<string, AdapterRegistration>([
  ["descargas-metal-venezolano", automatic(new DescargasMetalVenezolanoAdapter(), "Feed público Blogger; HTTP sin navegador.")],
  ["rockzuela", automatic(new RockzuelaAdapter(), "Feed público Blogger; HTTP sin navegador.")],
  ["rock-de-vzla", automatic(new RockDeVzlaAdapter(), "Feed público Blogger; HTTP sin navegador.")],
  ["hippito-y-sus-chatarritas", automatic(new HippitoYSusChatarritasAdapter(), "Feed público Blogger; HTTP sin navegador.")],
  ["rhv-blogspot", automatic(new RhvBlogspotAdapter(), "Feed público Blogger; HTTP sin navegador.")],
  ["rock-hecho-en-venezuela", automatic(new RockHechoEnVenezuelaAdapter(), "HTML y WordPress REST públicos, finitos y accesibles sin navegador.")],
  ["sincopa", automatic(new SincopaAdapter(), "HTML público estático, con frontera finita por rutas conocidas.")],
  ["coleccionistas-de-rock-venezolano", automatic(new ColeccionistasWordpressAdapter(), "WordPress.com REST público.")],
  ["el-punk-en-venezuela", automatic(new ElPunkEnVenezuelaAdapter(), "WordPress REST público sobre pages.")],
  ["rock-y-pop-venezuela-merch-store", {
    slug: "rock-y-pop-venezuela-merch-store",
    status: "limited",
    mode: "disabled",
    automation: "disabled",
    acceptsManualEvidence: false,
    reason: "Deska publica robots.txt con Disallow: /; no hay superficie pública autorizada para automatizar.",
  }],
  ["hemeroteka", {
    slug: "hemeroteka",
    status: "limited",
    mode: "manual",
    automation: "disabled",
    acceptsManualEvidence: true,
    reason: "Instagram no ofrece al proyecto una superficie anónima estable/autorizada; sin login, navegador ni evasión.",
    isAllowedEvidenceUrl: isAllowedHemerotekaEvidenceUrl,
  }],
]);

/** Solo adaptadores HTTP sin navegador. Playwright no se importa aquí. */
export function adapterFor(source: { slug: string; siteType: string }): SourceAdapter | undefined {
  const registration = registrations.get(source.slug);
  return registration?.status === "functional" ? registration.adapter : undefined;
}

export function adapterRegistrationFor(source: { slug: string }): AdapterRegistration | undefined {
  return registrations.get(source.slug);
}

export function registeredAdapterSlugs(): string[] {
  return [...registrations.keys()];
}

export function functionalAdapterSlugs(): string[] {
  return [...registrations.values()].filter((item) => item.status === "functional").map((item) => item.slug);
}
