interface PaginationProps {
  limit: number;
  offset: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}

export function Pagination({ limit, offset, total, onOffsetChange }: PaginationProps) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="pagination">
      <span className="status">{from}–{to} de {total.toLocaleString("es-VE")}</span>
      <div className="controls">
        <button type="button" className="btn btn--sm" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>
          ← Anterior
        </button>
        <span className="status" style={{ alignSelf: "center" }}>Página {page} de {pageCount}</span>
        <button type="button" className="btn btn--sm" disabled={to >= total} onClick={() => onOffsetChange(offset + limit)}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}
