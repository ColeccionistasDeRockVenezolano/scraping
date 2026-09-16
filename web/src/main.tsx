import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { OperatorProvider } from "./lib/OperatorContext";
import { ToastProvider } from "./lib/ToastContext";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root no encontrado");

// react-router exige que basename NO termine en "/" para reconocer tanto
// "/crv" como "/crv/" (BASE_URL de Vite siempre trae la barra final; con ella
// puesta, react-router no reconoce "/crv" sin barra y no monta nada, sin
// lanzar ningún error). Detrás de Funnel esto importa: Funnel recorta el
// prefijo antes de reenviar, así que el backend no puede distinguir ni
// redirigir "/crv" de "/crv/" — el arreglo tiene que ser aquí.
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

createRoot(container).render(
  <StrictMode>
  <BrowserRouter basename={basename}>
      <OperatorProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </OperatorProvider>
    </BrowserRouter>
  </StrictMode>,
);
