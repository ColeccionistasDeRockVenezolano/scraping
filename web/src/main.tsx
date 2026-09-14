import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { OperatorProvider } from "./lib/OperatorContext";
import { ToastProvider } from "./lib/ToastContext";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root no encontrado");

createRoot(container).render(
  <StrictMode>
  <BrowserRouter basename={import.meta.env.BASE_URL}>
      <OperatorProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </OperatorProvider>
    </BrowserRouter>
  </StrictMode>,
);
