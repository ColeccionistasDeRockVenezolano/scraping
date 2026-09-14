import { useState } from "react";
import { Modal } from "./Modal";
import { useOperator } from "../lib/OperatorContext";

export function OperatorPill() {
  const { creds, isConfigured } = useOperator();
  const [open, setOpen] = useState(false);
  const initial = creds.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <>
      <button type="button" className={`operator-pill ${isConfigured ? "is-active" : ""}`} onClick={() => setOpen(true)}>
        <span className="dot" />
        {isConfigured ? (
          <>
            <span className="chip">{initial}</span>
            <span className="operator-label">{creds.name || "Operador"}</span>
          </>
        ) : (
          <span className="operator-label">Solo lectura</span>
        )}
      </button>
      {open ? <OperatorDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function OperatorDialog({ onClose }: { onClose: () => void }) {
  const { creds, setCreds, clear } = useOperator();
  const [token, setToken] = useState(creds.token);
  const [name, setName] = useState(creds.name);

  function handleSave() {
    setCreds({ token: token.trim(), name: name.trim() });
    onClose();
  }

  return (
    <Modal title="Credenciales de operador" onClose={onClose}>
      <p style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "0 0 16px" }}>
        Sin token, el catálogo se puede consultar pero no editar. El token se guarda solo en este navegador
        y viaja únicamente a esta API (nunca a otro sitio).
      </p>
      <div className="form-grid">
        <div className="field span-2">
          <label htmlFor="op-token">Token de operador (CRV_OPERATOR_TOKEN)</label>
          <input id="op-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Token del servidor" />
        </div>
        <div className="field span-2">
          <label htmlFor="op-name">Nombre para firmar decisiones</label>
          <input id="op-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Tu nombre" />
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => { clear(); setToken(""); setName(""); }}>Olvidar</button>
        <button type="button" className="btn btn--primary" onClick={handleSave}>Guardar</button>
      </div>
    </Modal>
  );
}
