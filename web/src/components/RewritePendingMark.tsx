import { useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { entityMergeApi, type RewriteKind } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";

const FIELD_NOUN: Readonly<Record<string, string>> = { biography: "La biografía", description: "La reseña" };

/**
 * Marca de «reescribir con IA»: al fusionar dos fichas sus textos se unen y la
 * ficha queda marcada hasta que DeepSeek flash los reescribe en uno. Solo la
 * ven quienes administran; desde aquí se puede reescribir sin esperar la cola.
 */
export function RewritePendingMark({ kind, id, onDone }: { kind: RewriteKind; id: number; onDone: () => void }) {
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data, reload } = useAsync(() => (isAdmin ? entityMergeApi.pendingRewrites(kind, id) : Promise.resolve({ pending: [] })), [kind, id, isAdmin]);
  const [busy, setBusy] = useState(false);
  const pending = data?.pending ?? [];
  if (!isAdmin || pending.length === 0) return null;

  async function run() {
    setBusy(true);
    try {
      const result = await entityMergeApi.runRewrites(kind, id, "Reescritura pedida desde la ficha");
      if (result.failed.length) notify("error", `La IA no pudo reescribirla: ${result.failed[0]}`);
      else notify("success", "Texto reescrito con IA. Se puede deshacer desde el Historial.");
      reload();
      onDone();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "No se pudo reescribir.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rewrite-mark" role="status">
      <Sparkle size={15} weight="fill" aria-hidden="true" />
      <span>
        {pending.map((item) => `${FIELD_NOUN[item.field] ?? item.field} une ${item.sources} textos de una fusión`).join(" · ")}
        {" "}y está pendiente de reescribir con IA.
      </span>
      <button type="button" className="btn btn--sm" onClick={() => void run()} disabled={busy}>
        {busy ? "Reescribiendo…" : "Reescribir ahora"}
      </button>
    </div>
  );
}
