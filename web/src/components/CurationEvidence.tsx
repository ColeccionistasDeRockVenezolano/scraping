// CRV · E8: evidencia de Curaduría en lenguaje humano; el JSON técnico sigue disponible.
import type { ReactNode } from "react";

const LABELS: Readonly<Record<string, string>> = {
  reviewId: "Revisión",
  conflictId: "Conflicto",
  kind: "Tipo",
  status: "Estado",
  priority: "Prioridad",
  createdAt: "Creado",
  entityKind: "Tipo de ficha",
  valueA: "Valor A",
  valueB: "Valor B",
  learnedMarkers: "Marcadores aprendidos",
  strongMarkers: "Marcadores fuertes",
  declaredTypes: "Tipos declarados",
  wordSource: "Origen de la regla",
  pair: "Par",
  span: "Tramo detectado",
};

const HIDDEN = new Set(["triggeredBy", "triggeredHistory", "history", "signatureLabel"]);

function display(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(" · ");
  return JSON.stringify(value);
}

export function CurationEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence).filter(([key]) => !HIDDEN.has(key));
  if (!entries.length) return null;
  return (
    <details className="cfind__evidence">
      <summary>Evidencia</summary>
      <dl className="evidence-list">
        {entries.map(([key, value]) => (
          <div className="evidence-list__row" key={key}>
            <dt>{LABELS[key] ?? key.replaceAll("_", " ")}</dt>
            <dd>{display(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="evidence-raw">
        <summary>JSON técnico</summary>
        <pre className="evidence-block">{JSON.stringify(evidence, null, 2)}</pre>
      </details>
    </details>
  );
}
