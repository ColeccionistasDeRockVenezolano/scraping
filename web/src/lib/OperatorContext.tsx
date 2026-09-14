import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { loadOperatorCreds, saveOperatorCreds, type OperatorCreds } from "./operator";

interface OperatorContextValue {
  creds: OperatorCreds;
  isConfigured: boolean;
  setCreds: (creds: OperatorCreds) => void;
  clear: () => void;
}

const OperatorContext = createContext<OperatorContextValue | undefined>(undefined);

export function OperatorProvider({ children }: { children: ReactNode }) {
  const [creds, setCredsState] = useState<OperatorCreds>(() => loadOperatorCreds());

  const setCreds = useCallback((next: OperatorCreds) => {
    saveOperatorCreds(next);
    setCredsState(next);
  }, []);

  const clear = useCallback(() => {
    saveOperatorCreds({ token: "", name: "" });
    setCredsState({ token: "", name: "" });
  }, []);

  const value = useMemo<OperatorContextValue>(
    () => ({ creds, isConfigured: creds.token.length > 0, setCreds, clear }),
    [creds, setCreds, clear],
  );

  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>;
}

export function useOperator(): OperatorContextValue {
  const ctx = useContext(OperatorContext);
  if (!ctx) throw new Error("useOperator debe usarse dentro de OperatorProvider");
  return ctx;
}
