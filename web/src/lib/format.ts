// CRV · Formato compacto de valores para las previsualizaciones de fusión
// (compartido por la fusión de fichas y la de discos). Antes vivía exportado
// dentro de MergeEntityModal sin consumidores externos.
export function formatMergeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return String(value);
}
