// CRV · Curaduría › una categoría del detector de conflictos.
//
// Los detectores y subgrupos de la categoría salen del resumen de la API: si
// el detector aprende un subgrupo nuevo, aparece aquí como un filtro más sin
// tocar la web. Sin `:key` la página lista hallazgos de todas las categorías
// (la usan los enlaces «nuevos en este análisis» y «surgidos tras corregir»).
//
// Cada tarjeta ofrece la corrección RECOMENDADA como botón principal, con su
// nivel y su consecuencia escritos al lado, y el resto bajo «Otras
// correcciones» (PLAN_CURADURIA E8.1): antes aparecía un «Corregir» genérico
// en hallazgos que no se corrigen así (A2). Todo pasa por la vista previa del
// lote, también cuando es un solo hallazgo.
//
// Ignorar no cambia el catálogo: solo le dice al detector que ese caso no es un
// problema, con un motivo (falso positivo, correcto a propósito, fuera de
// alcance). Dura mientras el detector lo siga viendo; si el problema desaparece,
// el hallazgo pasa a resuelto. «Son distintas» hace lo mismo para un par de
// fichas repetidas, y sobrevive aunque cambie el grupo. «Marcar como revisado»
// (E8.7) tampoco cierra nada: quita la marca «apareció al corregir» para que
// esa lista deje de crecer sin fin (M2).
//
// Triaje con teclado (E8.6): j/k mueven, x selecciona, c corrige con la
// recomendada, i ignora, o abre la ficha y ? explica los atajos.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowBendDownRight, ArrowCounterClockwise, ArrowSquareOut, CaretDown, CaretUp, CheckCircle, ClockCounterClockwise, DotsThree,
  EyeSlash, Gavel, GitMerge, Keyboard, Lightbulb, NotEquals, Scales, Sparkle, Trash, Wrench,
} from "@phosphor-icons/react";
import {
  albumWrites, artistWrites, ApiError, curationApi, organizationWrites, personWrites, trackWrites,
  type CurationFindingGroupFilter, type CurationFindingQuery,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { useMediaQuery } from "../lib/useMediaQuery";
import {
  ENTITY_KIND_LABEL, IGNORE_REASONS, SEVERITY_BADGE, SEVERITY_LABEL, actionConsequence, categoryIcon, fieldLabel, findingPair,
  formatCount, ignoreReasonLabel, lastChangeText, refHref, relativeTime, resolutionText,
} from "../lib/curation";
import { ErrorState, EmptyState } from "../components/StateViews";
import { HeaderSkeleton, RowsSkeleton } from "../components/Skeletons";
import { Pagination } from "../components/Pagination";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CurationValue } from "../components/CurationValue";
import { FindingEvidence } from "../components/FindingEvidence";
import { FixBatchDialog } from "../components/FixBatchDialog";
import { Modal } from "../components/Modal";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { ReviewDecisionDialog } from "../components/ReviewDecisionDialog";
import { ConflictResolveDialog } from "../components/ConflictResolveDialog";
import { useCurationSummary } from "./CurationLayout";
import type {
  CurationActionSummary, CurationCategorySummary, CurationFinding, CurationFindingStatus, CurationIgnoreReason, CurationPairKind,
  CurationSeverity, CurationSignatureSummary, FixBatch, MergeableKind,
} from "../lib/types";

/** Detectores de «valores en disputa» que E7 cablea en la tarjeta (PLAN_CURADURIA). */
const REVIEW_DETECTOR = "cola_de_revision";
const CONFLICT_DETECTOR = "conflictos_abiertos";

const LIMIT = 25;
const MOBILE_QUERY = "(max-width: 760px)";
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

/** Lo que se corrige a mano escribiendo el valor: solo donde el detector calcula uno. */
const MANUAL_VALUE_ACTION = "limpiar_texto";

/** Atajos del triaje con teclado (E8.6), también la chuleta de «?». */
const SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: "j / k", description: "Bajar y subir por los hallazgos" },
  { keys: "x", description: "Seleccionar o quitar el hallazgo enfocado" },
  { keys: "c", description: "Corregir con la acción recomendada" },
  { keys: "i", description: "No es un problema (pide el motivo)" },
  { keys: "o", description: "Abrir la ficha en otra pestaña" },
  { keys: "?", description: "Mostrar esta ayuda" },
];

/** Un hallazgo se puede corregir de un clic si el motor le ofrece alguna acción (A2). */
const isFixable = (finding: CurationFinding) => finding.status === "open" && finding.actions.length > 0;

/** Acción abierta en el diálogo de corrección: la recomendada, otra del menú, o el valor a mano. */
interface FixTarget {
  finding: CurationFinding;
  action: CurationActionSummary | null;
  manual: boolean;
}

export function CurationFindingsPage() {
  const { key } = useParams();
  const { summary, summaryError, refreshSummary } = useCurationSummary();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [ignoringGroup, setIgnoringGroup] = useState(false);
  const [fixingGroup, setFixingGroup] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [ignoringFinding, setIgnoringFinding] = useState<CurationFinding | null>(null);
  const [distinctFinding, setDistinctFinding] = useState<{ finding: CurationFinding; pair: [number, number] } | null>(null);
  const [fixTarget, setFixTarget] = useState<FixTarget | null>(null);
  const [mergingFinding, setMergingFinding] = useState<{ finding: CurationFinding; kind: MergeableKind; otherId?: number; otherName?: string } | null>(null);
  const [decidingReviewId, setDecidingReviewId] = useState<number | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState<CurationFinding | null>(null);
  const [applyingTrust, setApplyingTrust] = useState(false);
  const [acknowledgingGroup, setAcknowledgingGroup] = useState(false);
  const [deletingFinding, setDeletingFinding] = useState<CurationFinding | null>(null);
  const [sheetFinding, setSheetFinding] = useState<CurationFinding | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [fixingSelected, setFixingSelected] = useState(false);
  const [focused, setFocused] = useState(-1);
  const listRef = useRef<HTMLOListElement>(null);

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

  // La selección se ancla al FILTRO, no a la página: pasar a la página 2 no
  // borra lo elegido en la 1 (M5). Cambiar cualquier filtro sí, porque ya no
  // corresponde a lo que se ve.
  useEffect(() => {
    setSelected(new Set());
    setSelectAll(false);
    setFocused(-1);
  }, [key, detector, signature, severity, entityKind, status, q, scanId, chained]);

  const rows = data?.data ?? [];

  function toggleSelected(id: number) {
    if (selectAll) {
      // Con «todo el filtro» elegido, desmarcar uno no puede seguir siendo una
      // selección por filtro: se pasa a una selección por ids con lo que se ve
      // y se corrige, menos el que se acaba de quitar. Lo de otras páginas se
      // pierde, y por eso el aviso lo dice.
      setSelectAll(false);
      setSelected(new Set(rows.filter(isFixable).map((row) => row.id).filter((rowId) => rowId !== id)));
      notify("info", "Ya no está seleccionado todo el filtro: ahora solo lo elegido en esta página.");
      return;
    }
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

  const afterWrite = useCallback(() => { reload(); void refreshSummary(); }, [reload, refreshSummary]);

  /**
   * «Deshacer» a mano durante 30 s tras una corrección individual (E8.4): el
   * lote ya está en el historial, pero volver ahí por un cambio recién hecho es
   * más trabajo del que merece.
   */
  const offerUndo = useCallback((batch: FixBatch) => {
    notify("success", "Corrección aplicada.", {
      action: {
        label: "Deshacer",
        onAction: async () => {
          try {
            const undone = await curationApi.fixUndo(batch.id, "Deshecho desde el aviso de la corrección");
            const failed = typeof undone.counts["notUndoable"] === "number" ? undone.counts["notUndoable"] : 0;
            notify(failed ? "error" : "success", failed ? "No se pudo restaurar: la ficha cambió después." : "Corrección deshecha.");
            afterWrite();
          } catch (err) {
            notify("error", err instanceof ApiError ? err.message : "No se pudo deshacer la corrección.");
          }
        },
      },
    });
  }, [notify, afterWrite]);

  async function reopen(finding: CurationFinding) {
    setBusyId(finding.id);
    try {
      await curationApi.reopen(finding.id);
      notify("success", "Hallazgo reabierto.");
      afterWrite();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo guardar la decisión.");
    } finally {
      setBusyId(null);
    }
  }

  async function acknowledge(finding: CurationFinding) {
    setBusyId(finding.id);
    try {
      await curationApi.acknowledgeChain(finding.id);
      notify("success", "Marcado como revisado. El hallazgo sigue abierto.");
      afterWrite();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo marcar como revisado.");
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
    afterWrite();
  }

  // ---- Triaje con teclado (E8.6) ----
  const anyDialogOpen = Boolean(
    ignoringFinding || distinctFinding || fixTarget || mergingFinding || deletingFinding || sheetFinding
    || decidingReviewId !== null || resolvingConflict || ignoringGroup || fixingGroup || fixingSelected || applyingTrust
    || acknowledgingGroup || helpOpen,
  );

  // Sin lista de dependencias a propósito: el manejador tiene que leer el foco
  // y los hallazgos de ESTE render. Con dependencias habría que enumerarlas
  // todas y cualquier olvido dejaría el atajo actuando sobre una lista vieja.
  useEffect(() => {
    if (anyDialogOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "?") { event.preventDefault(); setHelpOpen(true); return; }
      if (!rows.length) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const delta = event.key === "j" ? 1 : -1;
        setFocused((index) => (index < 0 ? 0 : Math.min(Math.max(index + delta, 0), rows.length - 1)));
        return;
      }
      const finding = focused >= 0 ? rows[focused] : undefined;
      if (!finding) return;
      if (event.key === "x" && isFixable(finding)) { event.preventDefault(); toggleSelected(finding.id); }
      if (event.key === "c" && isFixable(finding)) { event.preventDefault(); setFixTarget({ finding, action: finding.actions[0] ?? null, manual: false }); }
      if (event.key === "i" && finding.status === "open") { event.preventDefault(); setIgnoringFinding(finding); }
      if (event.key === "o") {
        const href = refHref(finding.entity, finding);
        if (href) { event.preventDefault(); window.open(href, "_blank", "noopener"); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (focused < 0) return;
    const card = listRef.current?.children[focused] as HTMLElement | undefined;
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

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
  const total = data?.pagination.total ?? 0;
  const fixableShown = rows.filter(isFixable).length;
  // «Seleccionar los N que cumplen el filtro» viaja como filtro, no como ids
  // (M5, E8.3): alcanza también las páginas que no se han abierto. Un filtro de
  // grupo siempre está anclado a un detector (E3.1), así que sin detector
  // activo solo queda lo elegido a mano, página a página.
  const canSelectAll = groupFilter !== null && status === "open" && total > 0;

  const cardHandlers = (finding: CurationFinding) => ({
    onIgnore: () => setIgnoringFinding(finding),
    onReopen: () => void reopen(finding),
    onAcknowledge: finding.triggeredBy.length ? () => void acknowledge(finding) : undefined,
    onFix: (action: CurationActionSummary | null, manual: boolean) => setFixTarget({ finding, action, manual }),
    onMerge: finding.category === "fichas_repetidas" && MERGEABLE_KINDS.has(finding.entity.kind) && finding.entity.id !== null
      ? () => {
        const other = finding.related.find((ref) => ref.kind === finding.entity.kind && ref.id !== null && ref.id !== finding.entity.id);
        setMergingFinding({
          finding, kind: finding.entity.kind as MergeableKind,
          ...(other?.id ? { otherId: other.id, otherName: other.label } : {}),
        });
      }
      : undefined,
    onDelete: finding.category === "fichas_sin_vinculos" && finding.entity.id !== null && ENTITY_WRITE_API[finding.entity.kind]
      ? () => setDeletingFinding(finding)
      : undefined,
    onDistinct: (() => {
      const pair = findingPair(finding);
      return pair && PAIR_KINDS.has(finding.entity.kind) ? () => setDistinctFinding({ finding, pair }) : undefined;
    })(),
    onDecide: finding.detector === REVIEW_DETECTOR && typeof finding.evidence["reviewId"] === "number"
      ? () => setDecidingReviewId(finding.evidence["reviewId"] as number)
      : undefined,
    onResolveConflict: finding.detector === CONFLICT_DETECTOR ? () => setResolvingConflict(finding) : undefined,
  });

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
          <button type="button" className="btn btn--sm btn--outline" onClick={() => setHelpOpen(true)} title="Atajos de teclado (?)">
            <Keyboard size={14} weight="bold" aria-hidden="true" />
            <span className="visually-hidden">Atajos de teclado</span>
          </button>
        </div>
      </div>

      <div className="cfind-count">
        {data && !loading ? (
          <p aria-live="polite">{total === 1 ? "1 hallazgo" : `${formatCount(total)} hallazgos`}</p>
        ) : <span />}
        {status === "open" && data && total > 0 ? (
          <div className="cfind-count__actions">
            {/* Solo si hay algo que corregir de un clic en lo que se ve: «Corregir este detector» no debe
                terminar en «0 corregidos» cuando ningún hallazgo tiene acción (A2). */}
            {groupFilter && fixableShown > 0 ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => setFixingGroup(true)}>
                <Wrench size={14} weight="bold" aria-hidden="true" />
                Corregir {signature ? "este subgrupo" : "este detector"}
              </button>
            ) : null}
            {/* «Aplicar la fuente de mayor confianza» (PLAN_CURADURIA E7.2): solo para
                conflictos abiertos, donde cada hallazgo trae la confianza de sus dos fuentes. */}
            {groupFilter && activeDetector?.key === CONFLICT_DETECTOR ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => setApplyingTrust(true)}>
                <Scales size={14} weight="bold" aria-hidden="true" />
                Aplicar la fuente de mayor confianza
              </button>
            ) : null}
            {/* «Surgidos tras corregir»: darlos por revisados de una vez (E8.7, M2). */}
            {chained ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => setAcknowledgingGroup(true)}>
                <CheckCircle size={14} weight="bold" aria-hidden="true" />
                Marcar todos como revisados
              </button>
            ) : null}
            {groupFilter ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => setIgnoringGroup(true)}>
                <EyeSlash size={14} weight="bold" aria-hidden="true" />
                Ignorar {signature ? "este subgrupo" : "este detector"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {loading && !data ? <RowsSkeleton rows={6} height={64} label="Cargando hallazgos…" /> : error ? <ErrorState message={error} onRetry={reload} /> : !data || rows.length === 0 ? (
        <EmptyState
          title={status === "open" ? "No hay hallazgos abiertos aquí" : "No hay hallazgos con estos filtros"}
          hint={status === "open" ? "El detector no encontró problemas de este tipo en el último análisis." : "Prueba con otros filtros."}
        />
      ) : (
        <>
          <ol className={`cfind-list${loading ? " is-refreshing" : ""}`} ref={listRef}>
            {rows.map((finding, index) => (
              <li key={finding.id}>
                <FindingCard
                  finding={finding} busy={busyId === finding.id} compact={isMobile}
                  categoryLabel={key ? undefined : summary?.categories.find((item) => item.key === finding.category)?.label ?? "Otros"}
                  selected={selectAll ? isFixable(finding) : selected.has(finding.id)}
                  selectionLocked={selectAll}
                  onToggleSelected={() => toggleSelected(finding.id)}
                  focusedByKeyboard={focused === index}
                  onOpenSheet={() => setSheetFinding(finding)}
                  {...cardHandlers(finding)}
                />
              </li>
            ))}
          </ol>
          <Pagination limit={LIMIT} offset={offset} total={total} onOffsetChange={(next) => update({ offset: String(next) })} />
        </>
      )}

      {selected.size > 0 || selectAll ? (
        <div className="csel-toolbar" role="toolbar" aria-label="Acciones sobre lo seleccionado">
          <span className="csel-toolbar__count" aria-live="polite">
            {selectAll
              ? `Los ${formatCount(total)} hallazgos que cumplen el filtro`
              : `${formatCount(selected.size)} seleccionado${selected.size === 1 ? "" : "s"}`}
          </span>
          <div className="csel-toolbar__actions">
            {!selectAll && canSelectAll ? (
              <button type="button" className="btn btn--sm btn--outline" onClick={() => { setSelected(new Set()); setSelectAll(true); }}>
                Seleccionar los {formatCount(total)} que cumplen el filtro
              </button>
            ) : null}
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setFixingSelected(true)}>
              <Wrench size={14} weight="bold" aria-hidden="true" /> Corregir {selectAll ? "todo el filtro" : "seleccionados"}
            </button>
            <button type="button" className="btn btn--sm btn--outline" onClick={() => { setSelected(new Set()); setSelectAll(false); }}>
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
            afterWrite();
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
            afterWrite();
          }}
          onClose={() => setDistinctFinding(null)}
        />
      ) : null}

      {ignoringGroup && groupFilter ? (
        <IgnoreDialog
          title={`¿Ignorar ${signature ? "este subgrupo" : "este detector"}?`}
          description={`Los ${formatCount(total)} hallazgos abiertos de «${activeDetector?.label ?? detector}»${signature ? ` › «${signatures.find((item) => item.key === signature)?.label ?? signature}»` : ""} (con los filtros activos) se marcarán como «no es un problema». El catálogo no cambia y cada caso se puede reabrir.`}
          confirmLabel="Ignorar el grupo"
          requireNote
          onConfirm={async (reason, note) => {
            const result = await curationApi.ignoreGroup({ ...groupFilter, reason, note });
            notify("success", `${formatCount(result.ignored)} hallazgos ignorados.`);
            setIgnoringGroup(false);
            afterWrite();
          }}
          onClose={() => setIgnoringGroup(false)}
        />
      ) : null}

      {acknowledgingGroup ? (
        <ConfirmDialog
          title="¿Marcar todos como revisados?"
          description={`Los ${formatCount(total)} hallazgos de esta lista dejarán de contar como «surgidos tras corregir»: la marca pasa a su historial, con quién y cuándo. Ninguno se cierra ni se corrige, y el catálogo no cambia.`}
          confirmLabel="Marcar como revisados"
          requireNote={false}
          onConfirm={async () => {
            const result = await curationApi.acknowledgeChainGroup({
              status,
              ...(key ? { category: key } : {}),
              ...(detector ? { detector } : {}),
              ...(signature ? { signature } : {}),
              ...(severity ? { severity } : {}),
              ...(entityKind ? { entityKind } : {}),
              ...(q ? { q } : {}),
              ...(scanId ? { scanId } : {}),
            });
            notify("success", `${formatCount(result.acknowledged)} marcados como revisados.`);
            setAcknowledgingGroup(false);
            afterWrite();
          }}
          onClose={() => setAcknowledgingGroup(false)}
        />
      ) : null}

      {fixingGroup && groupFilter ? (
        <FixBatchDialog
          mode="group"
          filter={groupFilter}
          title={`¿Corregir ${signature ? "este subgrupo" : "este detector"}?`}
          description={`Cada hallazgo abierto y corregible de «${activeDetector?.label ?? detector}»${signature ? ` › «${signatures.find((item) => item.key === signature)?.label ?? signature}»` : ""} recibirá su corrección recomendada. Revisa la vista previa —podrás excluir ítems o cambiar la acción de una fila— antes de aplicar, y deshacer el lote después.`}
          onDone={afterWrite}
          onClose={() => setFixingGroup(false)}
        />
      ) : null}

      {applyingTrust && groupFilter ? (
        <ConfirmDialog
          title="¿Aplicar la fuente de mayor confianza?"
          description={`Sobre los ${formatCount(total)} conflictos abiertos con los filtros activos, se elige el lado de mayor confianza declarada de su fuente. Un empate (misma confianza a los dos lados) queda sin tocar: nadie decidió por él.`}
          confirmLabel="Aplicar por confianza"
          onConfirm={async (note) => {
            const result = await curationApi.resolveConflictsGroup({ ...groupFilter, note });
            notify("success", `${formatCount(result.applied)} resueltos, ${formatCount(result.tied)} en empate, ${formatCount(result.failed)} sin aplicar.`);
            setApplyingTrust(false);
            afterWrite();
          }}
          onClose={() => setApplyingTrust(false)}
        />
      ) : null}

      {fixingSelected ? (
        selectAll && groupFilter ? (
          <FixBatchDialog
            mode="group"
            filter={groupFilter}
            title="¿Corregir todo lo que cumple el filtro?"
            description={`Los ${formatCount(total)} hallazgos abiertos que cumplen los filtros de la pantalla —no solo los de esta página— recibirán su corrección recomendada. Revisa la vista previa antes de aplicar; el lote se puede deshacer.`}
            onDone={() => { setSelectAll(false); afterWrite(); }}
            onClose={() => setFixingSelected(false)}
          />
        ) : (
          <FixBatchDialog
            mode="selected"
            findingIds={[...selected]}
            title="¿Corregir los hallazgos seleccionados?"
            description={`Cada uno de los ${formatCount(selected.size)} hallazgos seleccionados recibirá su corrección recomendada. Revisa la vista previa —podrás excluir ítems o cambiar la acción de una fila— antes de aplicar, y deshacer el lote después.`}
            onDone={() => { setSelected(new Set()); afterWrite(); }}
            onClose={() => setFixingSelected(false)}
          />
        )
      ) : null}

      {fixTarget ? (
        <FixBatchDialog
          mode="individual"
          findingIds={[fixTarget.finding.id]}
          {...(fixTarget.action && !fixTarget.manual ? { actionKey: fixTarget.action.key } : {})}
          title={fixTarget.manual ? `Corregir «${fixTarget.finding.title}»` : `${fixTarget.action?.label ?? "Corregir"} · «${fixTarget.finding.title}»`}
          description={fixTarget.manual
            ? `Se aplicará el valor al campo «${fieldLabel(fixTarget.finding.field ?? "")}» de «${fixTarget.finding.entity.label}».`
            : `${fixTarget.action ? actionConsequence(fixTarget.action) : ""} Se aplica sobre «${fixTarget.finding.entity.label}». Revisa el antes → después antes de aplicar.`}
          {...(fixTarget.manual
            ? {
              valueEditor: {
                initial: fixTarget.finding.suggestedValue ?? fixTarget.finding.value ?? "",
                current: fixTarget.finding.value ?? "",
                fieldLabel: fieldLabel(fixTarget.finding.field ?? ""),
              },
            }
            : {})}
          onDone={afterWrite}
          onApplied={offerUndo}
          onClose={() => setFixTarget(null)}
        />
      ) : null}

      {mergingFinding ? (
        <MergeEntityModal
          kind={mergingFinding.kind}
          entityId={mergingFinding.finding.entity.id!}
          entityName={mergingFinding.finding.entity.label}
          {...(mergingFinding.otherId ? { otherId: mergingFinding.otherId, otherName: mergingFinding.otherName ?? "" } : {})}
          onMerged={() => { setMergingFinding(null); notify("success", "Fichas fusionadas."); afterWrite(); }}
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

      {decidingReviewId !== null ? (
        <ReviewDecisionDialog
          reviewId={decidingReviewId}
          onDone={afterWrite}
          onClose={() => setDecidingReviewId(null)}
        />
      ) : null}

      {resolvingConflict ? (
        <ConflictResolveDialog
          finding={resolvingConflict}
          onDone={afterWrite}
          onClose={() => setResolvingConflict(null)}
        />
      ) : null}

      {sheetFinding ? (
        <Modal title="Acciones" onClose={() => setSheetFinding(null)} sheet>
          <p className="dialog-lead">{sheetFinding.title}</p>
          <div className="csheet">
            <FindingActions
              finding={sheetFinding} busy={busyId === sheetFinding.id} layout="sheet"
              {...cardHandlers(sheetFinding)}
              onAny={() => setSheetFinding(null)}
            />
          </div>
        </Modal>
      ) : null}

      {helpOpen ? (
        <Modal title="Atajos de teclado" onClose={() => setHelpOpen(false)}>
          <p className="dialog-lead">Funcionan mientras no haya un diálogo abierto ni el foco esté en un campo de texto.</p>
          <dl className="cshortcuts">
            {SHORTCUTS.map((item) => (
              <div key={item.keys} className="cshortcuts__row">
                <dt><kbd>{item.keys}</kbd></dt>
                <dd>{item.description}</dd>
              </div>
            ))}
          </dl>
          <div className="form-actions">
            <button type="button" className="btn btn--primary" onClick={() => setHelpOpen(false)}>Entendido</button>
          </div>
        </Modal>
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
          ? "Hallazgos que aparecieron en las mismas fichas donde una corrección acababa de resolver otro. Revísalos: la corrección pudo dejar el dato a medias. Marcar como revisado no los cierra, solo los saca de esta lista."
          : "Hallazgos de todas las categorías."}
      </p>
    </div>
  );
}

interface FindingActionsProps {
  finding: CurationFinding;
  busy: boolean;
  /** `row` es la fila de la tarjeta en escritorio; `sheet`, la hoja inferior de móvil (E8.9). */
  layout: "row" | "sheet";
  onIgnore: () => void;
  onReopen: () => void;
  onAcknowledge: (() => void) | undefined;
  onFix: (action: CurationActionSummary | null, manual: boolean) => void;
  onMerge: (() => void) | undefined;
  onDelete: (() => void) | undefined;
  onDistinct: (() => void) | undefined;
  onDecide: (() => void) | undefined;
  onResolveConflict: (() => void) | undefined;
  onAny?: (() => void) | undefined;
}

/**
 * Botones de una tarjeta (E8.1). El principal es la acción RECOMENDADA del
 * motor —no un «Corregir» genérico— y las demás viven en «Otras correcciones»,
 * para que la primera lectura de la tarjeta no sea una fila de seis botones.
 */
function FindingActions({
  finding, busy, layout, onIgnore, onReopen, onAcknowledge, onFix, onMerge, onDelete, onDistinct, onDecide, onResolveConflict, onAny,
}: FindingActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = finding.status === "open";

  // Un menú que solo se cierra volviendo a pulsar su botón atrapa al que lo
  // abre por error, y con el teclado no hay salida. Escape devuelve el foco al
  // disparador; un clic fuera lo cierra sin activar nada más.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenuOpen(false);
      menuRef.current?.querySelector("button")?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);
  const [recommended, ...others] = finding.actions;
  // Escribir el valor a mano solo tiene sentido donde el detector calculó uno
  // (los hallazgos de texto): en los demás, el valor lo decide la acción.
  const manual = finding.suggestedValue !== null && finding.actions.some((action) => action.key === MANUAL_VALUE_ACTION);
  const run = (fn: () => void) => () => { setMenuOpen(false); fn(); onAny?.(); };
  const sheet = layout === "sheet";
  const size = sheet ? "" : " btn--sm";

  return (
    <div className={sheet ? "csheet__actions" : "cfind__actions"}>
      {open && recommended ? (
        <button type="button" className={`btn${size} btn--primary`} onClick={run(() => onFix(recommended, false))} disabled={busy}
          title={actionConsequence(recommended)}>
          <Wrench size={14} weight="bold" aria-hidden="true" /> {recommended.label}
        </button>
      ) : null}
      {open && onDecide ? (
        <button type="button" className={`btn${size} btn--primary`} onClick={run(onDecide)} disabled={busy}
          title="Aceptar, rechazar o resolver esta revisión sin salir de la lista">
          <Gavel size={14} weight="bold" aria-hidden="true" /> Decidir
        </button>
      ) : null}
      {open && onResolveConflict ? (
        <button type="button" className={`btn${size} btn--primary`} onClick={run(onResolveConflict)} disabled={busy}
          title="Elegir A, B u otro valor con la evidencia de cada fuente">
          <Scales size={14} weight="bold" aria-hidden="true" /> Resolver
        </button>
      ) : null}
      {/* «Son distintas» no es una corrección: es la decisión contraria a fusionar,
          y queda a la vista junto a «No es un problema» en vez de en el menú. */}
      {open && onDistinct ? (
        <button type="button" className={`btn${size} btn--outline`} onClick={run(onDistinct)} disabled={busy}
          title="Son fichas distintas: el detector no vuelve a proponer este par">
          <NotEquals size={14} weight="bold" aria-hidden="true" /> Son distintas
        </button>
      ) : null}

      {open && (others.length > 0 || manual || onMerge || onDelete) ? (
        sheet ? (
          <>
            {others.map((action) => (
              <button key={action.key} type="button" className="btn btn--outline" onClick={run(() => onFix(action, false))} disabled={busy}
                title={actionConsequence(action)}>
                {action.label} <span className="hint">· nivel {action.level}</span>
              </button>
            ))}
            {manual ? (
              <button type="button" className="btn btn--outline" onClick={run(() => onFix(null, true))} disabled={busy}>
                Escribir el valor a mano
              </button>
            ) : null}
            {onMerge ? (
              <button type="button" className="btn btn--outline" onClick={run(onMerge)} disabled={busy}>
                <GitMerge size={14} weight="bold" aria-hidden="true" /> Fusionar eligiendo la otra ficha
              </button>
            ) : null}
            {onDelete ? (
              <button type="button" className="btn btn--outline" onClick={run(onDelete)} disabled={busy}>
                <Trash size={14} weight="bold" aria-hidden="true" /> Eliminar ficha sin vista previa
              </button>
            ) : null}
          </>
        ) : (
          <div className={`cmenu${menuOpen ? " is-open" : ""}`} ref={menuRef}>
            <button type="button" className="btn btn--sm btn--outline" aria-expanded={menuOpen} aria-haspopup="menu"
              onClick={() => setMenuOpen((value) => !value)} disabled={busy}>
              <DotsThree size={16} weight="bold" aria-hidden="true" /> Otras correcciones
            </button>
            {menuOpen ? (
              <div className="cmenu__panel" role="menu">
                {others.map((action) => (
                  <button key={action.key} type="button" className="cmenu__item" role="menuitem" onClick={run(() => onFix(action, false))}>
                    <span className="cmenu__label">{action.label}</span>
                    <span className="cmenu__hint">{actionConsequence(action)}</span>
                  </button>
                ))}
                {manual ? (
                  <button type="button" className="cmenu__item" role="menuitem" onClick={run(() => onFix(null, true))}>
                    <span className="cmenu__label">Escribir el valor a mano</span>
                    <span className="cmenu__hint">Se aplica el texto que escribas, con vista previa.</span>
                  </button>
                ) : null}
                {onMerge ? (
                  <button type="button" className="cmenu__item" role="menuitem" onClick={run(onMerge)}>
                    <span className="cmenu__label">Fusionar eligiendo la otra ficha</span>
                    <span className="cmenu__hint">Cuando la repetida no es la que propone el detector.</span>
                  </button>
                ) : null}
                {onDelete ? (
                  <button type="button" className="cmenu__item" role="menuitem" onClick={run(onDelete)}>
                    <span className="cmenu__label">Eliminar ficha sin vista previa</span>
                    <span className="cmenu__hint">Se retira del catálogo con auditoría, pero fuera del lote: sin deshacer de un clic.</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      ) : null}

      {onAcknowledge ? (
        <button type="button" className={`btn${size} btn--outline`} onClick={run(onAcknowledge)} disabled={busy}
          title="Ya lo miré: quita la marca «apareció al corregir». No cierra el hallazgo.">
          <CheckCircle size={14} weight="bold" aria-hidden="true" /> Marcar como revisado
        </button>
      ) : null}

      {open ? (
        <button type="button" className={`btn${size} btn--outline`} onClick={run(onIgnore)} disabled={busy}
          title="No es un problema: con motivo; dura mientras el detector lo siga viendo igual">
          <EyeSlash size={14} weight="bold" aria-hidden="true" /> No es un problema
        </button>
      ) : finding.status === "ignored" ? (
        <button type="button" className={`btn${size} btn--outline`} onClick={run(onReopen)} disabled={busy}>
          <ArrowCounterClockwise size={14} weight="bold" aria-hidden="true" /> Reabrir
        </button>
      ) : null}
    </div>
  );
}

interface FindingCardProps extends Omit<FindingActionsProps, "layout" | "onAny"> {
  categoryLabel: string | undefined;
  selected: boolean;
  /** Con «seleccionar todo el filtro» la casilla refleja el filtro, no una elección ficha a ficha. */
  selectionLocked: boolean;
  onToggleSelected: () => void;
  /** El triaje con teclado tiene su propio foco, que no es el del navegador. */
  focusedByKeyboard: boolean;
  /** En móvil las acciones viven en una hoja inferior (E8.9). */
  compact: boolean;
  onOpenSheet: () => void;
}

function FindingCard(props: FindingCardProps) {
  const { finding, categoryLabel, selected, selectionLocked, onToggleSelected, focusedByKeyboard, compact, onOpenSheet, busy } = props;
  const change = lastChangeText(finding);
  const entityLink = refHref(finding.entity, finding);
  const related = finding.related.filter((ref) => !(ref.kind === finding.entity.kind && ref.id === finding.entity.id));
  const recommended = finding.actions[0];
  const selectable = isFixable(finding);

  return (
    <article
      className={`cfind cfind--${finding.severity}${finding.status !== "open" ? " is-closed" : ""}${selected ? " cfind--picked" : ""}${focusedByKeyboard ? " cfind--focused" : ""}`}
      aria-current={focusedByKeyboard ? "true" : undefined}
    >
      <div className="cfind__badges">
        {/* Solo si hay algo que corregir de un clic: seleccionar un hallazgo sin acción
            solo serviría para que «Corregir seleccionados» lo reporte como no corregible (A2). */}
        {selectable ? (
          <>
            <label className="visually-hidden" htmlFor={`cfind-pick-${finding.id}`}>Seleccionar este hallazgo</label>
            <input id={`cfind-pick-${finding.id}`} type="checkbox" checked={selected} onChange={onToggleSelected}
              {...(selectionLocked ? { title: "Está seleccionado porque lo está todo el filtro; quitarlo pasa a elegir uno a uno." } : {})} />
          </>
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

      {/* Nivel y consecuencia de la acción recomendada, en una línea (E8.1): qué
          pasa si se pulsa el botón principal, sin abrir el diálogo. */}
      {finding.status === "open" && recommended ? (
        <p className="cfind__level"><Wrench size={13} weight="bold" aria-hidden="true" /> {actionConsequence(recommended)}</p>
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
        <details className="cfind__evidence">
          <summary>Evidencia <CaretDown size={12} weight="bold" aria-hidden="true" /></summary>
          <FindingEvidence evidence={finding.evidence} />
        </details>
        {compact ? (
          <div className="cfind__actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={onOpenSheet} disabled={busy}>
              <DotsThree size={16} weight="bold" aria-hidden="true" /> Acciones
            </button>
          </div>
        ) : (
          <FindingActions {...props} layout="row" />
        )}
      </div>
    </article>
  );
}
