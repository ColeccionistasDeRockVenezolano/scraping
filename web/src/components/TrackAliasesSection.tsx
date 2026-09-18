import { tracksApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { AliasEditor } from "./AliasEditor";

/**
 * Alias propios de una pista (auditoría #7): el CRUD de pistas ya tenía alias
 * por API pero ninguna vista los mostraba ni permitía editarlos. Se cargan
 * con `GET /tracks/{id}` al abrir el modal de la pista.
 */
export function TrackAliasesSection({ trackId, onChanged }: { trackId: number; onChanged: () => void }) {
  const { data, loading, error } = useAsync(() => tracksApi.get(trackId), [trackId]);
  return (
    <div className="field span-2" style={{ margin: "6px 0 2px" }}>
      <label>Alias de la pista</label>
      {loading && !data ? (
        <p style={{ color: "var(--text-faint)", fontSize: 13 }}>Cargando alias…</p>
      ) : error || !data ? (
        <p className="form-error-banner">{error ?? "No se pudieron cargar los alias de la pista."}</p>
      ) : (
        <AliasEditor path="tracks" entityId={trackId} aliases={data.aliases} onChanged={onChanged} />
      )}
    </div>
  );
}
