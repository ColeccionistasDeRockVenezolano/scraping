// CRV · Curaduría › una categoría del detector de conflictos.
//
// Los detectores y subgrupos de la categoría salen del resumen de la API: si
// el detector aprende un subgrupo nuevo, aparece aquí como un filtro más sin
// tocar la web. Sin `:key` la página lista hallazgos de todas las categorías
// (la usan los enlaces «nuevos en este análisis» y «surgidos tras corregir»).
//
// Ignorar no cambia el catálogo: solo le dice al detector que ese caso no es un
// problema. Mientras el valor no cambie, no se vuelve a abrir.
import { useEffect, useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowBendDownRight, ArrowCounterClockwise, ArrowSquareOut, CaretDown, CaretUp, EyeSlash, GitMerge, Lightbulb,
  Sparkle, Trash, Wrench,
} from "@phosphor-icons/react";
import {
  albumWrites, artistWrites, ApiError, curationApi, organizationWrites, personWrites, trackWrites, type CurationFindingQuery,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import {
  ENTITY_KIND_LABEL, SEVERITY_BADGE, SEVERITY_LABEL, categoryIcon, fieldLabel, formatCount, refHref, relativeTime, resolutionText,
} from "../lib/curation";
import { ErrorState, EmptyState, LoadingState } from "../components/StateViews";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CurationValue } from "../components/CurationValue";
import { Modal } from "../components/Modal";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { useCurationSummary } from "./CurationLayout";
import type {
  CurationCategorySummary, CurationFinding, CurationFindingStatus, CurationSeverity, CurationSignatureSummary, MergeableKind,
} from "../lib/types";

const LIMIT = 25;
/** Campos con valor determinista: los únicos que la herramienta de corrección puede aplicar de un clic (src/curation/repository.ts). */
const FIXABLE_FIELDS = new Set(["name", "title"]);
const MERGEABLE_KINDS = new Set<string>(["person", "organization", "artist"]);
const ENTITY_WRITE_API: Readonly<Record<string, { remove: (id: number, note?: string) => Promise<unknown> }>> = {
  artist: artistWrites, person: personWrites, organization: organizationWrites, album: albumWrites, track: trackWrites,
};
const STATUSES: Array<{ value: CurationFindingStatus | "all"; label: string }> = [
  { value: "open", label: "Abiertos" },
  { value: "ignored", label: "Ignorados" },
  { value: "resolved", label: "Resueltos" },
  { value: "all", label: "Todos" },
];
const SEVERITIES: CurationSeverity[] = ["high", "medium", "low"];
/** Evidencia que ya se muestra de otra forma. */
const HIDDEN_EVIDENCE = new Set(["span", "signatureLabel", "triggeredBy", "triggeredInScan"]);

export function CurationFindingsPage() {
  const { key } = useParams();
  const { summary, summaryError, refreshSummary } = useCurationSummary();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const [ignoringGroup, setIgnoringGroup] = useState(false);
  const [fixingGroup, setFixingGroup] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [fixingFinding, setFixingFinding] = useState<CurationFinding | null>(null);
  const [mergingFinding, setMergingFinding] = useState<{ finding: CurationFinding; kind: MergeableKind; otherId?: number; otherName?: string } | null>(null);
  const [deletingFinding, setDeletingFinding] = useState<CurationFinding | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fixingSelected, setFixingSelected] = useState(false);

  const detector = params.get("detector") ?? "";
  const signature = params.get("signature") ?? "";
  const severity = (params.get("severity") ?? "") as CurationSeverity | "";
  const entityKind = params.get("entityKind") ?? "";
  const status = (params.get("status") ?? "open") as CurationFindingStatus | "all";
  const q = params.get("q") ?? "";
  const scanId = Number(params.get("scanId") ?? "") || undefined;
  const chained = params.get("chained") === "true";
  const offset = Number(params.get("offset") ?? "0") || 0;
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const category = key ? summary?.categories.find((item) => item.key === key) : undefined;
  const lastScanId = summary?.lastScan?.id ?? 0;

  const query: CurationFindingQuery = {
    limit: LIMIT, offset, status,
    ...(key ? { category: key } : {}),
    ...(detector ? { detector } : {}),
    ...(signature ? { signature } : {}),
    ...(severity ? { severity } : {}),
    ...(entityKind ? { entityKind } : {}),
    ...(q ? { q } : {}),
    ...(scanId ? { scanId } : {}),
    ...(chained ? { chained: true } : {}),
  };
  const { data, loading, error, reload } = useAsync(
    () => curationApi.findings(query),
    // El último análisis entra en las dependencias: si una corrección vuelve a
    // analizar el catálogo, la lista se actualiza sola.
    [key, detector, signature, severity, entityKind, status, q, scanId, chained, offset, lastScanId],
  );

  // La selección se ancla a la página/filtro actual: si cambian, ya no
  // corresponde a lo que se ve en pantalla.
  useEffect(() => setSelected(new Set()), [key, detector, signature, severity, entityKind, status, q, scanId, chained, offset]);

  function toggleSelected(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value); else next.delete(name);
    }
    if (!("offset" in changes)) next.delete("offset");
    setParams(next);
  }

  async function act(finding: CurationFinding, action: "ignore" | "reopen") {
    setBusyId(finding.id);
    try {
      if (action === "ignore") {
        await curationApi.ignore(finding.id, "");
        notify("success", "Hallazgo ignorado. No se volverá a abrir mientras el valor no cambie.");
      } else {
        await curationApi.reopen(finding.id);
        notify("success", "Hallazgo reabierto.");
      }
      reload();
      void refreshSummary();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo guardar la decisión.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteFinding(finding: CurationFinding, note: string) {
    const api = finding.entity.kind ? ENTITY_WRITE_API[finding.entity.kind] : undefined;
    if (!api || finding.entity.id === null) throw new Error("Esta ficha no se puede eliminar desde aquí.");
    await api.remove(finding.entity.id, note);
    notify("success", `«${finding.entity.label}» se eliminó del catálogo.`);
    setDeletingFinding(null);
    reload();
    void refreshSummary();
  }

  if (key && !summary) {
    return summaryError ? <ErrorState message={summaryError} onRetry={() => void refreshSummary()} /> : <LoadingState />;
  }
  if (key && summary && !category) {
    return <EmptyState title="Esa categoría no existe" hint="Elige una categoría del menú de Curaduría." />;
  }

  // Con un solo detector con hallazgos (p. ej. «Otros») sus subgrupos se
  // muestran de entrada: son la única forma útil de partir la categoría.
  const openDetectors = category?.detectors.filter((item) => item.open > 0) ?? [];
  const activeDetector = category?.detectors.find((item) => item.key === detector)
    ?? (openDetectors.length === 1 ? openDetectors[0] : undefined);
  const signatures = activeDetector?.signatures ?? [];

  return (
    <>
      <FindingsHeader category={category} scanId={scanId} chained={chained} />

      {category ? (
        <div className="cfilters" role="group" aria-label="Filtrar por detector">
          <button type="button" className="cchip" aria-pressed={!detector} onClick={() => update({ detector: null, signature: null })}>
            Todos <span className="mono">{formatCount(category.open)}</span>
          </button>
          {category.detectors.filter((item) => item.open > 0 || item.key === detector).map((item) => (
            <button
              key={item.key} type="button" className="cchip" aria-pressed={detector === item.key} title={item.description}
              onClick={() => update({ detector: item.key, signature: null })}
            >
              {item.label} <span className="mono">{formatCount(item.open)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {signatures.length > 1 ? (
        // La clave reinicia cuántos subgrupos se ven al cambiar de detector.
        <SignatureFilter key={`${key ?? ""}:${activeDetector?.key ?? ""}`} signatures={signatures} selected={signature}
          onSelect={(value) => update({ signature: value })} />
      ) : null}

      <div className="list-toolbar">
        <form className="cfind-search" role="search" onSubmit={(event) => { event.preventDefault(); update({ q: search.trim() || null }); }}>
          <label className="visually-hidden" htmlFor="cfind-q">Buscar en los hallazgos</label>
          <input id="cfind-q" className="filter-input" type="search" value={search} placeholder="Buscar nombre o valor…"
            onChange={(event) => setSearch(event.target.value)} />
        </form>
        <div className="cfind-selects">
          <label className="visually-hidden" htmlFor="cfind-severity">Gravedad</label>
          <select id="cfind-severity" className="filter-input" value={severity} onChange={(event) => update({ severity: event.target.value || null })}>
            <option value="">Toda gravedad</option>
            {SEVERITIES.map((value) => <option key={value} value={value}>Gravedad {SEVERITY_LABEL[value].toLowerCase()}</option>)}
          </select>
          <label className="visually-hidden" htmlFor="cfind-kind">Tipo de ficha</label>
          <select id="cfind-kind" className="filter-input" value={entityKind} onChange={(event) => update({ entityKind: event.target.value || null })}>
            <option value="">Todo tipo de ficha</option>
            {Object.entries(ENTITY_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <div className="segmented" role="group" aria-label="Estado">
            {STATUSES.map((item) => (
              <button key={item.value} type="button" className="segmented__option" aria-pressed={status === item.value}
                onClick={() => update({ status: item.value === "open" ? null : item.value })}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="cfind-count">
        {data && !loading ? (
          <p aria-live="polite">{data.pagination.total === 1 ? "1 hallazgo" : `${formatCount(data.pagination.total)} hallazgos`}</p>
        ) : <span />}
        {category && activeDetector && status === "open" && data && data.pagination.total > 0 ? (
          <div className="cfind-count__actions">
            <button type="button" className="btn btn--sm btn--outline" onClick={() => setFixingGroup(true)}>
              <Wrench size={14} weight="bold" aria-hidden="true" />
              Corregir {signature ? "este subgrupo" : "este detector"}
            </button>
            <button type="button" className="btn btn--sm btn--outline" onClick={() => setIgnoringGroup(true)}>
              <EyeSlash size={14} weight="bold" aria-hidden="true" />
              Ignorar {signature ? "este subgrupo" : "este detector"}
            </button>
          </div>
        ) : null}
      </div>

      {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
        <EmptyState
          title={status === "open" ? "No hay hallazgos abiertos aquí" : "No hay hallazgos con estos filtros"}
          hint={status === "open" ? "El detector no encontró problemas de este tipo en el último análisis." : "Prueba con otros filtros."}
        />
      ) : (
        <>
          <ol className={`cfind-list${loading ? " is-refreshing" : ""}`}>
            {data.data.map((finding) => (
              <li key={finding.id}>
                <FindingCard finding={finding} busy={busyId === finding.id}
                  categoryLabel={key ? undefined : summary?.categories.find((item) => item.key === finding.category)?.label ?? "Otros"}
                  onIgnore={() => void act(finding, "ignore")} onReopen={() => void act(finding, "reopen")}
                  selected={selected.has(finding.id)} onToggleSelected={() => toggleSelected(finding.id)}
                  onFix={FIXABLE_FIELDS.has(finding.field ?? "") && finding.entity.id !== null ? () => setFixingFinding(finding) : undefined}
                  onMerge={finding.category === "fichas_repetidas" && MERGEABLE_KINDS.has(finding.entity.kind) && finding.entity.id !== null
                    ? () => {
                      const other = finding.related.find((ref) => ref.kind === finding.entity.kind && ref.id !== null && ref.id !== finding.entity.id);
                      setMergingFinding({
                        finding, kind: finding.entity.kind as MergeableKind,
                        ...(other?.id ? { otherId: other.id, otherName: other.label } : {}),
                      });
                    }
                    : undefined}
                  onDelete={finding.category === "fichas_sin_vinculos" && finding.entity.id !== null && ENTITY_WRITE_API[finding.entity.kind]
                    ? () => setDeletingFinding(finding)
                    : undefined}
                />
              </li>
            ))}
          </ol>
          <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={(next) => update({ offset: String(next) })} />
        </>
      )}

      {selected.size > 0 ? (
        <div className="csel-toolbar" role="toolbar" aria-label="Acciones sobre lo seleccionado">
          <span className="csel-toolbar__count">{formatCount(selected.size)} seleccionado{selected.size === 1 ? "" : "s"}</span>
          <div className="csel-toolbar__actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setFixingSelected(true)}>
              <Wrench size={14} weight="bold" aria-hidden="true" /> Corregir seleccionados
            </button>
            <button type="button" className="btn btn--sm btn--outline" onClick={() => setSelected(new Set())}>
              Vaciar selección
            </button>
          </div>
        </div>
      ) : null}

      {ignoringGroup && category ? (
        <ConfirmDialog
          title={`¿Ignorar ${signature ? "este subgrupo" : "este detector"}?`}
          description={`Los ${formatCount(data?.pagination.total ?? 0)} hallazgos abiertos de «${activeDetector?.label ?? detector}»${signature ? ` › «${signatures.find((item) => item.key === signature)?.label ?? signature}»` : ""} se marcarán como «no es un problema». El catálogo no cambia y cada caso se puede reabrir.`}
          confirmLabel="Ignorar el grupo"
          onConfirm={async (note) => {
            const result = await curationApi.ignoreGroup({ category: category.key, detector: activeDetector?.key ?? detector, ...(signature ? { signature } : {}), note });
            notify("success", `${formatCount(result.ignored)} hallazgos ignorados.`);
            setIgnoringGroup(false);
            reload();
            void refreshSummary();
          }}
          onClose={() => setIgnoringGroup(false)}
        />
      ) : null}

      {fixingGroup && category ? (
        <ConfirmDialog
          title={`¿Corregir ${signature ? "este subgrupo" : "este detector"}?`}
          description={`Se aplicará a cada hallazgo abierto y corregible de «${activeDetector?.label ?? detector}»${signature ? ` › «${signatures.find((item) => item.key === signature)?.label ?? signature}»` : ""} su valor sugerido (hasta 500 de una vez). Los que no tengan una corrección determinista quedan sin tocar.`}
          confirmLabel="Corregir el grupo"
          onConfirm={async (note) => {
            const result = await curationApi.fixGroup({ category: category.key, detector: activeDetector?.key ?? detector, ...(signature ? { signature } : {}), note });
            notify("success", `${formatCount(result.fixed)} hallazgos corregidos${result.failed ? `, ${formatCount(result.failed)} no se pudieron corregir` : ""}${result.more ? " (había más de 500; repite la acción para seguir)" : ""}.`);
            setFixingGroup(false);
            reload();
            void refreshSummary();
          }}
          onClose={() => setFixingGroup(false)}
        />
      ) : null}

      {fixingSelected ? (
        <ConfirmDialog
          title="¿Corregir los hallazgos seleccionados?"
          description={`Se aplicará a cada uno de los ${formatCount(selected.size)} hallazgos seleccionados su valor sugerido. Los que no tengan uno quedan reportados sin tocar.`}
          confirmLabel="Corregir seleccionados"
          onConfirm={async (note) => {
            const result = await curationApi.fixSelected([...selected], note);
            notify("success", `${formatCount(result.fixed)} hallazgos corregidos${result.failed ? `, ${formatCount(result.failed)} no se pudieron corregir` : ""}.`);
            setFixingSelected(false);
            setSelected(new Set());
            reload();
            void refreshSummary();
          }}
          onClose={() => setFixingSelected(false)}
        />
      ) : null}

      {fixingFinding ? (
        <FixValueDialog
          finding={fixingFinding}
          onFixed={() => { setFixingFinding(null); notify("success", "Hallazgo corregido."); reload(); void refreshSummary(); }}
          onClose={() => setFixingFinding(null)}
        />
      ) : null}

      {mergingFinding ? (
        <MergeEntityModal
          kind={mergingFinding.kind}
          entityId={mergingFinding.finding.entity.id!}
          entityName={mergingFinding.finding.entity.label}
          {...(mergingFinding.otherId ? { otherId: mergingFinding.otherId, otherName: mergingFinding.otherName ?? "" } : {})}
          onMerged={() => { setMergingFinding(null); notify("success", "Fichas fusionadas."); reload(); void refreshSummary(); }}
          onClose={() => setMergingFinding(null)}
        />
      ) : null}

      {deletingFinding ? (
        <ConfirmDialog
          title="¿Eliminar esta ficha?"
          description={`«${deletingFinding.entity.label}» no tiene vínculos con el catálogo. Se eliminará por completo; esta acción no se puede deshacer desde aquí.`}
          confirmLabel="Eliminar ficha"
          danger
          onConfirm={(note) => deleteFinding(deletingFinding, note)}
          onClose={() => setDeletingFinding(null)}
        />
      ) : null}
    </>
  );
}

/** Corrección de un hallazgo con un valor editable (por defecto, el sugerido por el detector). */
function FixValueDialog({ finding, onFixed, onClose }: {
  finding: CurationFinding; onFixed: (updated: CurationFinding) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(finding.suggestedValue ?? finding.value ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    if (!value.trim()) { setError("El valor no puede quedar vacío."); return; }
    if (!note.trim()) { setError("La nota es obligatoria."); return; }
    setBusy(true);
    setError(undefined);
    try {
      const updated = await curationApi.fix(finding.id, note.trim(), value.trim());
      onFixed(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo corregir el hallazgo.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Corregir hallazgo" onClose={onClose}>
      <p style={{ color: "var(--text-muted)", fontSize: 13.5, margin: "0 0 14px" }}>
        Se aplicará este valor al campo «{fieldLabel(finding.field ?? "")}» de «{finding.entity.label}».
      </p>
      <div className="field">
        <label htmlFor="fix-value">Valor corregido *</label>
        <input id="fix-value" type="text" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="fix-note">Motivo *</label>
        <textarea
          id="fix-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)}
          placeholder="Por qué se corrige (queda en la auditoría)"
        />
      </div>
      {error ? <p className="form-error-banner" style={{ marginTop: 12 }} role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>{busy ? "Guardando…" : "Corregir"}</button>
      </div>
    </Modal>
  );
}

/** Subgrupos visibles de entrada y cuántos más muestra cada «Ver más». */
const SIGNATURES_INITIAL = 6;
const SIGNATURES_STEP = 12;

/**
 * Filtro por subgrupo. «Otros» puede tener decenas (un signo raro por campo):
 * se muestran los más frecuentes y el resto se despliega por tandas, sin
 * empujar la lista de hallazgos fuera de la pantalla.
 */
function SignatureFilter({ signatures, selected, onSelect }: {
  signatures: CurationSignatureSummary[]; selected: string; onSelect: (value: string | null) => void;
}) {
  const [visible, setVisible] = useState(SIGNATURES_INITIAL);
  const [revealFrom, setRevealFrom] = useState(signatures.length);
  const listId = useId();

  const shown = signatures.slice(0, visible);
  // El subgrupo elegido siempre queda a la vista, aunque esté más abajo.
  const selectedIndex = signatures.findIndex((item) => item.key === selected);
  const pinned = selectedIndex >= visible;
  if (pinned) shown.push(signatures[selectedIndex]!);
  const hidden = Math.max(signatures.length - visible - (pinned ? 1 : 0), 0);
  const next = Math.min(SIGNATURES_STEP, hidden);

  return (
    <div className="csub">
      <p className="csub__label">
        Subgrupos <span className="mono">{formatCount(signatures.length)}</span>
      </p>
      <div className="cfilters cfilters--sub" role="group" aria-label="Filtrar por subgrupo" id={listId}>
        <button type="button" className="cchip cchip--sub" aria-pressed={!selected} onClick={() => onSelect(null)}>
          Todos los subgrupos
        </button>
        {shown.map((item, index) => (
          <button
            key={item.key} type="button" className={`cchip cchip--sub${index >= revealFrom ? " is-revealed" : ""}`}
            style={index >= revealFrom ? { animationDelay: `${Math.min(index - revealFrom, 11) * 22}ms` } : undefined}
            aria-pressed={selected === item.key} title={item.label}
            onClick={() => onSelect(item.key)}
          >
            <span className="cchip__text">{item.label}</span> <span className="mono">{formatCount(item.open)}</span>
          </button>
        ))}
        {hidden > 0 ? (
          <button type="button" className="cchip cchip--more" aria-controls={listId}
            onClick={() => { setRevealFrom(shown.length); setVisible(visible + next); }}>
            <CaretDown size={12} weight="bold" aria-hidden="true" />
            Ver {formatCount(next)} más
            {hidden > next ? <span className="mono">de {formatCount(hidden)}</span> : null}
          </button>
        ) : visible > SIGNATURES_INITIAL ? (
          <button type="button" className="cchip cchip--more" aria-controls={listId}
            onClick={() => { setRevealFrom(signatures.length); setVisible(SIGNATURES_INITIAL); }}>
            <CaretUp size={12} weight="bold" aria-hidden="true" />
            Ver menos
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FindingsHeader({ category, scanId, chained }: { category: CurationCategorySummary | undefined; scanId: number | undefined; chained: boolean }) {
  if (category) {
    const Icon = categoryIcon(category.key);
    return (
      <div className="cfind-head">
        <h2><Icon size={20} weight="bold" aria-hidden="true" /> {category.label}</h2>
        <p className="curation-lead">{category.description}</p>
      </div>
    );
  }
  const title = chained && scanId ? `Desencadenados por la corrección del análisis #${scanId}`
    : chained ? "Surgidos tras corregir"
      : scanId ? `Aparecidos en el análisis #${scanId}` : "Todos los hallazgos";
  return (
    <div className="cfind-head">
      <Link to="/curaduria" className="back-link">← Conflictos</Link>
      <h2>{title}</h2>
      <p className="curation-lead">
        {chained
          ? "Hallazgos que aparecieron en las mismas fichas donde una corrección acababa de resolver otro. Revísalos: la corrección pudo dejar el dato a medias."
          : "Hallazgos de todas las categorías."}
      </p>
    </div>
  );
}

function FindingCard({ finding, categoryLabel, busy, onIgnore, onReopen, selected, onToggleSelected, onFix, onMerge, onDelete }: {
  finding: CurationFinding; categoryLabel: string | undefined; busy: boolean; onIgnore: () => void; onReopen: () => void;
  selected: boolean; onToggleSelected: () => void;
  onFix: (() => void) | undefined; onMerge: (() => void) | undefined; onDelete: (() => void) | undefined;
}) {
  const entityLink = refHref(finding.entity, finding);
  const related = finding.related.filter((ref) => !(ref.kind === finding.entity.kind && ref.id === finding.entity.id));
  const evidence = Object.entries(finding.evidence).filter(([name]) => !HIDDEN_EVIDENCE.has(name));

  return (
    <article className={`cfind cfind--${finding.severity}${finding.status !== "open" ? " is-closed" : ""}${selected ? " cfind--picked" : ""}`}>
      <div className="cfind__badges">
        {finding.status === "open" ? (
          <label className="visually-hidden" htmlFor={`cfind-pick-${finding.id}`}>Seleccionar este hallazgo</label>
        ) : null}
        {finding.status === "open" ? (
          <input id={`cfind-pick-${finding.id}`} type="checkbox" checked={selected} onChange={onToggleSelected} />
        ) : null}
        <span className={`badge ${SEVERITY_BADGE[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <span className="badge badge--outline">{ENTITY_KIND_LABEL[finding.entity.kind] ?? finding.entity.kind}</span>
        {finding.isNew && finding.status === "open" ? <span className="badge badge--violet"><Sparkle size={11} weight="fill" aria-hidden="true" /> Nuevo</span> : null}
        {finding.status === "ignored" ? <span className="badge">Ignorado</span> : null}
        {finding.status === "resolved" ? <span className="badge badge--teal">Resuelto</span> : null}
        <span className="cfind__detector">
          {categoryLabel ? `${categoryLabel} › ` : ""}{finding.detectorLabel}
          {finding.signatureLabel !== finding.detectorLabel ? ` › ${finding.signatureLabel}` : ""}
        </span>
      </div>

      <h3 className="cfind__title">{finding.title}</h3>

      {finding.value !== null ? (
        <p className="cfind__value">
          {finding.field ? <span className="cfind__field">{fieldLabel(finding.field)}</span> : null}
          <CurationValue value={finding.value} evidence={finding.evidence} />
        </p>
      ) : null}

      {finding.suggestion ? (
        <p className="cfind__suggestion"><Lightbulb size={15} weight="bold" aria-hidden="true" /> {finding.suggestion}</p>
      ) : null}

      {finding.triggeredBy.length ? (
        <div className="cfind__chain">
          <ArrowBendDownRight size={15} weight="bold" aria-hidden="true" />
          <span>
            Apareció al corregir:{" "}
            {finding.triggeredBy.map((cause, index) => (
              <span key={cause.id}>{index ? " · " : ""}«{cause.title}»</span>
            ))}
          </span>
        </div>
      ) : null}

      <div className="cfind__refs">
        {entityLink ? (
          <Link className="text-link" to={entityLink} target="_blank" rel="noopener">
            {finding.entity.label || `#${finding.entity.id}`}
            <ArrowSquareOut size={13} weight="bold" aria-hidden="true" />
            <span className="visually-hidden"> (abre la ficha en otra pestaña)</span>
          </Link>
        ) : <span>{finding.entity.label}</span>}
        {finding.entity.id !== null ? <span className="mono cfind__id">#{finding.entity.id}</span> : null}
        {related.length ? (
          <span className="cfind__related">
            <span className="cfind__related-label">Relacionadas:</span>
            {related.slice(0, 8).map((ref) => {
              const href = refHref(ref, finding);
              const label = ref.label || `${ENTITY_KIND_LABEL[ref.kind] ?? ref.kind} #${ref.id ?? "?"}`;
              return href
                ? <Link key={`${ref.kind}-${ref.id}`} className="text-link" to={href} target="_blank" rel="noopener">{label}</Link>
                : <span key={`${ref.kind}-${ref.id}-${ref.label}`}>{label}</span>;
            })}
            {related.length > 8 ? <span>y {related.length - 8} más</span> : null}
          </span>
        ) : null}
      </div>

      {finding.status === "resolved" && resolutionText(finding) ? (
        <p className="cfind__note">
          {resolutionText(finding)}{finding.resolvedAt ? ` ${relativeTime(finding.resolvedAt)}` : ""}
        </p>
      ) : null}

      {finding.status === "ignored" && (finding.ignoredBy || finding.ignoreNote) ? (
        <p className="cfind__note">
          Ignorado{finding.ignoredBy ? ` por ${finding.ignoredBy}` : ""}{finding.ignoredAt ? ` ${relativeTime(finding.ignoredAt)}` : ""}
          {finding.ignoreNote ? `: ${finding.ignoreNote}` : ""}
        </p>
      ) : null}

      <div className="cfind__foot">
        {evidence.length ? (
          <details className="cfind__evidence">
            <summary>Evidencia <CaretDown size={12} weight="bold" aria-hidden="true" /></summary>
            <pre className="evidence-block">{JSON.stringify(Object.fromEntries(evidence), null, 2)}</pre>
          </details>
        ) : <span />}
        <div className="cfind__actions">
          {finding.status === "open" && onFix ? (
            <button type="button" className="btn btn--sm btn--primary" onClick={onFix} disabled={busy}
              title="Aplicar la corrección a la ficha">
              <Wrench size={14} weight="bold" aria-hidden="true" /> Corregir
            </button>
          ) : null}
          {finding.status === "open" && onMerge ? (
            <button type="button" className="btn btn--sm btn--outline" onClick={onMerge} disabled={busy}
              title="Fusionar con la ficha repetida">
              <GitMerge size={14} weight="bold" aria-hidden="true" /> Fusionar
            </button>
          ) : null}
          {finding.status === "open" && onDelete ? (
            <button type="button" className="btn btn--sm btn--outline" onClick={onDelete} disabled={busy}
              title="Eliminar esta ficha sin vínculos">
              <Trash size={14} weight="bold" aria-hidden="true" /> Eliminar ficha
            </button>
          ) : null}
          {finding.status === "open" ? (
            <button type="button" className="btn btn--sm btn--outline" onClick={onIgnore} disabled={busy}
              title="No es un problema: el detector no lo vuelve a abrir mientras el valor no cambie">
              <EyeSlash size={14} weight="bold" aria-hidden="true" /> No es un problema
            </button>
          ) : finding.status === "ignored" ? (
            <button type="button" className="btn btn--sm btn--outline" onClick={onReopen} disabled={busy}>
              <ArrowCounterClockwise size={14} weight="bold" aria-hidden="true" /> Reabrir
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
