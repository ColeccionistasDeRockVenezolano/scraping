// CRV · Fusión de discos con previsualización (E6.5; la API la ofrecía, la web no).
//
// Igual que la fusión de fichas: nada se toca sin ver antes qué pasa — pistas
// emparejadas, cuáles se moverían, conflictos de campos, formatos que se
// añaden y créditos compartidos. La fusión real la ejecuta el servicio
// (merge/album-merge.ts) dentro de una transacción del operador; aquí no hay
// reglas propias. El modal no se cierra al fusionar: muestra el resultado y
// deja deshacer la fusión mientras el run siga siendo reversible.
import { useCallback, useEffect, useState } from "react";
import { albumMergeApi, entityMergeApi, ApiError } from "../lib/api";
import { formatMergeValue } from "../lib/format";
import { useToast } from "../lib/ToastContext";
import { Modal } from "./Modal";
import { EntityPicker } from "./EntityPicker";
import type { AlbumMergePreview, AlbumMergeResult, AlbumTrackMatch } from "../lib/types";

/** Etiquetas de los campos fusionables de un disco (MERGE_ALBUM_FIELDS). */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  release_year: "Año", album_type: "Tipo", genre: "Género", label_id: "Sello",
  cover_url: "Portada", description: "Descripción",
  youtube_url: "URL de YouTube", youtube_status: "Estado en YouTube",
  instagram_url: "URL de Instagram", instagram_status: "Estado en Instagram",
  wordpress_url: "URL de WordPress", wordpress_status: "Estado en WordPress",
  notes: "Notas",
};

const MATCH_LABEL: Readonly<Record<AlbumTrackMatch["matchType"], string>> = {
  position_and_title: "misma posición y título",
  title: "mismo título",
  position: "misma posición",
};

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

interface AlbumMergeModalProps {
  albumId: number;
  albumTitle: string;
  onMerged: (keepId: number) => void;
  onClose: () => void;
}

export function AlbumMergeModal({ albumId, albumTitle, onMerged, onClose }: AlbumMergeModalProps) {
  const { notify } = useToast();
  const [dropId, setDropId] = useState<number | null>(null);
  const [dropLabel, setDropLabel] = useState<string | null>(null);
  const [keepId, setKeepId] = useState<number | null>(null);
  const [preview, setPreview] = useState<AlbumMergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [choices, setChoices] = useState<Record<string, "keep" | "drop">>({});
  const [keepDropNameAsAlias, setKeepDropNameAsAlias] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AlbumMergeResult | null>(null);
  const [undoNote, setUndoNote] = useState("");
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async (firstId: number, secondId: number, orient: "recommended" | "first" = "recommended") => {
    setLoading(true);
    setError(undefined);
    setStale(false);
    setPreview(null);
    try {
      // «recommended» normaliza al disco recomendado por el motor; «first»
      // respeta la orientación pedida — así el botón Intercambiar cambia de
      // verdad quién queda (el servidor no normaliza, solo informa).
      let loaded = await albumMergeApi.preview(firstId, secondId);
      if (orient === "recommended" && loaded.recommendedKeepId === secondId) loaded = await albumMergeApi.preview(secondId, firstId);
      setKeepId(loaded.keep.id);
      setDropId(loaded.drop.id);
      setPreview(loaded);
      setChoices({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo previsualizar la fusión.");
    } finally {
      setLoading(false);
    }
  }, []);

  function chooseOther(id: number, label: string) {
    if (id === albumId) { setError("Es el mismo disco: elige otro."); return; }
    setDropLabel(label);
    void load(albumId, id);
  }

  function swap() {
    if (preview) void load(preview.drop.id, preview.keep.id, "first");
  }

  useEffect(() => {
    // Al cerrar con el modal montado no queda nada pendiente; el efecto solo
    // existe para que el hash de la previsualización no sobreviva a un cambio.
  }, [preview?.previewHash]);

  async function submit() {
    if (!preview || !keepId || !dropId) return;
    setBusy(true);
    setError(undefined);
    try {
      const merged = await albumMergeApi.merge(keepId, {
        dropId, previewHash: preview.previewHash,
        ...(Object.keys(choices).length ? { fieldChoices: choices } : {}),
        keepDropNameAsAlias, note: note.trim(),
      });
      notify("success", `Discos fusionados: «${preview.drop.title}» → «${preview.keep.title}» (${plural(merged.tracksMerged + merged.tracksMoved, "pista movida o unificada", "pistas movidas o unificadas")}).`);
      setResult(merged);
      setBusy(false);
    } catch (err) {
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

  return (
    <Modal title={result ? "Fusión completada" : "Fusionar discos"} onClose={onClose} wide>
      {result ? (
        <>
          <p style={{ fontSize: 14, margin: "0 0 10px" }}>
            «{preview?.drop.title}» se fusionó en «{preview?.keep.title}»: {plural(result.tracksMerged, "pista unificada", "pistas unificadas")},
            {" "}{plural(result.tracksMoved, "pista movida", "pistas movidas")}, {plural(result.creditsMerged, "crédito unificado", "créditos unificados")} y
            {" "}{plural(result.formatsMerged, "formato unificado", "formatos unificados")}
            {result.fieldsCorrected.length ? `; campos corregidos: ${result.fieldsCorrected.map((field) => FIELD_LABELS[field] ?? field).join(", ")}` : ""}.
          </p>
          <p className="hint">El id del disco que desapareció ya lleva al que quedó (redirección). Los enlaces de medios se repuntaron.</p>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="album-merge-undo-note">Motivo para deshacer *</label>
            <textarea
              id="album-merge-undo-note" rows={2} value={undoNote}
              onChange={(event) => setUndoNote(event.target.value)}
              placeholder="Por qué se revierte esta fusión (queda en la auditoría)"
            />
          </div>
          {error ? <p className="form-error-banner" style={{ marginTop: 12 }} role="alert">{error}</p> : null}
          <div className="form-actions">
            <button type="button" className="btn btn--danger" onClick={undo} disabled={undoing || !undoNote.trim()}>
              {undoing ? "Deshaciendo…" : "Deshacer esta fusión"}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => onMerged(result.keepId)}>Ir al disco</button>
          </div>
        </>
      ) : dropId === null ? (
        <div className="field">
          <EntityPicker
            kind="album"
            label={`¿Con qué disco se fusiona «${albumTitle}»?`}
            value={dropId}
            valueLabel={dropLabel}
            onSelect={chooseOther}
            placeholder="Título del otro disco…"
          />
          <span className="hint">Se compara antes de tocar nada; el disco que desaparece queda redirigido al que se conserve.</span>
          {error ? <p className="form-error-banner" role="alert" style={{ marginTop: 10 }}>{error}</p> : null}
        </div>
      ) : (
        <>
          {loading ? <p className="hint" role="status">Calculando previsualización…</p> : null}
          {stale ? (
            <p className="form-error-banner" role="alert" style={{ marginBottom: 12 }}>
              El disco cambió; revisa de nuevo antes de fusionar.
            </p>
          ) : null}
          {error ? <p className="form-error-banner" role="alert" style={{ marginBottom: 12 }}>{error}</p> : null}

          {preview ? (
            <>
              <div className="compare-grid" style={{ marginBottom: 14 }}>
                {([["keep", preview.keep], ["drop", preview.drop]] as const).map(([role, side]) => (
                  <div className="compare-side" key={role}>
                    <h4>{role === "keep" ? "Disco que queda" : "Disco que desaparece"}{side.id === preview.recommendedKeepId ? " · recomendado" : ""}</h4>
                    <p style={{ margin: "0 0 6px", fontWeight: 600 }}>{side.title}</p>
                    <p className="hint" style={{ margin: 0 }}>{side.artistName}{side.labelName ? ` · ${side.labelName}` : ""}</p>
                    <p className="hint" style={{ margin: "4px 0 0" }}>
                      {side.counts.tracks} pistas · {side.counts.albumCredits} créditos · {side.counts.formats} formatos · {side.counts.mediaLinks} enlaces · {side.counts.claims} claims
                    </p>
                    {side.aliases.length ? <p className="hint" style={{ margin: "6px 0 0" }}>Alias: {side.aliases.join(", ")}</p> : null}
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button type="button" className="btn btn--sm" onClick={swap} disabled={busy}>
                  Intercambiar (queda «{preview.drop.title}»)
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

              {preview.matchedTracks.length ? (
                <div className="table-wrap table-wrap--scroll" style={{ marginBottom: 14 }}>
                  <table>
                    <caption className="visually-hidden">Pistas emparejadas entre los dos discos</caption>
                    <thead><tr><th scope="col">Pista que queda</th><th scope="col">Pista que desaparece</th><th scope="col">Empate</th></tr></thead>
                    <tbody>
                      {preview.matchedTracks.map((match) => (
                        <tr key={`${match.keepTrackId}-${match.dropTrackId}`}>
                          <td>{match.discNumber}.{match.keepTrackNumber} {match.keepTitle}</td>
                          <td>{match.discNumber}.{match.dropTrackNumber} {match.dropTitle}</td>
                          <td className="hint">{MATCH_LABEL[match.matchType]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {preview.unmatchedDropTracks.length ? (
                <p style={{ fontSize: 13.5, margin: "0 0 12px" }}>
                  Se moverán al disco que queda sus {plural(preview.unmatchedDropTracks.length, "pista sin pareja", "pistas sin pareja")}:
                  {" "}{preview.unmatchedDropTracks.map((track) => `«${track.title}»`).join(", ")}.
                </p>
              ) : null}

              {preview.fieldConflicts.length ? (
                <div className="table-wrap table-wrap--scroll" style={{ marginBottom: 14 }}>
                  <table>
                    <caption className="visually-hidden">Campos en conflicto entre los dos discos</caption>
                    <thead><tr><th scope="col">Campo</th><th scope="col">Queda</th><th scope="col">Desaparece</th><th scope="col">Decisión</th></tr></thead>
                    <tbody>
                      {preview.fieldConflicts.map((conflict) => (
                        <tr key={conflict.field}>
                          <td>{FIELD_LABELS[conflict.field] ?? conflict.field}</td>
                          <td>{formatMergeValue(conflict.keepValue)}</td>
                          <td>{formatMergeValue(conflict.dropValue)}</td>
                          <td>
                            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
                              <legend className="visually-hidden">Decisión para {FIELD_LABELS[conflict.field] ?? conflict.field}</legend>
                              <label style={{ display: "block", fontSize: 12.5 }}>
                                <input
                                  type="radio" name={`album-merge-${conflict.field}`}
                                  checked={(choices[conflict.field] ?? "keep") === "keep"}
                                  onChange={() => setChoices((current) => ({ ...current, [conflict.field]: "keep" }))}
                                /> Conservar: {formatMergeValue(conflict.keepValue)}
                              </label>
                              <label style={{ display: "block", fontSize: 12.5 }}>
                                <input
                                  type="radio" name={`album-merge-${conflict.field}`}
                                  checked={choices[conflict.field] === "drop"}
                                  onChange={() => setChoices((current) => ({ ...current, [conflict.field]: "drop" }))}
                                /> Usar: {formatMergeValue(conflict.dropValue)}
                              </label>
                            </fieldset>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {preview.fieldsFilledFromDrop.length ? (
                <p className="hint" style={{ marginBottom: 12 }}>Se completan campos vacíos: {preview.fieldsFilledFromDrop.map((field) => FIELD_LABELS[field] ?? field).join(", ")}.</p>
              ) : null}
              {preview.formatsToAdd.length ? (
                <p className="hint" style={{ marginBottom: 12 }}>Formatos que se añadirán: {preview.formatsToAdd.map((format) => format.format).join(", ")}.</p>
              ) : null}
              {preview.sharedCredits.length ? (
                <p className="hint" style={{ marginBottom: 12 }}>
                  Créditos ya presentes en ambos (no se duplican): {preview.sharedCredits.map((credit) => `${credit.role} — ${credit.targetName}`).join("; ")}.
                </p>
              ) : null}

              <p style={{ fontSize: 13.5, color: "var(--text-muted)", margin: "0 0 12px" }}>
                «{preview.drop.title}» dejará de existir y su enlace llevará a «{preview.keep.title}».
              </p>

              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 12 }}>
                <input type="checkbox" checked={keepDropNameAsAlias} onChange={(event) => setKeepDropNameAsAlias(event.target.checked)} />
                Guardar «{preview.drop.title}» como alias de «{preview.keep.title}»
              </label>

              <div className="field">
                <label htmlFor="album-merge-note">Motivo *</label>
                <textarea
                  id="album-merge-note" rows={3} value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Por qué son el mismo disco (queda en la auditoría)"
                />
              </div>

              <div className="form-actions">
                <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
                <button
                  type="button" className="btn btn--danger"
                  onClick={submit}
                  disabled={busy || loading || !note.trim()}
                >
                  {busy ? "Fusionando…" : `Fusionar «${preview.drop.title}» en «${preview.keep.title}»`}
                </button>
              </div>
            </>
          ) : null}
          {!loading && !preview && !error ? <p className="hint">Sin previsualización.</p> : null}
        </>
      )}
    </Modal>
  );
}
