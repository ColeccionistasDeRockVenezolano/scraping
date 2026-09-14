import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { personWrites, personsApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState } from "../components/StateViews";
import { AliasEditor } from "../components/AliasEditor";
import { EntityFormModal } from "../components/EntityFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { initialOf } from "../components/EntityCard";
import { PERSON_FIELDS } from "../lib/entityFields";
import { creditTypeLabel } from "../lib/labels";

export function PersonDetailPage() {
  const { id } = useParams();
  const personId = Number(id);
  const navigate = useNavigate();
  const { isConfigured } = useOperator();
  const { notify } = useToast();
  const { data: person, loading, error, reload } = useAsync(() => personsApi.get(personId), [personId]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (loading) return <LoadingState />;
  if (error || !person) return <ErrorState message={error ?? "Persona no encontrada."} onRetry={reload} />;

  const meta = [person.nationality, person.isVenezuelan ? "Venezolano/a" : null].filter(Boolean);

  return (
    <>
      <Link to="/personas" className="back-link">← Personas</Link>

      <div className="entity-hero">
        <span className="entity-hero__art">
          {person.pictureUrl ? <img src={person.pictureUrl} alt="" /> : <span className="placeholder">{initialOf(person.name)}</span>}
        </span>
        <div>
          <h1 className="entity-hero__title">{person.name}</h1>
          <div className="entity-hero__meta">{meta.map((item) => <span className="badge" key={String(item)}>{item}</span>)}</div>
          {person.biography ? <p className="entity-hero__desc">{person.biography}</p> : null}
        </div>
      </div>

      {isConfigured ? (
        <div className="page-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>Editar</button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDeleting(true)}>Retirar</button>
        </div>
      ) : null}

      <div className="section">
        <h2>Alias</h2>
        <AliasEditor path="persons" entityId={person.id} aliases={person.aliases} onChanged={reload} />
      </div>

      <div className="section">
        <h2>Bandas <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({person.bands.length})</span></h2>
        {person.bands.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin bandas registradas.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Banda</th><th>Rol</th><th>Periodo</th></tr></thead>
              <tbody>
                {person.bands.map((band) => (
                  <tr key={band.id}>
                    <td><Link to={`/artistas/${band.artistId}`}>{band.artistName}</Link></td>
                    <td>{band.role}</td>
                    <td className="mono">{band.fromYear ?? "—"}{band.isCurrent ? "–presente" : band.toYear ? `–${band.toYear}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Créditos de disco <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({person.albumCredits.length})</span></h2>
        {person.albumCredits.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin créditos registrados.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Disco</th><th>Artista</th><th>Tipo</th><th>Rol</th></tr></thead>
              <tbody>
                {person.albumCredits.map((credit) => (
                  <tr key={credit.id}>
                    <td><Link to={`/discos/${credit.albumId}`}>{credit.albumTitle}</Link></td>
                    <td><Link to={`/artistas/${credit.artistId}`}>{credit.artistName}</Link></td>
                    <td><span className="badge">{creditTypeLabel(credit.creditType)}</span></td>
                    <td>{credit.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Créditos de pista <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({person.trackCredits.length})</span></h2>
        {person.trackCredits.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin créditos registrados.</p> : (
          <div className="table-wrap table-wrap--scroll">
            <table>
              <thead><tr><th>Pista</th><th>Disco</th><th>Tipo</th><th>Rol</th></tr></thead>
              <tbody>
                {person.trackCredits.map((credit) => (
                  <tr key={credit.id}>
                    <td>{credit.trackTitle}</td>
                    <td><Link to={`/discos/${credit.albumId}`}>{credit.albumTitle}</Link></td>
                    <td><span className="badge">{creditTypeLabel(credit.creditType)}</span></td>
                    <td>{credit.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {person.organizations.length > 0 ? (
        <div className="section">
          <h2>Organizaciones</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Organización</th><th>Rol</th><th>Periodo</th></tr></thead>
              <tbody>
                {person.organizations.map((org) => (
                  <tr key={org.id}>
                    <td><Link to={`/organizaciones/${org.organizationId}`}>{org.organizationName}</Link></td>
                    <td>{org.role}</td>
                    <td className="mono">{org.fromYear ?? "—"}{org.toYear ? `–${org.toYear}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {editing ? (
        <EntityFormModal
          title={`Editar «${person.name}»`}
          fields={PERSON_FIELDS}
          initialValues={{
            name: person.name, nationality: person.nationality, isVenezuelan: person.isVenezuelan,
            birthDate: person.birthDate, deathDate: person.deathDate, pictureUrl: person.pictureUrl,
            biography: person.biography, notes: person.notes,
          }}
          onSubmit={(values, note) => personWrites.update(person.id, { ...values, note })}
          onSuccess={() => { setEditing(false); reload(); notify("success", "Persona actualizada."); }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Retirar «${person.name}»`}
          description="Se retira del catálogo. Si tiene créditos u otras dependencias, la API lo rechazará."
          confirmLabel="Retirar"
          danger
          onConfirm={async (note) => {
            await personWrites.remove(person.id, note);
            notify("success", "Persona retirada.");
            navigate("/personas");
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}
    </>
  );
}
