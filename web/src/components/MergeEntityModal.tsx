// CRV · Fusión de fichas con previsualización (E11.6; generalizada a
// organizaciones y artistas en E11.10; plan P2).
//
// El modal hace visible la decisión antes de tomarla: qué ficha queda, qué
// campos se completan, cuáles se contradicen, qué relaciones comparten y qué
// avisos merece el par. La fusión real la ejecuta el servicio (E11.3) dentro
// de una transacción del operador; aquí no hay reglas propias.
import { useCallback, useEffect, useState } from "react";
import { ApiError, entityMergeApi } from "../lib/api";
import { formatMergeValue } from "../lib/format";
import { useToast } from "../lib/ToastContext";
import { Modal } from "./Modal";
import { EntityPicker } from "./EntityPicker";
import type { MergeableKind, PersonMergeField, PersonMergePreview, PersonMergeResult } from "../lib/types";

/** «1 crédito» / «3 créditos»: sin esto la interfaz decía «1 revisiones». */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Campos que muestra la tabla: los que trae la previsualización —los de esa
 * entidad—, no todos los de las tres. Antes se listaban los campos de todas y
 * una persona llegaba a mostrar «Web», «Ciudad» o «País» de organización.
 */
function mergeRowFields(preview: PersonMergePreview): string[] {
  const present = new Set([...Object.keys(preview.keep.fields), ...Object.keys(preview.drop.fields)]);
  const known = Object.keys(FIELD_LABELS).filter((field) => present.has(field));
  return [...known, ...[...present].filter((field) => !(field in FIELD_LABELS))];
}

/** Etiquetas de los campos fusionables, de las tres entidades (E11.3/E11.10). */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  biography: "Biografía",
  picture_url: "Foto",
  nationality: "Nacionalidad",
  is_venezuelan: "Venezolano/a",
  birth_date: "Nacimiento",
  death_date: "Fallecimiento",
  organization_type: "Tipo",
  website_url: "Web",
  country: "País",
  artist_type: "Tipo",
  origin_city: "Ciudad",
  origin_country: "País",
  formed_year: "Desde",
  disbanded_year: "Hasta",
  notes: "Notas",
};

/** Sustantivo por kind, para los textos del modal. */
const NOUNS: Readonly<Record<MergeableKind, { plural: string; one: string }>> = {
  person: { plural: "personas", one: "persona" },
  organization: { plural: "organizaciones", one: "organización" },
  artist: { plural: "artistas", one: "artista" },
};

interface MergeEntityModalProps {
  /** Qué tipo de ficha se fusiona: persona, organización o artista. */
  kind: MergeableKind;
  /** Ficha desde la que se abre (candidata a quedarse). */
  entityId: number;
  entityName: string;
  /** La otra ficha, cuando se abre desde la página de candidatos. */
  otherId?: number;
  otherName?: string;
  onMerged: (keepId: number) => void;
  onClose: () => void;
}

export function MergeEntityModal({ kind, entityId, entityName, otherId, otherName, onMerged, onClose }: MergeEntityModalProps) {
  const { notify } = useToast();
  const noun = NOUNS[kind];
  const [dropId, setDropId] = useState<number | null>(otherId ?? null);
  const [dropLabel, setDropLabel] = useState<string | null>(otherName ?? null);
  const [keepId, setKeepId] = useState<number | null>(otherId === undefined ? null : entityId);
  const [preview, setPreview] = useState<PersonMergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [choices, setChoices] = useState<Partial<Record<PersonMergeField, "keep" | "drop">>>({});
  const [keepDropNameAsAlias, setKeepDropNameAsAlias] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PersonMergeResult | null>(null);
  const [undoNote, setUndoNote] = useState("");
  const [undoing, setUndoing] = useState(false);

  /**
   * Carga la previsualización y preselecciona la ficha recomendada (la de más
   * referencias; a igualdad, la de id menor). Si la recomendación es el otro
   * lado, la previsualización se pide al revés.
   */
  const load = useCallback(async (firstId: number, secondId: number, orient: "recommended" | "first" = "recommended") => {
    setLoading(true);
    setError(undefined);
    setStale(false);
    setPreview(null);
    try {
      // «recommended» normaliza a la ficha recomendada por el motor; «first»
      // respeta la orientación pedida — así el botón Intercambiar cambia de
      // verdad quién queda (el servidor no normaliza, solo informa).
      let result = await entityMergeApi.preview(kind, firstId, secondId);
      if (orient === "recommended" && result.recommendedKeepId === secondId) result = await entityMergeApi.preview(kind, secondId, firstId);
      setKeepId(result.keep.id);
      setDropId(result.drop.id);
      setPreview(result);
      setChoices({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo previsualizar la fusión.");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    if (otherId !== undefined) void load(entityId, otherId);
  }, [load, otherId, entityId]);

  function chooseOther(id: number, label: string) {
    setDropLabel(label);
    void load(entityId, id);
  }

  function swap() {
    if (preview) void load(preview.drop.id, preview.keep.id, "first");
  }

  async function submit() {
    if (!preview || !keepId || !dropId) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await entityMergeApi.merge(kind, keepId, {
        dropId, previewHash: preview.previewHash,
        ...(Object.keys(choices).length ? { fieldChoices: choices } : {}),
        keepDropNameAsAlias, note: note.trim(),
      });
      notify("success", `Fusión completada: «${preview.drop.name}» → «${preview.keep.name}» (${plural(result.moved, "referencia movida", "referencias movidas")}).`);
      // El modal no se cierra: muestra el resultado y deja deshacer la fusión
      // mientras el run siga siendo reversible (E11.8).
      setResult(result);
      setBusy(false);
    } catch (err) {
      // 409: la ficha cambió entre la previsualización y la fusión. Se vuelve
      // a previsualizar y se avisa; nadie fusiona sobre un estado que no vio.
      if (err instanceof ApiError && err.code === "stale_preview") {
        setStale(true);
        setChoices({});
        void load(preview.keep.id, preview.drop.id, "first");
      } else {
        setError(err instanceof Error ? err.message : "No se pudo fusionar.");
      }
      setBusy(false);
    }
  }

  async function undo() {
    if (!result) return;
    setUndoing(true);
    setError(undefined);
    try {
      const undone = await entityMergeApi.undo(result.runId, undoNote.trim());
      notify("success", `Fusión deshecha: ${undone.restored.map((item) => `${item.kind} ${item.id}`).join(", ")} volvió al catálogo.`);
      onMerged(result.keepId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo deshacer la fusión.");
      setUndoing(false);
    }
  }

  const movedCredits = preview ? preview.drop.counts.albumCredits + preview.drop.counts.trackCredits : 0;
  const movedBands = preview ? preview.drop.counts.bands : 0;
  const movedAliases = preview
    ? preview.aliasesToAdd.length + (keepDropNameAsAlias && preview.drop.name !== preview.keep.name ? 1 : 0)
    : 0;

  return (
    <Modal title={result ? "Fusión completada" : `Fusionar ${noun.plural}`} onClose={onClose} wide>
      {result ? (
        <>
          <p style={{ fontSize: 14, margin: "0 0 10px" }}>
            «{preview?.drop.name}» se fusionó en «{preview?.keep.name}»: {plural(result.moved, "referencia movida", "referencias movidas")},
            {" "}{plural(result.creditsMerged, "crédito unificado", "créditos unificados")} y {plural(result.membershipsMerged, "membresía unificada", "membresías unificadas")}
            {result.fieldsCorrected.length ? `; campos corregidos: ${result.fieldsCorrected.join(", ")}` : ""}.
          </p>
          {result.filled.length ? <p className="hint">Se completaron: {result.filled.join(", ")}.</p> : null}
          <p className="hint">El id de la ficha que desapareció ya lleva a la que quedó (redirección).</p>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="merge-undo-note">Motivo para deshacer *</label>
            <textarea
              id="merge-undo-note" rows={2} value={undoNote}
              onChange={(event) => setUndoNote(event.target.value)}
              placeholder="Por qué se revierte esta fusión (queda en la auditoría)"
            />
          </div>
          {error ? <p className="form-error-banner" style={{ marginTop: 12 }} role="alert">{error}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn btn--danger" onClick={undo} disabled={undoing || !undoNote.trim()}>
              {undoing ? "Deshaciendo…" : "Deshacer esta fusión"}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => onMerged(result.keepId)}>Ir a la ficha</button>
          </div>
        </>
      ) : dropId === null ? (
        <div className="field">
          <EntityPicker
            kind={kind}
            label={`¿Con qué ficha se fusiona «${entityName}»?`}
            value={dropId}
            valueLabel={dropLabel}
            onSelect={chooseOther}
            placeholder={`Nombre de la otra ${noun.one}…`}
          />
          <span className="hint">Se compara antes de tocar nada; la ficha que desaparece queda redirigida a la que se conserve.</span>
        </div>
      ) : (
        <>
          {loading ? <p className="hint" role="status">Calculando previsualización…</p> : null}
          {stale ? (
            <p className="form-error-banner" role="alert" style={{ marginBottom: 12 }}>
              La ficha cambió; revisa de nuevo antes de fusionar.
            </p>
          ) : null}
          {error ? <p className="form-error-banner" role="alert" style={{ marginBottom: 12 }}>{error}</p> : null}

          {preview ? (
            <>
              <div className="compare-grid" style={{ marginBottom: 14 }}>
                {([["keep", preview.keep], ["drop", preview.drop]] as const).map(([role, side]) => (
                  <div className="compare-side" key={role}>
                    <h4>{role === "keep" ? "Ficha que queda" : "Ficha que desaparece"}{side.id === preview.recommendedKeepId ? " · recomendada" : ""}</h4>
                    <p style={{ margin: "0 0 6px", fontWeight: 600 }}>{side.name}</p>
                    <p className="hint" style={{ margin: 0 }}>
                      {side.counts.albumCredits + side.counts.trackCredits} créditos · {side.counts.bands} membresías · {side.counts.organizations} organizaciones · {side.counts.claims} claims
                    </p>
                    {side.aliases.length ? <p className="hint" style={{ margin: "6px 0 0" }}>Alias: {side.aliases.join(", ")}</p> : null}
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button type="button" className="btn btn--sm" onClick={swap} disabled={busy}>
                  Intercambiar (queda «{preview.drop.name}»)
                </button>
              </div>

              {preview.warnings.length ? (
                <div className="alert-block" role="alert" style={{ marginBottom: 14 }}>
                  <strong>Avisos</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </div>
              ) : null}

              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table>
                  <thead><tr><th>Campo</th><th>Queda</th><th>Desaparece</th><th>Decisión</th></tr></thead>
                  <tbody>
                    {mergeRowFields(preview).map((field) => {
                      const conflict = preview.fieldConflicts.find((item) => item.field === field);
                      const filled = preview.fieldsFilledFromDrop.includes(field);
                      return (
                        <tr key={field}>
                          <td>{FIELD_LABELS[field]}</td>
                          <td>{formatMergeValue(preview.keep.fields[field])}</td>
                          <td>{formatMergeValue(preview.drop.fields[field])}</td>
                          <td>
                            {conflict ? (
                              <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
                                <legend className="visually-hidden">Decisión para {FIELD_LABELS[field]}</legend>
                                <label style={{ display: "block", fontSize: 12.5 }}>
                                  <input
                                    type="radio" name={`merge-${field}`}
                                    checked={(choices[field] ?? "keep") === "keep"}
                                    onChange={() => setChoices((current) => ({ ...current, [field]: "keep" }))}
                                  /> Conservar: {formatMergeValue(conflict.keepValue)}
                                </label>
                                <label style={{ display: "block", fontSize: 12.5 }}>
                                  <input
                                    type="radio" name={`merge-${field}`}
                                    checked={choices[field] === "drop"}
                                    onChange={() => setChoices((current) => ({ ...current, [field]: "drop" }))}
                                  /> Usar: {formatMergeValue(conflict.dropValue)}
                                </label>
                              </fieldset>
                            ) : filled ? <span className="badge badge--teal">se completa</span> : <span className="hint">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {preview.sharedBands.length || preview.sharedAlbums.length ? (
                <div className="compare-grid" style={{ marginBottom: 14 }}>
                  <div className="compare-side">
                    <h4>Bandas compartidas</h4>
                    <p style={{ margin: 0 }}>{preview.sharedBands.length ? preview.sharedBands.map((band) => band.name).join(", ") : "Ninguna"}</p>
                  </div>
                  <div className="compare-side">
                    <h4>Discos compartidos</h4>
                    <p style={{ margin: 0 }}>{preview.sharedAlbums.length ? preview.sharedAlbums.map((album) => album.title).join(", ") : "Ninguno"}</p>
                  </div>
                </div>
              ) : null}

              <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: "0 0 12px" }}>
                Se moverán {plural(movedCredits, "crédito", "créditos")}, {plural(movedBands, "membresía", "membresías")} y {plural(movedAliases, "alias", "alias")}.
                {preview.reviewsBetween.length === 1
                  ? " Se cerrará 1 revisión que careaba ambas fichas."
                  : ` Se cerrarán ${preview.reviewsBetween.length} revisiones que careaban ambas fichas.`}
                {" "}«{preview.drop.name}» dejará de existir y su enlace llevará a «{preview.keep.name}».
              </p>

              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 12 }}>
                <input type="checkbox" checked={keepDropNameAsAlias} onChange={(event) => setKeepDropNameAsAlias(event.target.checked)} />
                Guardar «{preview.drop.name}» como alias de «{preview.keep.name}»
              </label>

              <div className="field">
                <label htmlFor="merge-note">Motivo *</label>
                <textarea
                  id="merge-note" rows={3} value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Por qué son la misma persona (queda en la auditoría)"
                />
              </div>
            </>
          ) : null}

          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
            <button
              type="button" className="btn btn--danger"
              onClick={submit}
              disabled={busy || !preview || loading || !note.trim()}
            >
              {busy ? "Fusionando…" : preview ? `Fusionar «${preview.drop.name}» en «${preview.keep.name}»` : "Fusionar"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
