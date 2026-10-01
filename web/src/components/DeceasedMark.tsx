import { Cross } from "@phosphor-icons/react";

/**
 * Marca de fallecido/a junto a un nombre. Sustituye a la cruz «(†)» que las
 * fuentes pegaban al nombre: el nombre queda limpio y la marca es un dato.
 */
export function DeceasedMark({ deceased, label = "Fallecido/a" }: { deceased?: boolean | null | undefined; label?: string }) {
  if (!deceased) return null;
  return (
    <span className="deceased-mark" role="img" aria-label={label} title={label}>
      <Cross size="0.85em" weight="fill" aria-hidden="true" />
    </span>
  );
}
