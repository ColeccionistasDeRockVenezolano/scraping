// CRV · Curaduría › una categoría del detector de conflictos.
//
// Los detectores y subgrupos de la categoría salen del resumen de la API: si
// el detector aprende un subgrupo nuevo, aparece aquí como un filtro más sin
// tocar la web. Sin `:key` la página lista hallazgos de todas las categorías
// (la usan los enlaces «nuevos en este análisis» y «surgidos tras corregir»).
//
// Ignorar no cambia el catálogo: solo le dice al detector que ese caso no es un
// problema, con un motivo (falso positivo, correcto a propósito, fuera de
// alcance). Dura mientras el detector lo siga viendo; si el problema desaparece,
// el hallazgo pasa a resuelto. «Son distintas» hace lo mismo para un par de
// fichas repetidas, y sobrevive aunque cambie el grupo.
import { useEffect, useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowBendDownRight, ArrowCounterClockwise, ArrowSquareOut, CaretDown, CaretUp, ClockCounterClockwise, EyeSlash, GitMerge, Lightbulb,
  NotEquals, Sparkle, Trash, Wrench,
} from "@phosphor-icons/react";
import {
  albumWrites, artistWrites, ApiError, curationApi, organizationWrites, personWrites, trackWrites,
  type CurationFindingGroupFilter, type CurationFindingQuery,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import {
  ENTITY_KIND_LABEL, IGNORE_REASONS, SEVERITY_BADGE, SEVERITY_LABEL, categoryIcon, fieldLabel, findingPair, formatCount, ignoreReasonLabel,
  lastChangeText, refHref, relativeTime, resolutionText,
} from "../lib/curation";
import { ErrorState, EmptyState } from "../components/StateViews";
import { HeaderSkeleton, RowsSkeleton } from "../components/Skeletons";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CurationValue } from "../components/CurationValue";
import { CurationDecisionPanel } from "../components/CurationDecisionPanel";
import { CurationEvidence } from "../components/CurationEvidence";
import { FixBatchDialog } from "../components/FixBatchDialog";
import { TrustedConflictDialog } from "../components/TrustedConflictDialog";
import { Modal } from "../components/Modal";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { useCurationSummary } from "./CurationLayout";
import type {
  CurationCategorySummary, CurationFinding, CurationFindingStatus, CurationIgnoreReason, CurationPairKind, CurationSeverity,
  CurationSignatureSummary, MergeableKind,
} from "../lib/types";

const LIMIT = 25;
const MERGEABLE_KINDS = new Set<string>(["person", "organization", "artist"]);
const PAIR_KINDS = new Set<string>(["artist", "person", "organization", "album", "track"]);
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
const HIDDEN_EVIDENCE = new Set(["span", "signatureLabel", "triggeredBy", "triggeredInScan", "history", "pair"]);

export function CurationFindingsPage() {
  const { key } = useParams();
  const { summary, summaryError, refreshSummary } = useCurationSummary();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const [ignoringGroup, setIgnoringGroup] = useState(false);
  const [fixingGroup, setFixingGroup] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [ignoringFinding, setIgnoringFinding] = useState<CurationFinding | null>(null);
  const [distinctFinding, setDistinctFinding] = useState<{ finding: CurationFinding; pair: [number, number] } | null>(null);
  const [fixingFinding, setFixingFinding] = useState<{ finding: CurationFinding; actionKey: string } | null>(null);
  const [mergingFinding, setMergingFinding] = useState<{ finding: CurationFinding; kind: MergeableKind; otherId?: number; otherName?: string } | null>(null);
  const [deletingFinding, setDeletingFinding] = useState<CurationFinding | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fixingSelected, setFixingSelected] = useState(false);
  const [selectAllFilter, setSelectAllFilter] = useState(false);
  const [trustingGroup, setTrustingGroup] = useState(false);
  const [activeFindingId, setActiveFindingId] = useState<number | null>(null);
  const [keyboardHelp, setKeyboardHelp] = useState(false);

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

  // La selección sobrevive al paginado y se invalida al cambiar el filtro.
  useEffect(() => {
    setSelected(new Set());
    setSelectAllFilter(false);
  }, [key, detector, signature, severity, entityKind, status, q, scanId, chained]);

  function toggleSelected(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (!data?.data.length) {
      setActiveFindingId(null);
      return;
    }
    if (!data.data.some((item) => item.id === activeFindingId)) setActiveFindingId(data.data[0]!.id);
  }, [data, activeFindingId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.matches("input,textarea,select,button,[contenteditable='true']") || target.closest("[role='dialog']"))) return;
      if (event.key === "?") {
        event.preventDefault();
        setKeyboardHelp(true);
        return;
      }
      const rows = data?.data ?? [];
      if (!rows.length) return;
      const index = Math.max(0, rows.findIndex((item) => item.id === activeFindingId));
      const move = (next: number) => {
        const item = rows[Math.max(0, Math.min(rows.length - 1, next))]!;
        setActiveFindingId(item.id);
        document.querySelector<HTMLElement>(\`[data-finding-id="\${item.id}"]\`)?.focus();
      };
      if (event.key === "j") { event.preventDefault(); move(index + 1); return; }
      if (event.key === "k") { event.preventDefault(); move(index - 1); return; }
      const finding = rows[index];
      if (!finding) return;
      if (event.key === "x" && finding.status === "open" && finding.actions.some((action) => action.level <= 2)) {
        event.preventDefault();
        if (!selectAllFilter) toggleSelected(finding.id);
        return;
      }
      if (event.key === "c" && finding.status === "open" && finding.actions[0] && finding.actions[0].level <= 2) {
        event.preventDefault();
        setFixingFinding({ finding, actionKey: finding.actions[0].key });
        return;
      }
      if (event.key === "i" && finding.status === "open") {
        event.preventDefault();
        setIgnoringFinding(finding);
        return;
      }
      if (event.key === "o") {
        const href = refHref(finding.entity, finding);
        if (href) {
          event.preventDefault();
          window.open(href, "_blank", "noopener");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, activeFindingId, selectAllFilter]);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value); else next.delete(name);
    }
    if (!("offset" in changes)) next.delete("offset");
    setParams(next);
  }

  async function reopen(finding: CurationFinding) {
    setBusyId(finding.id);
    try {
      await curationApi.reopen(finding.id);
      notify("success", "Hallazgo reabierto.");
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
    return summaryError ? <ErrorState message={summaryError} onRetry={() => void refreshSummary()} /> : (
      <div role="status" aria-label="Cargando la categoría…">
        <HeaderSkeleton />
        <RowsSkeleton rows={4} />
      </div>
    );
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
  // Lo mismo que `query`, sin paginar ni estado: exactamente lo que ven las
  // acciones de grupo (ignorar/corregir este detector), para que afecten
  // solo lo que la pantalla muestra (C3, PLAN_CURADURIA E3.1).
  const groupFilter: CurationFindingGroupFilter | null = category && activeDetector
    ? {
      category: category.key, detector: activeDetector.key,
      ...(signature ? { signature } : {}),
      ...(severity ? { severity } : {}),
      ...(entityKind ? { entityKind } : {}),
      ...(q ? { q } : {}),
      ...(scanId ? { scanId } : {}),
      ...(chained ? { chained: true } : {}),
    }
    : null;

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
            {category.key === "valores_en_disputa"
              && (activeDetector.key === "conflictos_abiertos" || (activeDetector.key === "cola_de_revision" && signature === "review:field_conflict")) ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => setTrustingGroup(true)}>
                Resolver por fuente más confiable
              </button>
            ) : null}
            {/* Las acciones vienen del registro E4/E5/E6; suggestedValue ya no decide la UX. */}
            {data.data.some((finding) => finding.actions.some((action) => action.level <= 1)) ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => setFixingGroup(true)}>
                <Wrench size={14} weight="bold" aria-hidden="true" />
                Corregir {signature ? "este subgrupo" : "este detector"}
              </button>
            ) : null}
            <button type="button" className="btn btn--sm btn--outline" onClick={() => setIgnoringGroup(true)}>
              <EyeSlash size={14} weight="bold" aria-hidden="true" />
              Ignorar {signature ? "este subgrupo" : "este detector"}
            </button>
          </div>
        ) : null}
      </div>

      {loading && !data ? <RowsSkeleton rows={6} height={64} label="Cargando hallazgos…" /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || data.data.length === 0 ? (
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
                  onIgnore={() => setIgnoringFinding(finding)} onReopen={() => void reopen(finding)}
                  selected={selectAllFilter || selected.has(finding.id)}
                  onToggleSelected={() => { if (!selectAllFilter) toggleSelected(finding.id); }}
                  active={activeFindingId === finding.id}
                  onActivate={() => setActiveFindingId(finding.id)}
                  onFix={(actionKey) => setFixingFinding({ finding, actionKey })}
                  onReviewTriggered={finding.triggeredBy.length ? async () => {
                    await curationApi.reviewTriggered(finding.id);
                    notify("success", "Cadena revisada; la causa quedó archivada.");
                    reload();
                    void refreshSummary();
                  } : undefined}
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
                  onDistinct={(() => {
                    const pair = findingPair(finding);
                    return pair && PAIR_KINDS.has(finding.entity.kind) ? () => setDistinctFinding({ finding, pair }) : undefined;
                  })()}
                />
              </li>
            ))}
          </ol>
          <Pagination limit={LIMIT} offset={offset} total={data.pagination.total} onOffsetChange={(next) => update({ offset: String(next) })} />
          {groupFilter && status === "open" && data.pagination.total > data.data.length ? (
            <button type="button" className="btn btn--sm btn--outline select-all-filter"
              aria-pressed={selectAllFilter}
              onClick={() => { setSelectAllFilter((value) => !value); setSelected(new Set()); }}>
              {selectAllFilter
                ? "Volver a selección por página"
                : `Seleccionar los ${formatCount(data.pagination.total)} que cumplen el filtro`}
            </button>
          ) : null}
        </>
      )}

      {selectAllFilter || selected.size > 0 ? (
        <div className="csel-toolbar" role="toolbar" aria-label="Acciones sobre lo seleccionado">
          <span className="csel-toolbar__count">
            {selectAllFilter
              ? `${formatCount(data?.pagination.total ?? 0)} seleccionados por filtro`
              : `${formatCount(selected.size)} seleccionado${selected.size === 1 ? "" : "s"}`}
          </span>
          <div className="csel-toolbar__actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setFixingSelected(true)}>
              <Wrench size={14} weight="bold" aria-hidden="true" /> Corregir seleccionados
            </button>
            <button type="button" className="btn btn--sm btn--outline" onClick={() => { setSelected(new Set()); setSelectAllFilter(false); }}>
              Vaciar selección
            </button>
          </div>
        </div>
      ) : null}

      {ignoringFinding ? (
        <IgnoreDialog
          title="¿No es un problema?"
          description={`«${ignoringFinding.title}» dejará de aparecer entre los abiertos mientras el detector lo siga viendo igual. Si el problema desaparece, pasa a resuelto. El catálogo no cambia.`}
          confirmLabel="No es un problema"
          requireNote={false}
          onConfirm={async (reason, note) => {
            await curationApi.ignore(ignoringFinding.id, reason, note);
            notify("success", "Hallazgo ignorado con su motivo.");
            setIgnoringFinding(null);
            reload();
            void refreshSummary();
          }}
          onClose={() => setIgnoringFinding(null)}
        />
      ) : null}

      {distinctFinding ? (
        <ConfirmDialog
          title="¿Son fichas distintas?"
          description={`El detector no volverá a proponer este par (#${distinctFinding.pair[0]} y #${distinctFinding.pair[1]}) como repetido, aunque cambien sus nombres o aparezcan otras fichas parecidas. El catálogo no cambia.`}
          confirmLabel="Son distintas"
          onConfirm={async (note) => {
            await curationApi.declareDistinct({
              kind: distinctFinding.finding.entity.kind as CurationPairKind, aId: distinctFinding.pair[0], bId: distinctFinding.pair[1], note,
            });
            notify("success", "Par declarado distinto. Desaparece de los abiertos en cuanto termine la verificación.");
            setDistinctFinding(null);
            reload();
            void refreshSummary();
          }}
          onClose={() => setDistinctFinding(null)}
        />
      ) : null}

      {ignoringGroup && groupFilter ? (
        <IgnoreDialog
          title={`¿Ignorar ${signature ? "este subgrupo" : "este detector"}?`}
          description={`Los ${formatCount(data?.pagination.total ?? 0)} hallazgos abiertos de «${activeDetector?.label ?? detector}»${signature ? ` › «${signatures.find((item) => item.key === signature)?.label ?? signature}»` : ""} (con los filtros activos) se marcarán como «no es un problema». El catálogo no cambia y cada caso se puede reabrir.`}
          confirmLabel="Ignorar el grupo"
          requireNote
          onConfirm={async (reason, note) => {
            const result = await curationApi.ignoreGroup({ ...groupFilter, reason, note });
            notify("success", `${formatCount(result.ignored)} hallazgos ignorados.`);
            setIgnoringGroup(false);
            reload();
            void refreshSummary();
          }}
          onClose={() => setIgnoringGroup(false)}
        />
      ) : null}

      {fixingGroup && groupFilter ? (
        <FixBatchDialog
          mode="group"
          filter={groupFilter}
          title={`¿Corregir ${signature ? "este subgrupo" : "este detector"}?`}
          description={`Cada hallazgo abierto y corregible de «${activeDetector?.label ?? detector}»${signature ? ` › «${signatures.find((item) => item.key === signature)?.label ?? signature}»` : ""} recibirá su corrección recomendada. Revisa la vista previa —podrás excluir ítems— antes de aplicar, y deshacer el lote después.`}
          onDone={() => { reload(); void refreshSummary(); }}
          onClose={() => setFixingGroup(false)}
        />
      ) : null}

      {fixingSelected ? (
        <FixBatchDialog
          mode={selectAllFilter ? "group" : "selected"}
          {...(selectAllFilter && groupFilter ? { filter: groupFilter } : { findingIds: [...selected] })}
          title="¿Corregir los hallazgos seleccionados?"
          description={selectAllFilter
            ? "La vista previa incluye todos los hallazgos que cumplen exactamente el filtro visible, no solo esta página."
            : `Cada uno de los ${formatCount(selected.size)} hallazgos seleccionados recibirá su corrección recomendada.`}
          onDone={() => { setSelected(new Set()); setSelectAllFilter(false); reload(); void refreshSummary(); }}
          onClose={() => setFixingSelected(false)}
        />
      ) : null}

      {fixingFinding ? (
        <FixBatchDialog
          mode="individual"
          findingIds={[fixingFinding.finding.id]}
          actionKey={fixingFinding.actionKey}
          title={`Corregir «${fixingFinding.finding.title}»`}
          description={`Acción: ${fixingFinding.finding.actions.find((action) => action.key === fixingFinding.actionKey)?.label ?? fixingFinding.actionKey}. Revisa el antes → después y sus precondiciones.`}
          {...(fixingFinding.actionKey === "limpiar_texto" && fixingFinding.finding.suggestedValue !== null ? {
            valueEditor: {
              initial: fixingFinding.finding.suggestedValue,
              current: fixingFinding.finding.value ?? "",
              fieldLabel: fieldLabel(fixingFinding.finding.field ?? ""),
            },
          } : {})}
          onDone={() => { reload(); void refreshSummary(); }}
          onClose={() => setFixingFinding(null)}
        />
      ) : null}

      {trustingGroup && groupFilter ? (
        <TrustedConflictDialog
          filter={groupFilter}
          onDone={() => { reload(); void refreshSummary(); }}
          onClose={() => setTrustingGroup(false)}
        />
      ) : null}

      {keyboardHelp ? (
        <Modal title="Atajos de Curaduría" onClose={() => setKeyboardHelp(false)}>
          <dl className="shortcut-list">
            <div><dt>j / k</dt><dd>Siguiente / anterior</dd></div>
            <div><dt>x</dt><dd>Seleccionar</dd></div>
            <div><dt>c</dt><dd>Corregir con la acción recomendada</dd></div>
            <div><dt>i</dt><dd>No es un problema</dd></div>
            <div><dt>o</dt><dd>Abrir la ficha</dd></div>
            <div><dt>?</dt><dd>Mostrar esta ayuda</dd></div>
          </dl>
        </Modal>
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
          description={`«${deletingFinding.entity.label}» no tiene vínculos con el catálogo. Se retira del catálogo con auditoría.`}
          confirmLabel="Eliminar ficha"
          danger
          onConfirm={(note) => deleteFinding(deletingFinding, note)}
          onClose={() => setDeletingFinding(null)}
        />
      ) : null}
    </>
  );
}

/** «No es un problema» con motivo obligatorio: sin él no se puede medir la precisión de cada detector. */
function IgnoreDialog({ title, description, confirmLabel, requireNote, onConfirm, onClose }: {
  title: string; description: string; confirmLabel: string; requireNote: boolean;
  onConfirm: (reason: CurationIgnoreReason, note: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState<CurationIgnoreReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const noteId = useId();

  async function submit() {
    if (!reason) { setError("Elige un motivo."); return; }
    if (requireNote && !note.trim()) { setError("La nota es obligatoria."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(reason, note.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar la decisión.");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="dialog-lead">{description}</p>
      <fieldset className="reason-choices">
        <legend>Motivo *</legend>
        {IGNORE_REASONS.map((item) => (
          <label key={item.value} className="reason-choice">
            <input type="radio" name="ignore-reason" value={item.value} checked={reason === item.value} onChange={() => { setReason(item.value); setError(undefined); }} />
            <span>
              <span className="reason-choice__label">{item.label}</span>
              <span className="reason-choice__hint">{item.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={noteId}>Nota{requireNote ? " *" : " (opcional)"}</label>
        <textarea id={noteId} rows={2} value={note} onChange={(event) => setNote(event.target.value)}
          placeholder="Qué lo justifica (ayuda a quien lo revise después)" />
      </div>
      {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>{busy ? "Guardando…" : confirmLabel}</button>
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

function FindingCard({ finding, categoryLabel, busy, onIgnore, onReopen, selected, onToggleSelected, onFix, onMerge, onDelete, onDistinct }: {
  finding: CurationFinding; categoryLabel: string | undefined; busy: boolean; onIgnore: () => void; onReopen: () => void;
  selected: boolean; onToggleSelected: () => void;
  onFix: (() => void) | undefined; onMerge: (() => void) | undefined; onDelete: (() => void) | undefined; onDistinct: (() => void) | undefined;
}) {
  const change = lastChangeText(finding);
  const entityLink = refHref(finding.entity, finding);
  const related = finding.related.filter((ref) => !(ref.kind === finding.entity.kind && ref.id === finding.entity.id));
  const evidence = Object.entries(finding.evidence).filter(([name]) => !HIDDEN_EVIDENCE.has(name));

  return (
    <article className={`cfind cfind--${finding.severity}${finding.status !== "open" ? " is-closed" : ""}${selected ? " cfind--picked" : ""}`}>
      <div className="cfind__badges">
        {/* Solo si hay algo que corregir de un clic: seleccionar un hallazgo sin `suggestedValue`
            solo serviría para que «Corregir seleccionados» lo reporte como no corregible (A2). */}
        {finding.status === "open" && finding.suggestedValue !== null ? (
          <label className="visually-hidden" htmlFor={`cfind-pick-${finding.id}`}>Seleccionar este hallazgo</label>
        ) : null}
        {finding.status === "open" && finding.suggestedValue !== null ? (
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

      {change ? (
        <p className="cfind__note"><ClockCounterClockwise size={13} weight="bold" aria-hidden="true" /> {change}</p>
      ) : null}

      {finding.status === "resolved" && resolutionText(finding) ? (
        <p className="cfind__note">
          {resolutionText(finding)}{finding.resolvedAt ? ` ${relativeTime(finding.resolvedAt)}` : ""}
          {finding.ignoredAt ? ` · antes estaba ignorado${ignoreReasonLabel(finding.ignoreReason) ? ` (${ignoreReasonLabel(finding.ignoreReason)!.toLowerCase()})` : ""}` : ""}
        </p>
      ) : null}

      {finding.status === "ignored" && (finding.ignoredBy || finding.ignoreNote || finding.ignoreReason) ? (
        <p className="cfind__note">
          Ignorado{finding.ignoredBy ? ` por ${finding.ignoredBy}` : ""}{finding.ignoredAt ? ` ${relativeTime(finding.ignoredAt)}` : ""}
          {ignoreReasonLabel(finding.ignoreReason) ? ` · ${ignoreReasonLabel(finding.ignoreReason)}` : ""}
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
          {finding.status === "open" && onDistinct ? (
            <button type="button" className="btn btn--sm btn--outline" onClick={onDistinct} disabled={busy}
              title="Son fichas distintas: el detector no vuelve a proponer este par">
              <NotEquals size={14} weight="bold" aria-hidden="true" /> Son distintas
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
              title="No es un problema: con motivo; dura mientras el detector lo siga viendo igual">
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
