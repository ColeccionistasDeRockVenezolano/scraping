// CRV · Curaduría: lo que la autocorrección hizo hoy (PLAN_CURADURIA E10.4).
//
// Se ve en dos sitios y tiene que decir lo mismo en los dos: en el panorama,
// porque algo escribió en el catálogo sin que nadie lo pidiera y eso no puede
// estar escondido en una pantalla aparte; y en la pantalla de autocorrección,
// junto a las reglas que lo autorizaron. El deshacer es el de cualquier lote.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowCounterClockwise, Warning } from "@phosphor-icons/react";
import { curationApi } from "../lib/api";
import { useToast } from "../lib/ToastContext";
import { fixStatusLabel, formatCount, plural, relativeTime } from "../lib/curation";
import { ConfirmDialog } from "./ConfirmDialog";
import type { CurationAutofixAlert, CurationAutofixReport } from "../lib/types";

/** El interruptor de emergencia (E10.3): reglas que se apagaron solas. */
export function AutofixAlerts({ alerts }: { alerts: CurationAutofixAlert[] }) {
  if (!alerts.length) return null;
  return (
    <section className="section" aria-labelledby="autofix-alerts-title">
      <h2 id="autofix-alerts-title"><span><Warning size={15} weight="bold" aria-hidden="true" /> Reglas apagadas por el interruptor de emergencia</span></h2>
      <ul style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {alerts.map((alert) => (
          <li key={`${alert.ruleId ?? "?"}-${alert.at}`} className="form-error-banner" style={{ display: "grid", gap: 4 }}>
            <strong>{alert.detector}{alert.signature ? ` › ${alert.signature}` : ""} › {alert.actionKey}</strong>
            <span>{alert.reason}</span>
            <span className="hint">
              {relativeTime(alert.at)}
              {alert.batchId !== null ? <> · <Link className="text-link" to={`/curaduria/correcciones/${alert.batchId}`}>lote #{alert.batchId}</Link></> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Lo corregido hoy, con su deshacer por lote (E10.4). */
export function AutofixToday({ report, onDone }: { report: CurationAutofixReport; onDone: () => void }) {
  const { notify } = useToast();
  const [undoing, setUndoing] = useState<number | null>(null);
  const { today, batches } = report;

  return (
    <section className="section" aria-labelledby="autofix-today-title">
      <h2 id="autofix-today-title">Autocorrecciones de hoy</h2>
      <dl className="ctotals">
        <div><dt>Lotes</dt><dd className="mono">{formatCount(today.batches)}</dd></div>
        <div><dt>Correcciones aplicadas</dt><dd className="mono">{formatCount(today.applied)}</dd></div>
        <div><dt>Deshechas</dt><dd className="mono">{formatCount(today.undone)}</dd></div>
      </dl>
      {batches.length === 0 ? (
        <p className="hint">Hoy no se ha corregido nada solo.</p>
      ) : (
        <ul className="cfix-list">
          {batches.map((batch) => (
            <li key={batch.batchId}>
              <article className="cfix">
                <div className="cfix__head">
                  <span className="badge">{fixStatusLabel(batch.status)}</span>
                  <Link className="text-link" to={`/curaduria/correcciones/${batch.batchId}`}>Lote #{batch.batchId}</Link>
                  <span className="cfix__when">{relativeTime(batch.at)}</span>
                </div>
                <p className="cfix__filter">{batch.detector}{batch.signature ? ` › ${batch.signature}` : ""} › {batch.actionKey}</p>
                <p className="cfind__note">
                  {plural(batch.applied, "corrección aplicada", "correcciones aplicadas")}
                  {batch.triggered > 0 ? ` · hizo aparecer ${plural(batch.triggered, "hallazgo nuevo", "hallazgos nuevos")}` : ""}
                  {batch.undoneByBatchId !== null ? ` · deshecho por el lote #${batch.undoneByBatchId}` : ""}
                </p>
                {batch.undoneByBatchId === null && batch.applied > 0 ? (
                  <button type="button" className="btn btn--sm" onClick={() => setUndoing(batch.batchId)}>
                    <ArrowCounterClockwise size={15} weight="bold" aria-hidden="true" /> Deshacer el lote
                  </button>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}

      {undoing !== null ? (
        <ConfirmDialog
          title={`¿Deshacer el lote #${undoing}?`}
          description="Se revierte lo que la autocorrección escribió, con un run por corrección. Lo que alguien haya cambiado después queda «no reversible» y el resto se deshace igual."
          confirmLabel="Deshacer el lote"
          danger
          onConfirm={async (note) => {
            const result = await curationApi.fixUndo(undoing, note);
            const undone = typeof result.counts["undone"] === "number" ? result.counts["undone"] : 0;
            notify("success", `${plural(undone, "corrección deshecha", "correcciones deshechas")}.`);
            setUndoing(null);
            onDone();
          }}
          onClose={() => setUndoing(null)}
        />
      ) : null}
    </section>
  );
}

