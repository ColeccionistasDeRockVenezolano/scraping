import { useState, type FormEvent } from "react";
import { SignIn, SignOut } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { ApiError } from "../lib/api";
import { useOperator } from "../lib/OperatorContext";

export function OperatorPill() {
  const { user, isChecking } = useOperator();
  const isSignedIn = user !== null;
  const [open, setOpen] = useState(false);
  const initial = user?.name.trim().charAt(0).toUpperCase() || "?";
  const label = isChecking ? "Comprobando acceso" : user?.name ?? "Solo lectura";

  return (
    <>
      <button
        type="button"
        className={`operator-pill ${isSignedIn ? "is-active" : ""}`}
        onClick={() => setOpen(true)}
        aria-label={isSignedIn ? `Sesión de ${label}` : "Iniciar sesión como colaborador"}
      >
        <span className="dot" aria-hidden="true" />
        {isSignedIn ? <span className="chip" aria-hidden="true">{initial}</span> : <SignIn className="operator-icon" aria-hidden="true" weight="bold" />}
        <span className="operator-label">{label}</span>
      </button>
      {open ? <OperatorDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function OperatorDialog({ onClose }: { onClose: () => void }) {
  const { user, login, logout } = useOperator();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      setPassword("");
      onClose();
    } catch (reason: unknown) {
      setError(reason instanceof ApiError ? reason.message : "No se pudo iniciar sesión. Inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setError("");
    setSubmitting(true);
    try {
      await logout();
      onClose();
    } catch (reason: unknown) {
      setError(reason instanceof ApiError ? reason.message : "No se pudo cerrar la sesión.");
    } finally {
      setSubmitting(false);
    }
  }

  if (user) {
    return (
      <Modal title="Cuenta de colaborador" onClose={onClose}>
        <div className="account-summary">
          <span className="account-avatar" aria-hidden="true">{user.name.charAt(0).toUpperCase()}</span>
          <div>
            <strong>{user.name}</strong>
            <span>@{user.username} · {user.role === "admin" ? "Administrador" : "Solo lectura"}</span>
          </div>
        </div>
        <p className="operator-help">
          {user.role === "admin"
            ? "Cuenta administradora: puedes editar, fusionar y usar Curaduría. Tus cambios quedan firmados con esta cuenta en el historial del catálogo."
            : "Cuenta de solo lectura: puedes consultar el catálogo, pero editar, fusionar y usar Curaduría requiere una cuenta administradora."}
        </p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Volver</button>
          <button type="button" className="btn btn--danger" onClick={() => void handleLogout()} disabled={submitting}>
            <SignOut aria-hidden="true" weight="bold" />
            {submitting ? "Cerrando…" : "Cerrar sesión"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Acceso de colaboradores" onClose={onClose}>
      <p className="operator-help">
        Inicia sesión con una cuenta administradora para editar, fusionar y usar Curaduría. Consultar el catálogo no requiere cuenta.
      </p>
      <form onSubmit={(event) => void handleLogin(event)}>
        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="op-username">Usuario</label>
            <input
              id="op-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="tu.usuario"
              required
              minLength={3}
              maxLength={80}
            />
          </div>
          <div className="field span-2">
            <label htmlFor="op-password">Contraseña</label>
            <input
              id="op-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={200}
            />
          </div>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <p className="security-note">La sesión se protege en una cookie inaccesible para JavaScript. La contraseña no se guarda en este dispositivo.</p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={submitting || username.trim().length < 3 || !password}>
            {submitting ? "Verificando…" : "Iniciar sesión"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
