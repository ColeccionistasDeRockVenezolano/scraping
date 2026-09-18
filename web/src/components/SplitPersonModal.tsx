// CRV · División de una persona combinada (E6.3): reparte su trayectoria y sus
// créditos entre varias fichas y retira la original. Dos pasos, como la fusión:
// primero la vista previa (destinos y créditos a repartir) y después la
// división real, con motivo obligatorio. Nada se escribe en la vista previa.
import { useState } from "react";
import { Link } from "react-router-dom";
import { personSplitApi, ApiError } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { Modal } from "./Modal";
import type { PersonSplitResult, PersonSplitPreview } from "../lib/types";

interface SplitPersonModalProps {
  personId: number;
  personName: string;
  onSplit: (result: PersonSplitResult) => void;
  onClose: () => void;
}

export function SplitPersonModal({ personId, personName, onSplit, onClose }: SplitPersonModalProps) {
  const { notify } = useToast();
  const [names, setNames] = useState<string[]>(["", ""]);
  const [preview, setPreview] = useState<PersonSplitPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PersonSplitResult | null>(null);

  function updateName(index: number, value: string) {
    setNames((current) => current.map((name, position) => (position === index ? value : name)));
    setPreview(null);
  }

  function addName() {
    setNames((current) => [...current, ""]);
    setPreview(null);
  }

  function removeName(index: number) {
    setNames((current) => current.length <= 2 ? current : current.filter((_, position) => position !== index));
    setPreview(null);
  }

  const filled = names.map((name) => name.trim()).filter(Boolean);

  async function loadPreview() {
    if (filled.length < 2) { setError("Indica al menos dos nombres en los que se divide."); return; }
    setLoading(true);
    setError(undefined);
    try {
      setPreview(await personSplitApi.preview(personId, filled));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo previsualizar la división.");
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!preview) return;
    if (!note.trim()) { setError("El motivo es obligatorio (queda en la auditoría)."); return; }
    setBusy(true);
    setError(undefined);
    try {
      const split = await personSplitApi.split(personId, preview.into, note.trim());
      notify("success", `Persona dividida: ${split.credits} créditos repartidos en ${split.targetIds.length} fichas.`);
      setResult(split);
      setBusy(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo dividir la persona.");
      setBusy(false);
    }
  }

  return (
    <Modal title={result ? "División completada" : `Dividir «${personName}»`} onClose={onClose} wide>
      {result ? (
        <>
          <p style={{ fontSize: 14, margin: "0 0 10px" }}>{result.detail} · {result.credits} créditos repartidos.</p>
          <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
            {result.targetIds.map((targetId) => (
              <li key={targetId}><Link to={`/personas/${targetId}`}>Ficha #{targetId}</Link></li>
            ))}
          </ul>
          <p className="hint">La ficha original se retiró; su enlace ahora redirige a uno de los destinos.</p>
          <div className="form-actions">
            <button type="button" className="btn btn--primary" onClick={() => onSplit(result)}>Ir a las fichas</button>
          </div>
        </>
      ) : (
        <>
          <p className="dialog-lead">
            Reparte la trayectoria y los créditos de «{personName}» entre varias personas.
            La ficha original se retira: revisa la vista previa antes de dividir.
          </p>
          {error ? <p className="form-error-banner" role="alert">{error}</p> : null}

          <fieldset style={{ border: 0, padding: 0, margin: "0 0 4px" }}>
            <legend className="hint" style={{ padding: 0 }}>Nombres en los que se divide (2 o más) *</legend>
            {names.map((name, index) => (
              <div key={index} style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <label className="visually-hidden" htmlFor={`split-name-${index}`}>Nombre {index + 1}</label>
                <input
                  id={`split-name-${index}`}
                  value={name}
                  onChange={(event) => updateName(index, event.target.value)}
                  placeholder={index === 0 ? "Primera persona…" : "Siguiente persona…"}
                  style={{ flex: 1 }}
                />
                {names.length > 2 ? (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => removeName(index)}
                    aria-label={`Quitar el nombre ${index + 1}`}>×</button>
                ) : null}
              </div>
            ))}
            <button type="button" className="btn btn--sm btn--ghost" style={{ marginTop: 8 }} onClick={addName}>+ Añadir nombre</button>
          </fieldset>

          <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 10 }}>
            <button type="button" className="btn btn--sm btn--outline" onClick={loadPreview} disabled={loading || busy}>
              {loading ? "Calculando…" : "Previsualizar reparto"}
            </button>
          </div>

          {preview ? (
            <>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <caption className="visually-hidden">Destinos de la división y sus créditos</caption>
                  <thead><tr><th scope="col">Nombre</th><th scope="col">Destino</th></tr></thead>
                  <tbody>
                    {preview.targets.map((target) => (
                      <tr key={target.name}>
                        <td>{target.name}</td>
                        <td>
                          {target.existingId !== null
                            ? <span>Se fusiona con la ficha existente <Link to={`/personas/${target.existingId}`}>#{target.existingId}</Link></span>
                            : <span className="hint">Ficha nueva</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Se repartirán {preview.counts.albumCredits + preview.counts.trackCredits} créditos
                ({preview.counts.albumCredits} de disco, {preview.counts.trackCredits} de pista), {preview.counts.memberships} membresías
                y {preview.counts.organizations} vínculos con organizaciones.
              </p>
              {preview.warnings.length ? (
                <div className="alert-block" role="alert" style={{ marginTop: 10 }}>
                  <strong>Avisos</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </div>
              ) : null}
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="split-note">Motivo *</label>
                <textarea
                  id="split-note" rows={3} value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Por qué estaba combinada y en quiénes se divide (queda en la auditoría)"
                />
              </div>
            </>
          ) : null}

          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
            <button type="button" className="btn btn--danger" onClick={submit} disabled={busy || !preview || !note.trim()}>
              {busy ? "Dividiendo…" : "Dividir la persona"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
