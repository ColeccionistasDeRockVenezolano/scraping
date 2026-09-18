import { useState } from "react";
import { PencilSimple, Star, Trash } from "@phosphor-icons/react";
import { aliasWrites, ApiError, type EntityPath } from "../lib/api";
import { aliasTypeLabel, ALIAS_TYPES } from "../lib/labels";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import type { Alias } from "../lib/types";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";

interface AliasEditorProps {
  path: EntityPath;
  entityId: number;
  aliases: Alias[];
  onChanged: () => void;
}

export function AliasEditor({ path, entityId, aliases, onChanged }: AliasEditorProps) {
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState("");
  const [aliasType, setAliasType] = useState("name_variant");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Alias | null>(null);
  const [removing, setRemoving] = useState<Alias | null>(null);
  const [promoting, setPromoting] = useState<Alias | null>(null);

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    if (!alias.trim() || !note.trim()) { notify("error", "Alias y motivo son obligatorios."); return; }
    setBusy(true);
    try {
      await aliasWrites[path].create(entityId, { alias: alias.trim(), aliasType, isPrimary: false, note: note.trim() });
      setAlias("");
      setNote("");
      setAdding(false);
      onChanged();
      notify("success", "Alias añadido.");
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo añadir el alias.");
    } finally {
      setBusy(false);
    }
  }

  async function handleMakePrimary(aliasId: number, note: string) {
    try {
      await aliasWrites[path].update(entityId, aliasId, { isPrimary: true, note });
      onChanged();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo actualizar el alias.");
    }
  }

  async function handleRemove(aliasId: number, note: string) {
    try {
      await aliasWrites[path].remove(entityId, aliasId, note);
      onChanged();
      notify("success", "Alias retirado.");
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo retirar el alias.");
    }
  }

  return (
    <div>
      <ul style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {aliases.map((item) => (
          <li key={item.id} className={`chip ${item.isPrimary ? "is-primary" : ""}`}>
            {item.isPrimary ? <Star className="chip-icon chip-icon--primary" aria-label="Alias principal" weight="fill" /> : null}
            <span>{item.alias}</span>
            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{aliasTypeLabel(item.aliasType)}</span>
            {isAdmin ? (
              <>
                {!item.isPrimary ? (
                  <button type="button" title="Marcar como principal" aria-label={`Marcar ${item.alias} como principal`} onClick={() => setPromoting(item)}><Star aria-hidden="true" /></button>
                ) : null}
                <button type="button" title="Editar" aria-label={`Editar ${item.alias}`} onClick={() => setEditing(item)}><PencilSimple aria-hidden="true" /></button>
                <button type="button" title="Retirar" aria-label={`Retirar ${item.alias}`} onClick={() => setRemoving(item)}><Trash aria-hidden="true" /></button>
              </>
            ) : null}
          </li>
        ))}
        {aliases.length === 0 ? <span style={{ color: "var(--text-faint)", fontSize: 13 }}>Sin alias registrados.</span> : null}
      </ul>
      {isAdmin ? (
        adding ? (
          <form onSubmit={handleAdd} style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="Nuevo alias" autoFocus style={{ minWidth: 200 }} className="filter-input" />
            <select value={aliasType} onChange={(event) => setAliasType(event.target.value)} className="filter-input">
              {ALIAS_TYPES.map((type) => <option key={type} value={type}>{aliasTypeLabel(type)}</option>)}
            </select>
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Motivo *" className="filter-input" style={{ minWidth: 220 }} />
            <button type="submit" className="btn btn--sm btn--primary" disabled={busy}>Añadir</button>
            <button type="button" className="btn btn--sm" onClick={() => setAdding(false)}>Cancelar</button>
          </form>
        ) : (
          <button type="button" className="btn btn--sm btn--ghost" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>+ Añadir alias</button>
        )
      ) : null}
      {editing ? (
        <EditAliasModal path={path} entityId={entityId} alias={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); onChanged(); notify("success", "Alias actualizado."); }} />
      ) : null}
      {removing ? (
        <ConfirmDialog title={`Retirar «${removing.alias}»`} description="El alias deja de estar disponible para búsqueda y conciliación."
          confirmLabel="Retirar" danger onClose={() => setRemoving(null)} onConfirm={async (note) => {
            await handleRemove(removing.id, note);
            setRemoving(null);
          }} />
      ) : null}
      {promoting ? (
        <ConfirmDialog
          title={`Marcar «${promoting.alias}» como alias principal`}
          description="El alias principal es el que la búsqueda y la conciliación usan para reconocer el nombre canónico."
          confirmLabel="Marcar"
          onClose={() => setPromoting(null)}
          onConfirm={async (note) => {
            await handleMakePrimary(promoting.id, note);
            setPromoting(null);
          }}
        />
      ) : null}
    </div>
  );
}

function EditAliasModal({ path, entityId, alias, onClose, onDone }: {
  path: EntityPath; entityId: number; alias: Alias; onClose: () => void; onDone: () => void;
}) {
  const [value, setValue] = useState(alias.alias);
  const [type, setType] = useState(alias.aliasType);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim() || !note.trim()) { setError("Alias y motivo son obligatorios."); return; }
    setBusy(true);
    try {
      await aliasWrites[path].update(entityId, alias.id, { alias: value.trim(), aliasType: type, note: note.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo actualizar el alias.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Editar alias" onClose={onClose}>
      <form onSubmit={submit}>
        {error ? <p className="form-error-banner">{error}</p> : null}
        <div className="form-grid">
          <div className="field"><label htmlFor="alias-value">Alias *</label><input id="alias-value" value={value} onChange={(event) => setValue(event.target.value)} /></div>
          <div className="field"><label htmlFor="alias-type">Tipo *</label><select id="alias-type" value={type} onChange={(event) => setType(event.target.value)}>{ALIAS_TYPES.map((item) => <option key={item} value={item}>{aliasTypeLabel(item)}</option>)}</select></div>
          <div className="field span-2"><label htmlFor="alias-note">Motivo *</label><textarea id="alias-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></div>
        </div>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></div>
      </form>
    </Modal>
  );
}
