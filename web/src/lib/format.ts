// CRV · Formato de valores compartido por las fichas y los modales: el valor
// compacto de las previsualizaciones de fusión y las fechas de vida (las usan
// la ficha de la persona y la del proyecto solista, que muestra las de su
// titular).
export function formatMergeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return String(value);
}

/** «2009-01-31» → «31 de enero de 2009»; si la fecha no es completa o válida, se muestra tal cual. */
export function formatDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-VE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Años cumplidos entre el nacimiento y el fallecimiento (o hoy); null si falta una fecha completa. */
export function ageText(birth: string | null, death: string | null): string | null {
  const parse = (value: string | null) => {
    const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
  };
  const from = parse(birth);
  if (!from) return null;
  const now = new Date();
  const to = parse(death) ?? { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const years = to.y - from.y - (to.m < from.m || (to.m === from.m && to.d < from.d) ? 1 : 0);
  return years >= 0 && years < 130 ? `${years} años` : null;
}
