// CRV · Muestra el valor de un hallazgo tal como está guardado: resalta el
// tramo que el detector señaló (`evidence.span`) y vuelve visibles los
// caracteres invisibles o de control, que en pantalla no se verían.
import type { ReactNode } from "react";

// eslint-disable-next-line no-control-regex -- mostrar los caracteres de control es justo lo que se busca
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00A0\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/gu;

function codePoint(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function visible(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INVISIBLE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    out.push(<span key={`${key}-${index}`} className="cval__cp" title="Carácter invisible">{codePoint(match[0])}</span>);
    last = index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function spanOf(evidence: Record<string, unknown>, length: number): [number, number] | null {
  const span = evidence["span"];
  if (!Array.isArray(span) || span.length !== 2) return null;
  const [start, end] = span as unknown[];
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start || end > length) return null;
  return [start, end];
}

export function CurationValue({ value, evidence }: { value: string; evidence: Record<string, unknown> }) {
  const span = spanOf(evidence, value.length);
  return (
    <span className="cval">
      {span ? (
        <>
          {visible(value.slice(0, span[0]), "a")}
          <mark>{visible(value.slice(span[0], span[1]), "m")}</mark>
          {visible(value.slice(span[1]), "b")}
        </>
      ) : visible(value, "v")}
    </span>
  );
}
