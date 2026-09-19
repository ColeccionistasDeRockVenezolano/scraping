import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, authApi } from "./api";
import { clearLegacyOperatorStorage, setSessionCsrf, type OperatorUser } from "./operator";
import { useToast } from "./ToastContext";

interface OperatorContextValue {
  user: OperatorUser | null;
  /** Solo una cuenta admin edita, fusiona y entra a Curaduría; la API lo exige igual. */
  isAdmin: boolean;
  isChecking: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const OperatorContext = createContext<OperatorContextValue | undefined>(undefined);

export function OperatorProvider({ children }: { children: ReactNode }) {
  const { notify } = useToast();
  const [user, setUser] = useState<OperatorUser | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  // La sesión puede expirar a mitad de una edición: se avisa una vez, no por
  // cada petición rechazada que llegue después.
  const sessionExpired = useRef(false);

  useEffect(() => {
    clearLegacyOperatorStorage();
    let active = true;
    void authApi.me()
      .then((session) => { if (active) setUser(session.user); })
      .catch(() => { /* Sin sesión o API temporalmente inaccesible: queda en solo lectura. */ })
      .finally(() => { if (active) setIsChecking(false); });
    const expire = () => {
      setUser(null);
      if (!sessionExpired.current) {
        sessionExpired.current = true;
        notify("info", "Tu sesión expiró. Inicia sesión de nuevo para poder editar.");
      }
    };
    window.addEventListener("crv-session-expired", expire);
    return () => {
      active = false;
      window.removeEventListener("crv-session-expired", expire);
    };
  }, [notify]);

  const login = useCallback(async (username: string, password: string) => {
    const session = await authApi.login(username, password);
    sessionExpired.current = false;
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (error: unknown) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    } finally {
      setSessionCsrf("");
      setUser(null);
    }
  }, []);

  const value = useMemo<OperatorContextValue>(
    () => ({ user, isAdmin: user?.role === "admin", isChecking, login, logout }),
    [user, isChecking, login, logout],
  );

  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>;
}

export function useOperator(): OperatorContextValue {
  const ctx = useContext(OperatorContext);
  if (!ctx) throw new Error("useOperator debe usarse dentro de OperatorProvider");
  return ctx;
}
