// Estado efímero de la sesión. La identidad real vive en una cookie HttpOnly;
// el navegador no puede leerla ni guardarla en localStorage.
export interface OperatorUser {
  username: string;
  name: string;
  /** admin edita, fusiona y revisa; reader solo lee (src/api/auth.ts). */
  role: "admin" | "reader";
}

let csrfToken = "";

export function getSessionCsrf(): string {
  return csrfToken;
}

export function setSessionCsrf(value: string): void {
  csrfToken = value;
}

/** Retira credenciales heredadas de versiones anteriores de la interfaz. */
export function clearLegacyOperatorStorage(): void {
  try {
    localStorage.removeItem("crv.operatorToken");
    localStorage.removeItem("crv.operatorName");
  } catch {
    // El acceso puede estar deshabilitado; la aplicación no depende de él.
  }
}
