import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | undefined;
}

/**
 * Red de seguridad de la SPA: un error de render en cualquier página (un dato
 * con forma inesperada, por ejemplo) dejaba la aplicación en blanco, sin
 * mensaje ni salida. Aquí se muestra qué pasó, se ofrece recargar y el error
 * queda en consola para el reporte.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- la consola del navegador es el canal de diagnóstico de un error de render
    console.error("CRV: error de render", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="state-block is-error" role="alert">
        <h3>La interfaz encontró un error</h3>
        <p>
          Nada se guardó por accidente: esto es un fallo de presentación. Recarga la página;
          si vuelve a pasar, el detalle está en la consola del navegador (F12).
        </p>
        <p style={{ color: "var(--text-faint)", fontSize: 12.5 }}>{error.message}</p>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => window.location.reload()}>Recargar</button>
        </div>
      </div>
    );
  }
}
