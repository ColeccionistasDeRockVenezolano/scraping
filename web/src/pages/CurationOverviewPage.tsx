// CRV · Curaduría › Conflictos: el tablero del detector.
//
// Arriba, el estado del detector: cuándo analizó por última vez y qué lo
// disparó. Debajo, la verificación de la última corrección —cada escritura
// correcta de la API vuelve a analizar el catálogo (src/curation/watcher.ts)—
// con lo que resolvió y lo que hizo aparecer. Al final, una tarjeta por
// categoría con hallazgos abiertos y, aparte, las que están al día.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowsClockwise, ArrowBendDownRight, CheckCircle, Clock, Sparkle, NotEquals } from "@phosphor-icons/react";
import { ApiError, curationApi } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { ENTITY_KIND_LABEL, categoryIcon, counter, failedDetectors, formatCount, relativeTime, triggerLabel } from "../lib/curation";
import { entityHref } from "../lib/routes";
import { AutofixAlerts, AutofixToday } from "../components/AutofixToday";
import { useAsync } from "../lib/useAsync";
import { ErrorState } from "../components/StateViews";
import { HeaderSkeleton, RowsSkeleton } from "../components/Skeletons";
import { useCurationSummary } from "./CurationLayout";
import type { CurationAutofixSummary, CurationCategorySummary, CurationMetrics, CurationScan, DistinctPair } from "../lib/types";

export function CurationOverviewPage() {
  const { summary, summaryError, refreshSummary } = useCurationSummary();
  const { notify } = useToast();
  const [scanning, setScanning] = useState(false);

  async function scanNow() {
    setScanning(true);
    try {
      const result = await curationApi.scan();
      if (result.status === "failed") {
        notify("error", `El análisis falló: ${result.error ?? "error desconocido"}`);
      } else if (result.status === "skipped") {
        notify("info", "Otro proceso está analizando el catálogo en este momento. Vuelve a intentarlo en unos segundos.");
      } else if (result.status === "partial") {
        notify("info", `Análisis parcial: ${formatCount(result.inserted + result.reopened)} nuevos, ${formatCount(result.resolved)} resueltos. `
          + `Fallaron ${result.failures.map((failure) => failure.detector).join(", ")}; sus hallazgos no se tocaron.`);
      } else {
        notify("success", `Análisis listo: ${formatCount(result.inserted + result.reopened)} nuevos, ${formatCount(result.resolved)} resueltos.`);
      }
    } catch (error) {
      notify("error", error instanceof ApiError ? error.message : "No se pudo analizar el catálogo.");
    } finally {
      setScanning(false);
      await refreshSummary();
    }
  }

  if (!summary) {
    return summaryError ? <ErrorState message={summaryError} onRetry={() => void refreshSummary()} /> : (
      <div role="status" aria-label="Cargando el detector…">
        <HeaderSkeleton />
        <RowsSkeleton rows={4} height={88} />
      </div>
    );
  }

  const running = scanning || summary.running;
  const { lastScan, lastCorrection, totals } = summary;
  // Las categorías con trabajo pendiente van primero y en grande; las que están
  // al día se resumen abajo para no competir por la atención.
  const active = summary.categories.filter((category) => category.open > 0);
  const empty = summary.categories.filter((category) => category.open === 0);

  return (
    <>
      <p className="curation-lead">
        El detector recorre todo el catálogo, aprende cómo se escriben sus nombres y agrupa por categoría lo que no
        encaja. Cada corrección guardada lo vuelve a correr para comprobar si arregló el problema o si hizo aparecer otros.
      </p>

      <section className="cscan" aria-live="polite">
        <div className="cscan__status">
          <span className={`cscan__dot${running ? " is-running" : lastScan?.status === "failed" ? " is-failed" : lastScan?.status === "partial" ? " is-partial" : ""}`} aria-hidden="true" />
          <div>
            <p className="cscan__title">
              {running ? "Analizando el catálogo…" : lastScan ? `Último análisis ${relativeTime(lastScan.finishedAt ?? lastScan.startedAt)}` : "Aún no hay análisis"}
            </p>
            {lastScan && !running ? (
              <p className="cscan__meta">
                {triggerLabel(lastScan.trigger)}
                {lastScan.requestedBy ? ` · ${lastScan.requestedBy}` : ""}
                {lastScan.status === "ok" || lastScan.status === "partial" ? ` · ${formatCount(counter(lastScan, "total"))} hallazgos · ${(counter(lastScan, "durationMs") / 1000).toFixed(1)} s` : ""}
                {lastScan.status === "partial" ? ` · parcial: fallaron ${failedDetectors(lastScan).join(", ")}` : ""}
                {lastScan.status === "failed" ? ` · falló: ${lastScan.error ?? "error desconocido"}` : ""}
              </p>
            ) : null}
          </div>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => void scanNow()} disabled={running}>
          <ArrowsClockwise size={16} weight="bold" aria-hidden="true" className={running ? "spin" : undefined} />
          {running ? "Analizando…" : "Analizar ahora"}
        </button>
      </section>

      <CorrectionCheck scan={lastCorrection} chainedOpen={totals.chainedOpen} />

      <AutofixPanorama summary={summary.autofix} />

      <OperationalMetrics metrics={summary.metrics} />

      <dl className="ctotals">
        <div><dt>Abiertos</dt><dd className="mono">{formatCount(totals.open)}</dd></div>
        <div>
          <dt>Nuevos en el último análisis</dt>
          <dd className="mono">
            {lastScan && totals.newInLastScan > 0
              ? <Link className="text-link" to={`/curaduria/hallazgos?scanId=${lastScan.id}`}>{formatCount(totals.newInLastScan)}</Link>
              : formatCount(totals.newInLastScan)}
          </dd>
        </div>
        <div>
          <dt>Surgidos tras corregir</dt>
          <dd className="mono">
            {totals.chainedOpen > 0
              ? <Link className="text-link" to="/curaduria/hallazgos?chained=true">{formatCount(totals.chainedOpen)}</Link>
              : "0"}
          </dd>
        </div>
        <div><dt>Ignorados</dt><dd className="mono">{formatCount(totals.ignored)}</dd></div>
        <div><dt>Resueltos</dt><dd className="mono">{formatCount(totals.resolved)}</dd></div>
      </dl>

      {active.length ? (
        <ul className="ccat-grid">
          {active.map((category) => <li key={category.key}><CategoryCard category={category} /></li>)}
        </ul>
      ) : (
        <p className="ccat-clear"><CheckCircle size={18} weight="bold" aria-hidden="true" /> Ninguna categoría tiene hallazgos abiertos.</p>
      )}

      {empty.length ? (
        <section className="ccat-empty" aria-labelledby="ccat-empty-title">
          <h2 className="ccat-empty__title" id="ccat-empty-title">Sin hallazgos abiertos</h2>
          <ul className="ccat-empty__list">
            {empty.map((category) => {
              const Icon = categoryIcon(category.key);
              return (
                <li key={category.key}>
                  <Link to={`/curaduria/categoria/${category.key}`} className="ccat-mini" title={category.description}>
                    <Icon size={16} weight="bold" aria-hidden="true" />
                    <span>{category.label}</span>
                    <CheckCircle className="ccat-mini__ok" size={15} weight="bold" aria-label="Al día" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <DistinctPairsSection />
    </>
  );
}

function OperationalMetrics({ metrics }: { metrics: CurationMetrics }) {
  const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)} %`;
  const time = metrics.meanCorrectionSeconds === null
    ? "—"
    : metrics.meanCorrectionSeconds < 3600
      ? `${(metrics.meanCorrectionSeconds / 60).toFixed(0)} min`
      : `${(metrics.meanCorrectionSeconds / 3600).toFixed(1)} h`;
  const measured = metrics.detectors.filter((detector) => detector.observedPrecision !== null);

  return (
    <section className="section" aria-labelledby="curation-metrics-title">
      <h2 id="curation-metrics-title">Salud operativa</h2>
      <p className="hint">
        La precisión observada usa decisiones humanas reales; el corpus etiquetado de E2 sigue siendo la prueba de regresión de reglas.
      </p>
      <dl className="ctotals">
        <div><dt>Abiertos con acción ≤ nivel 1</dt><dd className="mono">{percent(metrics.actionCoverage.level1OrLessPct)}</dd></div>
        <div><dt>Abiertos con acción ≤ nivel 2</dt><dd className="mono">{percent(metrics.actionCoverage.level2OrLessPct)}</dd></div>
        <div><dt>Tiempo medio hasta corrección</dt><dd className="mono">{time}</dd></div>
        <div><dt>Lotes deshechos</dt><dd className="mono">{formatCount(metrics.batches.undone)}</dd></div>
        <div><dt>Autocorrecciones revertidas</dt><dd className="mono">{formatCount(metrics.batches.autoReverted)}</dd></div>
      </dl>
      {metrics.alerts.length ? (
        <div className="form-error-banner" role="alert">
          <strong>Precisión observada por debajo de 80 %:</strong>{" "}
          {metrics.alerts.map((alert) => `${alert.label} ${(alert.precision * 100).toFixed(1)} % (${alert.reviewed} decisiones)`).join(" · ")}
        </div>
      ) : null}
      {measured.length ? (
        <details>
          <summary>Precisión observada por detector ({measured.length})</summary>
          <ul style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {measured.map((detector) => (
              <li key={detector.detector} className="credit-row">
                <span>{detector.label}</span>
                <span className="mono">
                  {(detector.observedPrecision! * 100).toFixed(1)} % · {detector.confirmed}/{detector.reviewed} confirmados
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * Lo que la autocorrección hizo hoy (PLAN_CURADURIA E10.4). Solo se muestra si
 * hay algo que contar: correcciones de hoy o una regla que se apagó sola. Lo
 * demás —la lista blanca, quién la tocó— vive en su propia pantalla; aquí está
 * porque el catálogo cambió sin que nadie lo pidiera, y eso se mira en el
 * panorama. El detalle con su deshacer se pide aparte para no cargar el
 * resumen con lo que casi siempre está vacío.
 */
function AutofixPanorama({ summary }: { summary: CurationAutofixSummary }) {
  const interesting = summary.today.batches > 0 || summary.alerts.length > 0;
  const { data, reload } = useAsync(() => (interesting ? curationApi.autofix() : Promise.resolve(null)), [interesting]);
  if (!interesting) return null;

  return (
    <>
      <AutofixAlerts alerts={data?.report.alerts ?? summary.alerts} />
      {data ? <AutofixToday report={data.report} onDone={reload} /> : null}
      <p className="hint">
        <Link className="text-link" to="/curaduria/autocorreccion">Ver qué está autorizado</Link> · las correcciones
        automáticas son de nivel 0 y cada lote se puede deshacer.
      </p>
    </>
  );
}

/**
 * Pares que un curador declaró distintos: el detector de repetidas deja de
 * proponerlos. Un clic retira la declaración y vuelve a permitirlo (E2).
 */
function DistinctPairsSection() {
  const { notify } = useToast();
  const [pairs, setPairs] = useState<DistinctPair[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const page = await curationApi.distinctPairs({ limit: 50 });
      setPairs(page.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los pares declarados.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function retract(pair: DistinctPair) {
    setBusyId(pair.id);
    setError(undefined);
    try {
      await curationApi.retractDistinct(pair.id);
      notify("success", "Declaración retirada: el detector puede volver a proponer el par.");
      setPairs((current) => current?.filter((item) => item.id !== pair.id) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo retirar la declaración.");
    } finally {
      setBusyId(null);
    }
  }

  // Sin declaraciones no hay nada que gestionar: no se muestra la sección.
  if (error && !pairs) return null;
  if (!pairs || pairs.length === 0) return null;

  return (
    <section className="section" aria-labelledby="distinct-pairs-title">
      <h2 id="distinct-pairs-title">Pares declarados distintos <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({pairs.length})</span></h2>
      <p className="hint" style={{ marginTop: 0 }}>
        El detector de repetidas no vuelve a proponerlos, aunque cambien sus nombres. Retirar la declaración lo permite otra vez.
      </p>
      {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
      <ul style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {pairs.map((pair) => {
          const hrefA = pair.kind === "track" ? null : entityHref(pair.kind as "artist" | "person" | "organization" | "album", pair.aId);
          const hrefB = pair.kind === "track" ? null : entityHref(pair.kind as "artist" | "person" | "organization" | "album", pair.bId);
          return (
            <li key={pair.id} className="credit-row">
              <span>
                <NotEquals size={14} weight="bold" aria-hidden="true" style={{ marginRight: 6 }} />
                <span className="badge badge--outline" style={{ marginRight: 6 }}>{ENTITY_KIND_LABEL[pair.kind] ?? pair.kind}</span>
                {hrefA ? <Link to={hrefA}>#{pair.aId}</Link> : <>#{pair.aId}</>}
                {" ↔ "}
                {hrefB ? <Link to={hrefB}>#{pair.bId}</Link> : <>#{pair.bId}</>}
              </span>
              <span className="role hint">
                {pair.decidedBy} · {relativeTime(pair.createdAt)}{pair.note ? ` · ${pair.note}` : ""}
                <button
                  type="button" className="btn btn--sm btn--ghost" style={{ marginLeft: 10 }}
                  onClick={() => void retract(pair)} disabled={busyId === pair.id}
                >
                  {busyId === pair.id ? "Retirando…" : "Volver a proponer"}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CorrectionCheck({ scan, chainedOpen }: { scan: CurationScan | null; chainedOpen: number }) {
  if (!scan) {
    return (
      <section className="ccheck">
        <h2 className="ccheck__title"><CheckCircle size={18} weight="bold" aria-hidden="true" /> Verificación de correcciones</h2>
        <p className="ccheck__empty">
          Todavía no se ha guardado ninguna corrección desde que existe el detector. Cuando edites, fusiones o retires una
          ficha, aquí verás si el cambio resolvió hallazgos o desencadenó otros nuevos.
        </p>
      </section>
    );
  }

  const detail = typeof scan.counters["detail"] === "string" ? scan.counters["detail"] : null;
  const resolved = counter(scan, "resolved");
  const inserted = counter(scan, "inserted") + counter(scan, "reopened");
  const chained = counter(scan, "chained");
  const failed = scan.status === "failed";
  const pending = scan.status === "running";
  // Parcial: lo que miraron los detectores sanos se verificó; lo del detector roto quedó como estaba.
  const partial = scan.status === "partial" ? failedDetectors(scan) : [];
  const tone = failed ? "is-failed" : chained > 0 || partial.length ? "is-warning" : "is-ok";

  return (
    <section className={`ccheck ${tone}`}>
      <div className="ccheck__head">
        <h2 className="ccheck__title">
          <CheckCircle size={18} weight="bold" aria-hidden="true" />
          Última corrección verificada
        </h2>
        <span className="ccheck__when"><Clock size={14} weight="bold" aria-hidden="true" /> {relativeTime(scan.startedAt)}{scan.requestedBy ? ` · ${scan.requestedBy}` : ""}</span>
      </div>
      {detail ? <p className="ccheck__detail mono">{detail}</p> : null}
      {pending ? <p className="ccheck__empty">Verificando la corrección…</p> : failed ? (
        <p className="ccheck__empty">La verificación falló: {scan.error ?? "error desconocido"}.</p>
      ) : (
        <>
          <p className="ccheck__verdict">
            {chained > 0
              ? `La corrección desencadenó ${chained === 1 ? "un hallazgo nuevo" : `${formatCount(chained)} hallazgos nuevos`} en las fichas que tocó.`
              : inserted > 0
                ? "La corrección no desencadenó problemas en las fichas que tocó, aunque el análisis encontró otros en el resto del catálogo."
                : "La corrección no desencadenó problemas nuevos."}
          </p>
          {partial.length ? (
            <p className="ccheck__empty">Verificación parcial: fallaron {partial.join(", ")}. Sus hallazgos no se tocaron.</p>
          ) : null}
          <ul className="ccheck__stats">
            <li className="is-resolved"><strong className="mono">{formatCount(resolved)}</strong> {resolved === 1 ? "resuelto" : "resueltos"}</li>
            <li>
              {inserted > 0
                ? <Link className="text-link" to={`/curaduria/hallazgos?scanId=${scan.id}`}><strong className="mono">{formatCount(inserted)}</strong> {inserted === 1 ? "nuevo" : "nuevos"}</Link>
                : <><strong className="mono">0</strong> nuevos</>}
            </li>
            <li className={chained > 0 ? "is-chained" : undefined}>
              {chained > 0
                ? <Link className="text-link" to={`/curaduria/hallazgos?scanId=${scan.id}&chained=true`}><strong className="mono">{formatCount(chained)}</strong> {chained === 1 ? "desencadenado" : "desencadenados"} por la corrección</Link>
                : <><strong className="mono">0</strong> desencadenados por la corrección</>}
            </li>
          </ul>
        </>
      )}
      {chainedOpen > 0 ? (
        <p className="ccheck__footer">
          <ArrowBendDownRight size={14} weight="bold" aria-hidden="true" />
          <Link className="text-link" to="/curaduria/hallazgos?chained=true">
            {chainedOpen === 1 ? "Queda 1 hallazgo abierto que surgió" : `Quedan ${formatCount(chainedOpen)} hallazgos abiertos que surgieron`} tras corregir
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function CategoryCard({ category }: { category: CurationCategorySummary }) {
  const Icon = categoryIcon(category.key);
  const top = category.detectors.filter((detector) => detector.open > 0).sort((a, b) => b.open - a.open).slice(0, 3);
  const total = category.severity.high + category.severity.medium + category.severity.low;

  return (
    <Link to={`/curaduria/categoria/${category.key}`} className="ccat">
      <div className="ccat__head">
        <span className="ccat__icon"><Icon size={18} weight="bold" aria-hidden="true" /></span>
        <h2 className="ccat__label">{category.label}</h2>
        <span className="ccat__count mono">{formatCount(category.open)}</span>
      </div>
      <p className="ccat__desc">{category.description}</p>
      {total > 0 ? (
        <span className="ccat__bar" role="img" aria-label={`Gravedad: ${category.severity.high} alta, ${category.severity.medium} media, ${category.severity.low} baja`}>
          <span className="ccat__bar-high" style={{ flexGrow: category.severity.high }} />
          <span className="ccat__bar-medium" style={{ flexGrow: category.severity.medium }} />
          <span className="ccat__bar-low" style={{ flexGrow: category.severity.low }} />
        </span>
      ) : null}
      {top.length ? (
        <ul className="ccat__detectors">
          {top.map((detector) => (
            <li key={detector.key}><span>{detector.label}</span><span className="mono">{formatCount(detector.open)}</span></li>
          ))}
        </ul>
      ) : (
        <p className="ccat__none">{category.key === "otros" ? "Nada fuera de lo común por ahora." : "Sin hallazgos abiertos."}</p>
      )}
      {category.newInLastScan > 0 ? (
        <span className="ccat__new"><Sparkle size={13} weight="fill" aria-hidden="true" /> {formatCount(category.newInLastScan)} {category.newInLastScan === 1 ? "nuevo" : "nuevos"} en el último análisis</span>
      ) : null}
    </Link>
  );
}
