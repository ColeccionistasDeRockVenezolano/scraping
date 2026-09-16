// CRV · Convertir una persona basura en organización o artista (E11.7).
//
// El aviso de la ficha (nombre que no parece de una persona) abre este modal:
// se elige una ficha existente con el selector o se crea una nueva, y la
// conversión pasa por el mismo camino que el resto de la API (claims humanos,
// auditoría y redirección del id, E11.2).
import { useState } from "react";
import { entityMergeApi } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { Modal } from "./Modal";
import { EntityPicker } from "./EntityPicker";
import { ARTIST_TYPES, ORGANIZATION_TYPES, artistTypeLabel, organizationTypeLabel } from "../lib/labels";
import type { PersonConversionResult } from "../lib/types";

interface ConvertPersonModalProps {
  person: { id: number; name: string; nameClassReason: string };
  kind: "organization" | "artist";
  onConverted: (result: PersonConversionResult) => void;
  onClose: () => void;
}

export function ConvertPersonModal({ person, kind, onConverted, onClose }: ConvertPersonModalProps) {
  const { notify } = useToast();
  const label = kind === "organization" ? "organización" : "artista";
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [targetId, setTargetId] = useState<number | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [name, setName] = useState(person.name);
  const [type, setType] = useState(kind === "organization" ? "recording_studio" : "band");
  const [keepNameAsAlias, setKeepNameAsAlias] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const types = kind === "organization" ? ORGANIZATION_TYPES : ARTIST_TYPES;

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await entityMergeApi.convert(person.id, {
        to: kind,
        ...(mode === "existing" ? { targetId: targetId! } : {
          create: {
            name: name.trim(),
            ...(kind === "organization" ? { organizationType: type } : { artistType: type }),
          },
        }),
        keepNameAsAlias,
        note: note.trim(),
      });
      notify("success", `Convertida en ${label}: ${result.detail}`);
      onConverted(result);
    } catch (err) {
      // 409 con `existingId`: el ER ya reconoce una ficha con ese nombre; se
      // ofrece en vez de crear otra (el detalle lo trae la API).
      const details = (err as { details?: { existingId?: number } }).details;
      if (details?.existingId) {
        setMode("existing");
        setTargetId(details.existingId);
        setTargetLabel(null);
        setError(`Ya existe una ${label} con ese nombre (id ${details.existingId}); se seleccionó para que la elijas.`);
      } else {
        setError(err instanceof Error ? err.message : "No se pudo convertir.");
      }
      setBusy(false);
    }
  }

  return (
    <Modal title={`Convertir en ${label}`} onClose={onClose}>
      <p style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "0 0 14px" }}>
        «{person.name}» no parece una persona{person.nameClassReason ? `: ${person.nameClassReason}` : ""}. Sus créditos
        pasarán a la {label} y su enlace llevará a la ficha nueva.
      </p>

      <fieldset style={{ border: 0, margin: "0 0 12px", padding: 0 }}>
        <legend className="visually-hidden">Destino de la conversión</legend>
        <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
          <input type="radio" name="convert-mode" checked={mode === "existing"} onChange={() => setMode("existing")} /> Usar una {label} existente
        </label>
        <label style={{ display: "block", fontSize: 13 }}>
          <input type="radio" name="convert-mode" checked={mode === "new"} onChange={() => setMode("new")} /> Crear una {label} nueva
        </label>
      </fieldset>

      {mode === "existing" ? (
        <EntityPicker
          kind={kind}
          label={`${label[0]!.toUpperCase()}${label.slice(1)} que absorbe la ficha`}
          value={targetId}
          valueLabel={targetLabel}
          onSelect={(id, selectedLabel) => { setTargetId(id); setTargetLabel(selectedLabel); }}
        />
      ) : (
        <div className="compare-grid">
          <div className="field">
            <label htmlFor="convert-name">Nombre</label>
            <input id="convert-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="convert-type">Tipo</label>
            <select id="convert-type" value={type} onChange={(event) => setType(event.target.value)}>
              {types.map((value) => (
                <option key={value} value={value}>
                  {kind === "organization" ? organizationTypeLabel(value) : artistTypeLabel(value)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, margin: "12px 0" }}>
        <input type="checkbox" checked={keepNameAsAlias} onChange={(event) => setKeepNameAsAlias(event.target.checked)} />
        Guardar «{person.name}» como alias
      </label>

      <div className="field">
        <label htmlFor="convert-note">Motivo *</label>
        <textarea
          id="convert-note" rows={3} value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Por qué no es una persona (queda en la auditoría)"
        />
      </div>

      {error ? <p className="form-error-banner" style={{ marginTop: 12 }} role="alert">{error}</p> : null}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
        <button
          type="button" className="btn btn--primary" onClick={submit}
          disabled={busy || !note.trim() || (mode === "existing" ? targetId === null : name.trim().length === 0)}
        >
          {busy ? "Convirtiendo…" : `Convertir en ${label}`}
        </button>
      </div>
    </Modal>
  );
}
