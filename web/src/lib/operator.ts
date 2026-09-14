// CRV · Credenciales del operador (src/api/auth.ts). Se guardan solo en este
// navegador (localStorage): nunca viajan a otro sitio que no sea la API.
const TOKEN_KEY = "crv.operatorToken";
const NAME_KEY = "crv.operatorName";

export interface OperatorCreds {
  token: string;
  name: string;
}

export function loadOperatorCreds(): OperatorCreds {
  try {
    return { token: localStorage.getItem(TOKEN_KEY) ?? "", name: localStorage.getItem(NAME_KEY) ?? "" };
  } catch {
    return { token: "", name: "" };
  }
}

export function saveOperatorCreds(creds: OperatorCreds): void {
  try {
    if (creds.token) localStorage.setItem(TOKEN_KEY, creds.token); else localStorage.removeItem(TOKEN_KEY);
    if (creds.name) localStorage.setItem(NAME_KEY, creds.name); else localStorage.removeItem(NAME_KEY);
  } catch {
    // localStorage inaccesible (modo privado, etc.): la sesión sigue solo en memoria.
  }
}
