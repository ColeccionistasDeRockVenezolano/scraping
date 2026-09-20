// CRV · Resolver un conflicto sin revisión viva desde su tarjeta
// (PLAN_CURADURIA E7.1): «Elegir A» / «Elegir B» / «Otro valor», con la
// evidencia de cada fuente (fuente, confianza, fecha, URL).
import { useState } from "react";
import { Modal } from "./Modal";
import { ApiError, curationApi } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { trustLevelLabel } from "../lib/labels";
import { relativeTime } from "../lib/curation";
import type { ConflictResolveResult, CurationConflictSource, CurationFinding } from "../lib/types";

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function SourceCard({ label, value, source }: { label: string; value: unknown; source: CurationConflictSource | undefined }) {
  return (
    <div className="compare-side">
      <h4>{label}</h4>
      <pre>{displayValue(value)}</pre>
      {source ? (
        <p className="cfind__note">
          {source.name} · <span title="Confianza declarada de la fuente">{trustLevelLabel(source.trustLevel)}</span> · {relativeTime(source.at)}
          {source.url ? <> · <a href={source.url} target="_blank" rel="noreferrer">Fuente</a></> : null}
        </p>
      ) : null}
    </div>
  );
}

export function ConflictResolveDialog({ finding, onClose, onDone }: {
  finding: CurationFinding; onClose: () => void; onDone: (result: ConflictResolveResult) => void;
}) {
  const { notify } = useToast();
  const [note, setNote] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const valueA = finding.evidence["valueA"];
  const valueB = finding.evidence["valueB"];
  const sourceA = finding.evidence["sourceA"] as CurationConflictSource | undefined;
  const sourceB = finding.evidence["sourceB"] as CurationConflictSource | undefined;

  async function resolve(choice: "a" | "b" | "both" | "dismiss" | undefined, customValue?: string) {
    if (!note.trim()) { notify("error", "El motivo es obligatorio."); return; }
    setBusy(true);
    try {
      const result = await curationApi.resolveConflict(finding.id, note, choice, customValue);
      notify("success", result.detail || "Conflicto resuelto.");
      onDone(result);
      onClose();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo resolver el conflicto.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={finding.title} onClose={onClose} wide>
      <div className="compare-grid section">
        <SourceCard label="Valor A" value={valueA} source={sourceA} />
        <SourceCard label="Valor B" value={valueB} source={sourceB} />
      </div>
      <div className="section">
        <div className="field span-2">
          <label htmlFor={`conflict-note-${finding.id}`}>Motivo *</label>
          <textarea id={`conflict-note-${finding.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Por qué se decide así" />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void resolve("a")}>Elegir A</button>
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void resolve("b")}>Elegir B</button>
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void resolve("both")}>Conservar ambos</button>
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void resolve("dismiss")}>Descartar</button>
        </div>
        <div className="field span-2" style={{ marginTop: 10 }}>
          <label htmlFor={`conflict-value-${finding.id}`}>Otro valor</label>
          <input id={`conflict-value-${finding.id}`} value={value} onChange={(event) => setValue(event.target.value)} placeholder="El valor correcto, si no es A ni B" />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn--primary" disabled={busy || !value.trim()} onClick={() => void resolve(undefined, value.trim())}>
            {busy ? "Guardando…" : "Afirmar este valor"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
