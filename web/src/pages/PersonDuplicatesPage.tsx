// CRV · Posibles duplicados de persona (E11.6; plan P10).
//
// La página donde el detector (E11.5) deja sus propuestas: cada fila lleva a
// comparar y fusionar (modal, E11.6) o a decir «son distintas», que el
// detector recuerda para no volver a proponer el par.
import { useState } from "react";
import { Link } from "react-router-dom";
import { entityMergeApi, reviewApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import type { PersonDuplicateCandidate } from "../lib/types";

const LIMIT = 30;
const MIN_SCORE_OPTIONS = [
  { value: "", label: "Todos los scores" },
  { value: "0.6", label: "Score alto (≥ 0,60)" },
  { value: "0.45", label: "Score medio (≥ 0,45)" },
];

interface CandidatePair {
  reviewId: number;
  a: PersonDuplicateCandidate["a"];
  b: PersonDuplicateCandidate["b"];
}

export function PersonDuplicatesPage() {
  const { notify } = useToast();
  const [offset, setOffset] = useState(0);
  const [minScore, setMinScore] = useState("");
  const [merging, setMerging] = useState<CandidatePair | null>(null);
  const [dismissing, setDismissing] = useState<CandidatePair | null>(null);

  const { data, loading, error, reload } = useAsync(
    () => entityMergeApi.duplicateCandidates({
      limit: LIMIT, offset, ...(minScore ? { minScore: Number(minScore) } : {}),
    }),
    [offset, minScore],
  );

  return (
    <>
      <div className="page-header">
        <div>
          <p className="page-kicker">Curaduría</p>
          <h1>Posibles duplicados</h1>
          <p className="page-lead">
            Pares que el detector propone revisar (apodos, alias cruzados, coincidencia de nombre con contexto).
            Nada se fusiona sin tu decisión.
          </p>
        </div>
      </div>

      <div className="list-toolbar">
        <label className="visually-hidden" htmlFor="candidate-score">Filtrar por score</label>
        <select
          id="candidate-score" className="filter-input" value={minScore}
          onChange={(event) => { setMinScore(event.target.value); setOffset(0); }}
        >
          {MIN_SCORE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState title="No hay posibles duplicados pendientes" hint="El detector no tiene pares nuevos por revisar." />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Persona A</th><th>Persona B</th><th>Score</th><th>Señales</th><th></th></tr>
              </thead>
              <tbody>
                {data.data.map((candidate) => (
                  <tr key={candidate.reviewId}>
                    <td><Link to={`/personas/${candidate.a.id}`}>{candidate.a.name}</Link> <span className="hint">({candidate.a.creditCount} créditos)</span></td>
                    <td><Link to={`/personas/${candidate.b.id}`}>{candidate.b.name}</Link> <span className="hint">({candidate.b.creditCount} créditos)</span></td>
                    <td className="mono">{candidate.score === null ? "—" : candidate.score.toFixed(2)}</td>
                    <td>
                      {candidate.features.slice(0, 3).map((feature) => (
                        <span className="badge" key={feature.key} title={feature.evidence}>{feature.key}</span>
                      ))}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button" className="btn btn--sm"
                          onClick={() => setMerging({ reviewId: candidate.reviewId, a: candidate.a, b: candidate.b })}
                        >
                          Comparar y fusionar
                        </button>
                        <button
                          type="button" className="btn btn--sm btn--ghost"
                          onClick={() => setDismissing({ reviewId: candidate.reviewId, a: candidate.a, b: candidate.b })}
                        >
                          Son distintas
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={setOffset} />
        </>
      )}

      {merging ? (
        <MergeEntityModal
          kind="person"
          entityId={merging.a.id}
          entityName={merging.a.name}
          otherId={merging.b.id}
          otherName={merging.b.name}
          onMerged={() => { setMerging(null); reload(); }}
          onClose={() => setMerging(null)}
        />
      ) : null}

      {dismissing ? (
        <ConfirmDialog
          title={`«${dismissing.a.name}» y «${dismissing.b.name}» son distintas`}
          description="Se cierra la propuesta y el detector no volverá a proponer este par. No cambia ninguna ficha."
          confirmLabel="Son distintas"
          onConfirm={async (note) => {
            await reviewApi.reject(dismissing.reviewId, note);
            notify("success", "Par descartado; no se volverá a proponer.");
            setDismissing(null);
            reload();
          }}
          onClose={() => setDismissing(null)}
        />
      ) : null}
    </>
  );
}
