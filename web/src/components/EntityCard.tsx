import { Link } from "react-router-dom";
import { DeceasedMark } from "./DeceasedMark";

interface EntityCardProps {
  to: string;
  title: string;
  subtitle?: string | null | undefined;
  imageUrl?: string | null | undefined;
  placeholder: string;
  tag?: string | null | undefined;
  tagTitle?: string | undefined;
  deceased?: boolean | undefined;
  /** Género principal confirmado, en una línea propia bajo el subtítulo. */
  genre?: string | null | undefined;
  /** Marca de referencia (violeta) cuando la ficha entró al filtro por una relación, no por su género. */
  note?: string | null | undefined;
  noteTitle?: string | undefined;
}

export function EntityCard({ to, title, subtitle, imageUrl, placeholder, tag, tagTitle, deceased, genre, note, noteTitle }: EntityCardProps) {
  return (
    <Link to={to} className="card entity-card">
      <span className="entity-card__art">
        {imageUrl ? <img src={imageUrl} alt="" loading="lazy" decoding="async" /> : <span className="placeholder">{placeholder}</span>}
      </span>
      <span className="entity-card__body">
        <span className="entity-card__title">{title}<DeceasedMark deceased={deceased} /></span>
        {subtitle ? <span className="entity-card__sub">{subtitle}</span> : null}
        {genre ? <span className="entity-card__genre">{genre}</span> : null}
        {note ? <span className="badge badge--violet entity-card__tag" title={noteTitle}>{note}</span> : null}
        {tag ? <span className="badge badge--amber entity-card__tag" title={tagTitle}>{tag}</span> : null}
      </span>
    </Link>
  );
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
