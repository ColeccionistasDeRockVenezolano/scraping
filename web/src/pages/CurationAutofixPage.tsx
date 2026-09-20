// CRV · Curaduría › Autocorrección (PLAN_CURADURIA E10).
//
// Es la única pantalla desde la que el sistema queda autorizado a escribir en
// el catálogo sin que nadie pulse nada, así que está escrita para que se vea
// de un vistazo qué puede hacer y qué ha hecho:
//
//  - arriba, si el entorno lo permite (`CRV_CURATION_AUTOFIX`): sin eso, todo
//    lo demás es una declaración de intenciones y se dice con todas las letras;
//  - los avisos del interruptor de emergencia: una regla que se apagó sola
//    porque su corrección hizo aparecer hallazgos nuevos;
//  - lo corregido hoy, lote a lote, con su deshacer;
//  - la lista blanca: detector, subgrupo y acción, encender y apagar;
//  - y la auditoría de quién tocó qué regla y cuándo.
//
// Solo las acciones de nivel 0 —deterministas y reversibles— se pueden
// autorizar; la API lo vuelve a comprobar al guardar la regla.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Play, Robot, Trash } from "@phosphor-icons/react";
import { ApiError, curationApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { formatCount, plural, relativeTime } from "../lib/curation";
import { ErrorState, EmptyState } from "../components/StateViews";
import { RowsSkeleton } from "../components/Skeletons";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AutofixAlerts, AutofixToday } from "../components/AutofixToday";
import type { CurationAutofixOption, CurationAutofixRule, CurationAutofixState } from "../lib/types";

const EVENT_LABEL: Readonly<Record<string, string>> = {
  created: "Regla creada", updated: "Regla ajustada", enabled: "Encendida", disabled: "Apagada",
  deleted: "Regla borrada", auto_disabled: "Apagada por el interruptor de emergencia",
  applied: "Correcciones aplicadas", undone: "Lote deshecho",
};

const RUN_MESSAGE: Readonly<Record<string, string>> = {
  apagada: "La autocorrección está apagada en el entorno: no se aplicó nada.",
  sin_reglas: "No hay ninguna regla encendida: no se aplicó nada.",
  sin_candidatos: "No había hallazgos que corregir con las reglas encendidas.",
  tope_diario: "Se alcanzó el tope de correcciones automáticas de hoy.",
  ocupada: "Otro proceso está autocorrigiendo en este momento.",
};

const optionKey = (option: { detector: string; signature: string | null; actionKey: string }): string =>
  `${option.detector}|${option.signature ?? "*"}|${option.actionKey}`;

export function CurationAutofixPage() {
  const { data, loading, error, reload } = useAsync(() => curationApi.autofix(), []);

  if (loading && !data) return <RowsSkeleton rows={6} height={54} label="Cargando la autocorrección…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="No se pudo cargar la autocorrección" hint="Vuelve a intentarlo en unos segundos." />;

  return (
    <>
      <div className="cfind-head">
        <h2><Robot size={20} weight="bold" aria-hidden="true" /> Autocorrección</h2>
        <p className="curation-lead">
          Lo que el sistema puede arreglar solo, sin que nadie pulse nada. Solo correcciones deterministas y reversibles
          (nivel 0), solo lo que se autorice aquí detector a detector, con tope por análisis y por día. Cada pasada deja
          un lote normal que se puede deshacer, y si una corrección hace aparecer hallazgos nuevos el lote se deshace
          solo y la regla queda apagada.
        </p>
      </div>

      <Switch state={data} onDone={reload} />
      <AutofixAlerts alerts={data.report.alerts} />
      <AutofixToday report={data.report} onDone={reload} />
      <Rules state={data} onDone={reload} />
      <NewRule catalog={data.catalog} rules={data.rules} onDone={reload} />
      <Events state={data} />
    </>
  );
}

/** El interruptor del entorno y la pasada manual. */
function Switch({ state, onDone }: { state: CurationAutofixState; onDone: () => void }) {
  const { notify } = useToast();
  const [running, setRunning] = useState(false);
  const { enabled, rules } = state.report;

  async function runNow() {
    setRunning(true);
    try {
      const result = await curationApi.autofixRun();
      const reverted = result.rules.filter((rule) => rule.reverted).length;
      if (result.status === "hecha") {
        notify(reverted ? "info" : "success",
          `${plural(result.applied, "corrección aplicada", "correcciones aplicadas")}`
          + (reverted ? ` · ${plural(reverted, "regla apagada", "reglas apagadas")} por el interruptor de emergencia.` : "."));
      } else {
        notify("info", RUN_MESSAGE[result.status] ?? "No se aplicó nada.");
      }
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo correr la autocorrección.");
    } finally {
      setRunning(false);
      onDone();
    }
  }

  return (
    <section className="cscan" aria-live="polite">
      <div className="cscan__status">
        <span className={`cscan__dot${enabled ? "" : " is-failed"}`} aria-hidden="true" />
        <div>
          <p className="cscan__title">{enabled ? "Autocorrección permitida en este entorno" : "Autocorrección apagada en este entorno"}</p>
          <p className="cscan__meta">
            {enabled
              ? `${plural(rules.active, "regla encendida", "reglas encendidas")} de ${formatCount(rules.total)} · corre al terminar cada análisis completo`
              : "Con CRV_CURATION_AUTOFIX sin poner, las reglas quedan guardadas pero no se aplica nada."}
          </p>
        </div>
      </div>
      <button type="button" className="btn btn--primary" onClick={() => void runNow()} disabled={running || !enabled || rules.active === 0}>
        <Play size={16} weight="bold" aria-hidden="true" />
        {running ? "Corriendo…" : "Correr ahora"}
      </button>
    </section>
  );
}

/** La lista blanca (E10.1). */
function Rules({ state, onDone }: { state: CurationAutofixState; onDone: () => void }) {
  const { notify } = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [removing, setRemoving] = useState<CurationAutofixRule | null>(null);

  async function toggle(rule: CurationAutofixRule) {
    setBusy(rule.id);
    try {
      await curationApi.autofixUpdateRule(rule.id, { enabled: !rule.enabled });
      notify("success", rule.enabled ? "Regla apagada." : "Regla encendida.");
      onDone();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo cambiar la regla.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section" aria-labelledby="autofix-rules-title">
      <h2 id="autofix-rules-title">Lo autorizado</h2>
      {state.rules.length === 0 ? (
        <p className="hint">Todavía no hay ninguna regla: la autocorrección no puede tocar nada.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Reglas de autocorrección</caption>
            <thead>
              <tr>
                <th scope="col">Detector</th>
                <th scope="col">Subgrupo</th>
                <th scope="col">Acción</th>
                <th scope="col">Tope por análisis</th>
                <th scope="col">Estado</th>
                <th scope="col"><span className="visually-hidden">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {state.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.detectorLabel}{rule.note ? <div className="hint">«{rule.note}»</div> : null}</td>
                  <td className="mono">{rule.signature ?? "todos"}</td>
                  <td>{rule.actionLabel}</td>
                  <td className="mono">{rule.maxPerScan === null ? "el del entorno" : formatCount(rule.maxPerScan)}</td>
                  <td>
                    <span className={rule.enabled ? "badge badge--teal" : "badge badge--outline"}>{rule.enabled ? "Encendida" : "Apagada"}</span>
                    {rule.disabledReason ? <div className="hint">{rule.disabledReason}</div> : null}
                    <div className="hint">
                      La creó {rule.createdBy} {relativeTime(rule.createdAt)}
                      {rule.updatedBy ? ` · la tocó ${rule.updatedBy}${rule.updatedAt ? ` ${relativeTime(rule.updatedAt)}` : ""}` : ""}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" className="btn btn--sm" disabled={busy === rule.id} onClick={() => void toggle(rule)}>
                        {rule.enabled ? "Apagar" : "Encender"}
                      </button>
                      <button type="button" className="btn btn--sm btn--danger" disabled={busy === rule.id} onClick={() => setRemoving(rule)}>
                        <Trash size={15} weight="bold" aria-hidden="true" /> Quitar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {removing ? (
        <ConfirmDialog
          title="¿Quitar la regla?"
          description="La autocorrección dejará de aplicar esa acción. Lo ya corregido sigue en el historial de correcciones con su deshacer."
          confirmLabel="Quitar la regla"
          danger
          requireNote={false}
          onConfirm={async () => {
            await curationApi.autofixDeleteRule(removing.id);
            notify("success", "Regla quitada.");
            setRemoving(null);
            onDone();
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}

/** Autorizar una combinación nueva: solo las que la API admite (nivel 0). */
function NewRule({ catalog, rules, onDone }: { catalog: CurationAutofixOption[]; rules: CurationAutofixRule[]; onDone: () => void }) {
  const { notify } = useToast();
  const taken = new Set(rules.map(optionKey));
  const free = catalog.filter((option) => !taken.has(optionKey(option)));
  const [selected, setSelected] = useState("");
  const [maxPerScan, setMaxPerScan] = useState("");
  const [note, setNote] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const option = free.find((item) => optionKey(item) === selected);

  async function submit() {
    if (!option) { setError("Elige qué se autoriza."); return; }
    setSaving(true);
    setError(undefined);
    try {
      await curationApi.autofixCreateRule({
        detector: option.detector, signature: option.signature, actionKey: option.actionKey, enabled,
        ...(maxPerScan.trim() ? { maxPerScan: Number(maxPerScan) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      notify("success", enabled ? "Regla creada y encendida." : "Regla creada; enciéndela cuando quieras.");
      setSelected(""); setMaxPerScan(""); setNote(""); setEnabled(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear la regla.");
    } finally {
      setSaving(false);
    }
  }

  if (!free.length) return null;

  return (
    <section className="section" aria-labelledby="autofix-new-title">
      <h2 id="autofix-new-title">Autorizar una corrección</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Solo aparecen las acciones deterministas y reversibles que cada detector propone. Una regla nace apagada salvo
        que se diga lo contrario, y todo cambio queda en la auditoría de abajo.
      </p>
      <div className="field">
        <label htmlFor="autofix-option">Qué se autoriza *</label>
        <select id="autofix-option" className="filter-input" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Elegir…</option>
          {free.map((item) => (
            <option key={optionKey(item)} value={optionKey(item)}>
              {item.detectorLabel}{item.signature ? ` › ${item.signature}` : ""} › {item.actionLabel}
            </option>
          ))}
        </select>
        {option ? <p className="hint">{option.actionDescription}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="autofix-max">Tope por análisis</label>
        <input id="autofix-max" className="filter-input" type="number" min={1} max={5000} value={maxPerScan}
          onChange={(event) => setMaxPerScan(event.target.value)} placeholder="En blanco: el del entorno" />
      </div>
      <div className="field">
        <label htmlFor="autofix-note">Por qué se autoriza</label>
        <textarea id="autofix-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
          placeholder="Queda en la auditoría junto a quién la creó" />
      </div>
      <div className="checkbox-field">
        <input id="autofix-enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <label htmlFor="autofix-enabled">Encenderla ya</label>
      </div>
      {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={saving || !selected}>
          {saving ? "Guardando…" : "Autorizar"}
        </button>
      </div>
    </section>
  );
}

/** Quién tocó qué y cuándo (E10.1). */
function Events({ state }: { state: CurationAutofixState }) {
  if (!state.events.length) return null;
  return (
    <section className="section" aria-labelledby="autofix-events-title">
      <h2 id="autofix-events-title">Auditoría</h2>
      <ul className="cfix-list">
        {state.events.map((event) => (
          <li key={event.id}>
            <article className="cfix">
              <div className="cfix__head">
                <span className="badge badge--outline">{EVENT_LABEL[event.event] ?? event.event}</span>
                <span className="cfix__filter">{event.detector}{event.signature ? ` › ${event.signature}` : ""} › {event.actionKey}</span>
                <span className="cfix__when">{relativeTime(event.at)}</span>
              </div>
              <p className="cfind__note">
                {event.operator}
                {event.batchId !== null ? <> · <Link className="text-link" to={`/curaduria/correcciones/${event.batchId}`}>lote #{event.batchId}</Link></> : null}
                {event.note ? ` · «${event.note}»` : ""}
              </p>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
