// CRV · Informes de la importación externa (PLAN_GENEROS etapa 4,
// entregable «informe de precisión sobre una muestra revisada»).
//
// El mismo informe sirve para la muestra (mide el acuerdo con lo que CRV ya
// confirmó) y para una importación (mide qué aportó y cuánto ruido trajo).
import type { ExternalSourceRow } from "./store.js";
import type { ImportReport } from "./import.js";

const NOISE_LABELS: Readonly<Record<string, string>> = {
  unmapped: "términos sin equivalencia",
  too_generic: "etiquetas demasiado generales",
  not_a_genre: "valores que no son género",
  ignored_kind: "etiquetas de clase no aceptada",
  below_min_count: "etiquetas sin votos suficientes",
  contradicts: "valores que CRV ya rechazó",
};

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)} %`;
}

export function renderImportMarkdown(report: ImportReport, source?: ExternalSourceRow): string {
  const lines: string[] = [];
  const title = report.scope === "sample" ? "Muestra de precisión" : "Importación";
  lines.push(`# ${title} · géneros de ${report.sourceSlug} (${report.level})`, "");
  lines.push(`- Modo: **${report.mode}** · alcance: \`${report.scope}\` · run ${report.runId}`);
  if (source) {
    lines.push(`- Fuente: ${source.name} · licencia ${source.license} · estado \`${source.status}\``
      + `${source.importEnabled ? " · importación habilitada" : " · importación apagada"}`
      + `${source.bulkEnabled ? " · volumen habilitado" : ""}`);
    lines.push(`- Atribución: ${source.attribution}`);
  }
  lines.push(`- Fichas miradas: **${report.candidates}** · peticiones ${report.network.requests} · caché ${report.network.cacheHits}`);
  lines.push("");

  lines.push("## Identidad", "");
  lines.push("| Resultado | Fichas |", "|---|---:|");
  lines.push(`| identificadas | ${report.identities.matched} |`);
  lines.push(`| dudosas (a revisión) | ${report.identities.ambiguous} |`);
  lines.push(`| sin candidato | ${report.identities.none} |`);
  lines.push("");

  lines.push("## Acuerdo con CRV", "");
  lines.push("| Comparación | Fichas |", "|---|---:|");
  lines.push(`| coincide con el principal confirmado | ${report.agreement.agree} |`);
  lines.push(`| coincide en la familia | ${report.agreement.family_agree} |`);
  lines.push(`| discrepa | ${report.agreement.disagree} |`);
  lines.push(`| sin nada confirmado que comparar | ${report.agreement.no_reference} |`);
  lines.push("");
  lines.push(`**Precisión sobre lo comparable: ${percent(report.precision)}**`
    + (source ? ` · umbral de CRV: ${percent(source.precisionThreshold)}` : ""));
  if (source && report.precision !== null) {
    lines.push(report.precision >= source.precisionThreshold
      ? "> La muestra alcanza el umbral: puede habilitarse la carga masiva (`crv genres external bulk-enable`)."
      : "> La muestra NO alcanza el umbral: la carga masiva sigue cerrada.");
  }
  lines.push("");

  lines.push("## Aporte y ruido", "");
  lines.push(`- Sugerencias nuevas: **${report.suggestions.inserted}** (${report.suggestions.skipped} descartadas porque la ficha ya tenía ese género)`);
  lines.push(`- Fichas sin clasificar que reciben al menos una propuesta: **${report.coverageAdded}**`);
  const noise = Object.entries(report.noise).sort(([, a], [, b]) => b - a);
  if (noise.length) {
    lines.push("", "| Ruido | Valores |", "|---|---:|");
    for (const [kind, count] of noise) lines.push(`| ${NOISE_LABELS[kind] ?? kind} | ${count} |`);
  }
  if (report.cases.opened) {
    lines.push("", `Casos abiertos en la cola: **${report.cases.opened}**`, "", "| Caso | Abiertos |", "|---|---:|");
    for (const [kind, count] of Object.entries(report.cases.byKind).sort(([, a], [, b]) => b - a)) {
      lines.push(`| ${kind} | ${count} |`);
    }
  }
  lines.push("");

  const shown = report.entities.filter((entity) => entity.values.length || entity.error || entity.identity.status !== "matched").slice(0, 40);
  if (shown.length) {
    lines.push("## Detalle (primeras fichas)", "", "| Ficha | Identidad | Valores externos | Resultado |", "|---|---|---|---|");
    for (const entity of shown) {
      const values = entity.values.map((value) => `${value.raw} → ${value.status}${value.genreSlug ? ` (${value.genreSlug})` : ""}`).join("<br>") || "—";
      const result = entity.error ? `error: ${entity.error}`
        : entity.suggested.length ? `sugiere ${entity.suggested.join(", ")}`
          : entity.agreementDetail || "sin cambios";
      lines.push(`| ${entity.kind} ${entity.entityId} · ${entity.title} | ${entity.identity.status} (${entity.identity.score}) | ${values} | ${result} |`);
    }
    if (report.entities.length > shown.length) lines.push("", `… y ${report.entities.length - shown.length} fichas más en el JSON.`);
    lines.push("");
  }
  if (report.errors.length) {
    lines.push("## Errores", "");
    for (const error of report.errors.slice(0, 20)) lines.push(`- ficha ${error.entityId}: ${error.message}`);
    lines.push("");
  }
  if (report.mode === "dry-run") lines.push("_Dry-run: nada se escribió; repite con `--confirm`._", "");
  return `${lines.join("\n")}\n`;
}
