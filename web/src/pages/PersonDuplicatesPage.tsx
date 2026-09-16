// CRV · Posibles duplicados de persona (E11.6; plan P10).
//
// La página donde el detector (E11.5) deja sus propuestas: cada tarjeta lleva
// a comparar y fusionar (modal, E11.6) o a decir «son distintas», que el
// detector recuerda para no volver a proponer el par.
//
// El score del detector no es una probabilidad: es la SUMA de los pesos de las
// señales encontradas, con tope en 1 (src/review/person-candidates.ts). Aquí se
// muestra en puntos sobre 100 y con su desglose, para que el número se pueda
// leer sin conocer el código.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowSquareOut, CaretDown, CaretUp, GitMerge, Info, X } from "@phosphor-icons/react";
import { ApiError, entityMergeApi, reviewApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState, EmptyState } from "../components/StateViews";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import type { PersonDuplicateCandidate } from "../lib/types";

const LIMIT = 30;
/** Umbrales del detector (PERSON_CANDIDATE_MIN_SCORE / _STRONG_SCORE), en puntos. */
const MIN_POINTS = 45;
const STRONG_POINTS = 60;

type Feature = PersonDuplicateCandidate["features"][number];

interface SignalInfo {
  label: string;
  /** Peso en puntos tal como lo aplica el detector. */
  weight: string;
  sign: 1 | -1;
  explain: string;
  detail?: (evidence: string) => string | null;
}

/**
 * Traducción de cada feature del detector a lenguaje de curaduría. Los pesos
 * son los de `scorePersonPair`; si allí cambian, hay que cambiarlos aquí.
 */
const SIGNALS: Readonly<Record<string, SignalInfo>> = {
  nickname_equal: {
    label: "Mismo nombre sin el apodo", weight: "+45", sign: 1,
    explain: "Al quitar el apodo (entre comillas o paréntesis), los dos nombres son idénticos.",
    detail: (evidence) => after(evidence, "coinciden:"),
  },
  alias_cross: {
    label: "Registrado como alias", weight: "+45", sign: 1,
    explain: "El nombre de una ficha ya figura como alias declarado de la otra.",
    detail: () => "Uno figura como alias del otro",
  },
  first_last_equal: {
    label: "Mismo primer nombre y apellido", weight: "+25", sign: 1,
    explain: "Coinciden el primer nombre y el último apellido, aunque cambie lo del medio.",
    detail: (evidence) => after(evidence, "token:"),
  },
  jaro_winkler: {
    label: "Se escriben casi igual", weight: "hasta +15", sign: 1,
    explain: "Similitud de escritura del nombre sin apodo; solo cuenta desde el 92 %.",
    detail: (evidence) => {
      const match = /=([\d.]+)/u.exec(evidence);
      return match ? `Similitud de escritura del ${Math.round(Number(match[1]) * 100)} %` : null;
    },
  },
  shared_band: {
    label: "Tocan en la misma banda", weight: "+20", sign: 1,
    explain: "Las dos fichas figuran como miembros de al menos una misma banda.",
  },
  shared_album: {
    label: "Acreditados en el mismo disco", weight: "+15", sign: 1,
    explain: "Las dos fichas tienen créditos en al menos un mismo disco.",
    detail: (evidence) => {
      const count = Number(after(evidence, ":"));
      return Number.isFinite(count) && count > 0 ? `${plural(count, "disco", "discos")} en común` : null;
    },
  },
  middle_name_clash: {
    label: "Segundo nombre distinto", weight: "−10", sign: -1,
    explain: "Los nombres intermedios no coinciden: resta, pero no descarta (hay quien firma sin él).",
    detail: (evidence) => {
      const names = after(evidence, "distintos:");
      return names ? `Intermedios distintos: ${names}` : null;
    },
  },
};

function after(text: string, marker: string): string | null {
  const index = text.indexOf(marker);
  return index === -1 ? null : text.slice(index + marker.length).trim() || null;
}

/** Puntos con signo; el detector guarda la resta de `middle_name_clash` en positivo. */
function featurePoints(feature: Feature): number {
  return Math.round(feature.value * 100) * (SIGNALS[feature.key]?.sign ?? 1);
}

function levelOf(points: number): { label: string; tone: "high" | "medium" } {
  return points >= STRONG_POINTS ? { label: "Coincidencia alta", tone: "high" } : { label: "Coincidencia media", tone: "medium" };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

interface CandidatePair {
  reviewId: number;
  a: PersonDuplicateCandidate["a"];
  b: PersonDuplicateCandidate["b"];
}

export function PersonDuplicatesPage() {
  const { notify } = useToast();
  const [offset, setOffset] = useState(0);
  const [onlyStrong, setOnlyStrong] = useState(false);
  const [merging, setMerging] = useState<CandidatePair | null>(null);
  const [dismissing, setDismissing] = useState<CandidatePair | null>(null);
  const [busyPriority, setBusyPriority] = useState<number | null>(null);

  const { data, loading, error, reload } = useAsync(
    () => entityMergeApi.duplicateCandidates({
      limit: LIMIT, offset, ...(onlyStrong ? { minScore: STRONG_POINTS / 100 } : {}),
    }),
    [offset, onlyStrong],
  );

  const setFilter = (strong: boolean) => { setOnlyStrong(strong); setOffset(0); };

  /**
   * El orden de la cola (1-10, mayor = antes) no lo decide el detector: aquí
   * el operador lo ajusta a mano cuando un par urge más que otros.
   */
  async function changePriority(reviewId: number, next: number) {
    if (next < 1 || next > 10) return;
    setBusyPriority(reviewId);
    try {
      await reviewApi.setPriority(reviewId, next, "Reordenado desde posibles duplicados");
      reload();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo cambiar la prioridad.");
    } finally {
      setBusyPriority(null);
    }
  }

  return (
    <>
      <p className="curation-lead">
        Pares de fichas de persona que podrían ser la misma. Revisa por qué se proponen y decide si se
        fusionan o son personas distintas. Nada cambia sin tu decisión.
      </p>

      <ScoreGuide />

      <div className="list-toolbar">
        <div className="segmented" role="group" aria-label="Filtrar por coincidencia">
          <button type="button" className="segmented__option" aria-pressed={!onlyStrong} onClick={() => setFilter(false)}>
            Todos <span className="segmented__range">{MIN_POINTS}–100 pts</span>
          </button>
          <button type="button" className="segmented__option" aria-pressed={onlyStrong} onClick={() => setFilter(true)}>
            Solo alta <span className="segmented__range">{STRONG_POINTS}–100 pts</span>
          </button>
        </div>
        {data && !loading ? (
          <p className="dup-count" aria-live="polite">
            {plural(data.pagination.total, "par pendiente", "pares pendientes")}
          </p>
        ) : null}
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState
          title={onlyStrong ? "No hay pares con coincidencia alta" : "No hay posibles duplicados pendientes"}
          hint={onlyStrong ? "Prueba con «Todos» para ver los de coincidencia media." : "El detector no tiene pares nuevos por revisar."}
        />
      ) : (
        <>
          <ol className="dup-list">
            {data.data.map((candidate) => {
              const pair = { reviewId: candidate.reviewId, a: candidate.a, b: candidate.b };
              return (
                <li key={candidate.reviewId}>
                  <CandidateCard
                    candidate={candidate} onMerge={() => setMerging(pair)} onDismiss={() => setDismissing(pair)}
                    priorityBusy={busyPriority === candidate.reviewId}
                    onPriorityChange={(next) => void changePriority(candidate.reviewId, next)}
                  />
                </li>
              );
            })}
          </ol>
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
          title="¿Son personas distintas?"
          description={`«${dismissing.a.name}» y «${dismissing.b.name}» seguirán como dos fichas separadas. La propuesta se cierra y el detector no volverá a sugerir este par. Ninguna ficha se modifica.`}
          confirmLabel="Sí, son personas distintas"
          onConfirm={async (note) => {
            await reviewApi.reject(dismissing.reviewId, note);
            notify("success", "Marcadas como personas distintas; el par no se volverá a proponer.");
            setDismissing(null);
            reload();
          }}
          onClose={() => setDismissing(null)}
        />
      ) : null}
    </>
  );
}

/** Explica qué mide el número antes de que haga falta preguntarlo. */
function ScoreGuide() {
  return (
    <details className="score-guide">
      <summary>
        <Info size={18} weight="bold" aria-hidden="true" />
        <span>¿Cómo se calcula la puntuación de coincidencia?</span>
        <CaretDown className="score-guide__caret" size={16} weight="bold" aria-hidden="true" />
      </summary>
      <div className="score-guide__body">
        <p>
          Cada par recibe <strong>puntos de 0 a 100</strong> que resultan de <strong>sumar las señales</strong> que el
          detector encuentra entre las dos fichas. <strong>No es un porcentaje de certeza</strong>: 100 significa que
          coinciden varias señales fuertes (la suma se corta en 100), no que sea seguro que se trata de la misma persona.
        </p>
        <ul className="score-guide__levels">
          <li><span className="score-dot score-dot--high" aria-hidden="true" /><strong>Alta:</strong> de {STRONG_POINTS} a 100 puntos</li>
          <li><span className="score-dot score-dot--medium" aria-hidden="true" /><strong>Media:</strong> de {MIN_POINTS} a {STRONG_POINTS - 1} puntos</li>
          <li className="score-guide__muted">Con menos de {MIN_POINTS} puntos el par no se propone.</li>
        </ul>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Señal</th><th>Qué significa</th><th className="num">Puntos</th></tr></thead>
            <tbody>
              {Object.entries(SIGNALS).map(([key, signal]) => (
                <tr key={key}>
                  <td className="score-guide__signal">{signal.label}</td>
                  <td>{signal.explain}</td>
                  <td className={`num ${signal.sign < 0 ? "is-negative" : "is-positive"}`}>{signal.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="score-guide__muted">
          Nunca se proponen pares con fechas de nacimiento o muerte distintas, ni nombres que parecen un estudio, sello o productora.
        </p>
      </div>
    </details>
  );
}

function CandidateCard({ candidate, onMerge, onDismiss, priorityBusy, onPriorityChange }: {
  candidate: PersonDuplicateCandidate; onMerge: () => void; onDismiss: () => void;
  priorityBusy: boolean; onPriorityChange: (next: number) => void;
}) {
  const points = candidate.score === null ? null : Math.round(candidate.score * 100);
  const rawSum = candidate.features.reduce((sum, feature) => sum + featurePoints(feature), 0);
  const level = points === null ? null : levelOf(points);
  const titleId = `dup-${candidate.reviewId}`;

  return (
    <article className="dup-card" aria-labelledby={titleId}>
      <h2 className="visually-hidden" id={titleId}>{candidate.a.name} y {candidate.b.name}</h2>

      <div className="dup-card__people">
        <PersonSide person={candidate.a} />
        <span className="dup-card__vs" aria-hidden="true">≈</span>
        <PersonSide person={candidate.b} />
      </div>

      <div className={`dup-score${level ? ` dup-score--${level.tone}` : ""}`}>
        {points === null || !level ? (
          <span className="dup-score__label">Sin puntuación</span>
        ) : (
          <>
            <span className="dup-score__label">{level.label}</span>
            <span className="dup-score__value">
              <strong className="mono">{points}</strong>
              <span>/ 100 pts</span>
            </span>
            <span
              className="dup-score__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={points}
              aria-label={`${level.label}: ${points} de 100 puntos`}
            >
              <span className="dup-score__fill" style={{ width: `${points}%` }} />
            </span>
          </>
        )}
      </div>

      <div className="dup-card__signals">
        <h3>Por qué se propone</h3>
        {candidate.features.length === 0 ? <p className="score-guide__muted">El detector no registró señales para este par.</p> : (
          <ul className="signal-list">
            {candidate.features.map((feature) => {
              const info = SIGNALS[feature.key];
              const pts = featurePoints(feature);
              const detail = info?.detail?.(feature.evidence) ?? info?.explain ?? feature.evidence;
              return (
                <li key={feature.key} className={pts < 0 ? "is-negative" : undefined}>
                  <span className="signal-list__points mono">{pts < 0 ? `−${Math.abs(pts)}` : `+${pts}`}</span>
                  <span className="signal-list__text">
                    <strong>{info?.label ?? feature.key}</strong>
                    <span>{detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {points !== null && rawSum > points ? (
          <p className="signal-cap">Las señales suman {rawSum} puntos; la puntuación se corta en 100.</p>
        ) : null}
      </div>

      <div className="dup-card__actions">
        <button type="button" className="btn btn--primary" onClick={onMerge}>
          <GitMerge size={16} weight="bold" aria-hidden="true" />
          Comparar y fusionar
        </button>
        <button type="button" className="btn btn--outline" onClick={onDismiss}>
          <X size={16} weight="bold" aria-hidden="true" />
          No son la misma persona
        </button>
        <div className="dup-priority" role="group" aria-label="Orden en la cola">
          <span className="dup-priority__label">Prioridad</span>
          <button
            type="button" className="btn btn--sm btn--outline" disabled={priorityBusy || candidate.priority <= 1}
            onClick={() => onPriorityChange(candidate.priority - 1)} aria-label="Bajar prioridad"
          >
            <CaretDown size={13} weight="bold" aria-hidden="true" />
          </button>
          <span className="mono dup-priority__value">{candidate.priority}</span>
          <button
            type="button" className="btn btn--sm btn--outline" disabled={priorityBusy || candidate.priority >= 10}
            onClick={() => onPriorityChange(candidate.priority + 1)} aria-label="Subir prioridad"
          >
            <CaretUp size={13} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}

function PersonSide({ person }: { person: PersonDuplicateCandidate["a"] }) {
  return (
    <div className="dup-person">
      <Link className="text-link dup-person__name" to={`/personas/${person.id}`} target="_blank" rel="noopener">
        <span>{person.name}</span>
        <ArrowSquareOut size={14} weight="bold" aria-hidden="true" />
        <span className="visually-hidden"> (abre la ficha en otra pestaña)</span>
      </Link>
      <span className="dup-person__meta">
        Ficha <span className="mono">#{person.id}</span> · {plural(person.creditCount, "crédito", "créditos")}
      </span>
    </div>
  );
}
