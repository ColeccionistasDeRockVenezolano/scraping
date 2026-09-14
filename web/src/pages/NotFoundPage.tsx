import { Link } from "react-router-dom";
import { EmptyState } from "../components/StateViews";

export function NotFoundPage() {
  return (
    <div className="section">
      <EmptyState title="Página no encontrada" hint="Revisa el enlace o vuelve al buscador." />
      <div style={{ textAlign: "center" }}>
        <Link to="/" className="btn btn--primary">Ir al buscador</Link>
      </div>
    </div>
  );
}
