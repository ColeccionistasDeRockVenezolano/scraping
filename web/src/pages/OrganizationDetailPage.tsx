import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { organizationWrites, organizationsApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useMovedToRedirect } from "../lib/useMovedTo";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { LoadingState, ErrorState } from "../components/StateViews";
import { AliasEditor } from "../components/AliasEditor";
import { EntityFormModal } from "../components/EntityFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { initialOf } from "../components/EntityCard";
import { ORGANIZATION_FIELDS } from "../lib/entityFields";
import { organizationTypeLabel } from "../lib/labels";

export function OrganizationDetailPage() {
  const { id } = useParams();
  const orgId = Number(id);
  const navigate = useNavigate();
  const { isConfigured } = useOperator();
  const { notify } = useToast();
  const { data: org, loading, error, errorValue, reload } = useAsync(() => organizationsApi.get(orgId), [orgId]);
  useMovedToRedirect(errorValue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);

  if (loading) return <LoadingState />;
  if (error || !org) return <ErrorState message={error ?? "Organización no encontrada."} onRetry={reload} />;

  return (
    <>
      <Link to="/organizaciones" className="back-link">← Organizaciones</Link>

      <div className="entity-hero">
        <span className="entity-hero__art">
          {org.pictureUrl ? <img src={org.pictureUrl} alt="" /> : <span className="placeholder">{initialOf(org.name)}</span>}
        </span>
        <div>
          <h1 className="entity-hero__title">{org.name}</h1>
          <div className="entity-hero__meta">
            <span className="badge">{organizationTypeLabel(org.organizationType)}</span>
            {org.country ? <span className="badge">{org.country}</span> : null}
            {org.websiteUrl ? <a className="badge badge--outline" href={org.websiteUrl} target="_blank" rel="noreferrer">Sitio web</a> : null}
          </div>
          {org.biography ? <p className="entity-hero__desc">{org.biography}</p> : null}
        </div>
      </div>

      {isConfigured ? (
        <div className="page-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>Editar</button>
          <button type="button" className="btn btn--sm" onClick={() => setMerging(true)}>Fusionar con…</button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDeleting(true)}>Retirar</button>
        </div>
      ) : null}

      <div className="section">
        <h2>Alias</h2>
        <AliasEditor path="organizations" entityId={org.id} aliases={org.aliases} onChanged={reload} />
      </div>

      <div className="section">
        <h2>Discografía asociada <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({org.labelAlbums.length})</span></h2>
        {org.labelAlbums.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin discos como sello.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Disco</th><th>Artista</th><th className="num">Año</th></tr></thead>
              <tbody>
                {org.labelAlbums.map((album) => (
                  <tr key={album.albumId}>
                    <td><Link to={`/discos/${album.albumId}`}>{album.title}</Link></td>
                    <td><Link to={`/artistas/${album.artistId}`}>{album.artistName}</Link></td>
                    <td className="num">{album.releaseYear ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {org.creditedArtists.length > 0 ? (
        <div className="section">
          <h2>Artistas acreditados</h2>
          <ul style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {org.creditedArtists.map((artist) => (
              <li key={artist.artistId} className="chip"><Link to={`/artistas/${artist.artistId}`}>{artist.artistName}</Link></li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="section">
        <h2>Personas relacionadas <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>({org.associatedPersons.length})</span></h2>
        {org.associatedPersons.length === 0 ? <p style={{ color: "var(--text-faint)", fontSize: 13.5 }}>Sin personas relacionadas.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Persona</th><th>Rol</th><th>Periodo</th></tr></thead>
              <tbody>
                {org.associatedPersons.map((person) => (
                  <tr key={person.id}>
                    <td><Link to={`/personas/${person.personId}`}>{person.personName}</Link></td>
                    <td>{person.role}</td>
                    <td className="mono">{person.fromYear ?? "—"}{person.toYear ? `–${person.toYear}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing ? (
        <EntityFormModal
          title={`Editar «${org.name}»`}
          fields={ORGANIZATION_FIELDS}
          initialValues={{
            name: org.name, organizationType: org.organizationType, country: org.country, websiteUrl: org.websiteUrl,
            pictureUrl: org.pictureUrl, biography: org.biography, notes: org.notes,
          }}
          onSubmit={(values, note) => organizationWrites.update(org.id, { ...values, note })}
          onSuccess={() => { setEditing(false); reload(); notify("success", "Organización actualizada."); }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Retirar «${org.name}»`}
          description="Se retira del catálogo. Si tiene discos u otras dependencias, la API lo rechazará."
          confirmLabel="Retirar"
          danger
          onConfirm={async (note) => {
            await organizationWrites.remove(org.id, note);
            notify("success", "Organización retirada.");
            navigate("/organizaciones");
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}

      {merging ? (
        <MergeEntityModal
          kind="organization"
          entityId={org.id}
          entityName={org.name}
          onMerged={(keepId) => { setMerging(false); navigate(`/organizaciones/${keepId}`, { replace: true }); }}
          onClose={() => setMerging(false)}
        />
      ) : null}
    </>
  );
}
