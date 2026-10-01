import { useEffect, useRef, useState } from "react";

/** Párrafo largo recortado a unas líneas, con «Leer más» solo si de verdad desborda. */
export function ExpandableText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node && !open) setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [text, open]);

  return (
    <div>
      <p ref={ref} className={`${className ?? ""} expandable${open ? " is-open" : ""}`}>{text}</p>
      {overflows || open ? (
        <button type="button" className="btn btn--sm btn--ghost expandable__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Leer menos" : "Leer más"}
        </button>
      ) : null}
    </div>
  );
}
