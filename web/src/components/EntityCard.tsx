import { Link } from "react-router-dom";

interface EntityCardProps {
  to: string;
  title: string;
  subtitle?: string | null | undefined;
  imageUrl?: string | null | undefined;
  placeholder: string;
}

export function EntityCard({ to, title, subtitle, imageUrl, placeholder }: EntityCardProps) {
  return (
    <Link to={to} className="card entity-card">
      <span className="entity-card__art">
        {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span className="placeholder">{placeholder}</span>}
      </span>
      <span className="entity-card__body">
        <span className="entity-card__title">{title}</span>
        {subtitle ? <span className="entity-card__sub">{subtitle}</span> : null}
      </span>
    </Link>
  );
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
