// CRV · Evidencia de un hallazgo en forma legible (PLAN_CURADURIA E8.8, M10).
//
// Antes se volcaba el jsonb del detector tal cual: para saber por qué un
// hallazgo existe había que leer JSON. Aquí cada clave conocida lleva su
// nombre en español (lib/curation.ts) y su valor se escribe como una frase.
// Una clave que ningún detector de hoy usa se humaniza sola, así que un
// detector nuevo no obliga a tocar la web.
//
// El JSON queda detrás de un desplegable: sirve para depurar, no para leer.
import { evidenceLabel, evidenceText } from "../lib/curation";

/** Lo que ya se muestra de otra forma en la tarjeta y no se repite aquí. */
export const HIDDEN_EVIDENCE = new Set([
  "span", "signatureLabel", "triggeredBy", "triggeredInScan", "triggeredHistory", "history", "pair",
]);

export function FindingEvidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence).filter(([key]) => !HIDDEN_EVIDENCE.has(key));
  if (!entries.length) return null;
  return (
    <>
      <dl className="cevidence">
        {entries.map(([key, value]) => (
          <div key={key} className="cevidence__row">
            <dt>{evidenceLabel(key)}</dt>
            <dd>{evidenceText(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="cevidence__raw">
        <summary>Ver el dato en crudo</summary>
        <pre className="evidence-block">{JSON.stringify(Object.fromEntries(entries), null, 2)}</pre>
      </details>
    </>
  );
}
