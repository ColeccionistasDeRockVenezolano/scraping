import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BackLink } from "../components/BackLink";
import { GitMerge, PencilSimple, Trash } from "@phosphor-icons/react";
import { organizationWrites, organizationsApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useMovedToRedirect } from "../lib/useMovedTo";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { DetailSkeleton } from "../components/Skeletons";
import { AliasEditor } from "../components/AliasEditor";
import { EntityFormModal } from "../components/EntityFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { PersonOrgManager } from "../components/PersonOrgManager";
import { EntityHistory } from "../components/EntityHistory";
import { EntityLoadError } from "../components/RemovedEntityState";
import { initialOf } from "../components/EntityCard";
import { DeceasedMark } from "../components/DeceasedMark";
import { ORGANIZATION_FIELDS } from "../lib/entityFields";
import { EntityInfo, type InfoItem } from "../components/EntityInfo";
import { EntityTabs, TabEmpty, type TabSpec } from "../components/EntityTabs";
import { ExpandableText } from "../components/ExpandableText";
import { organizationTypeLabel } from "../lib/labels";

export function OrganizationDetailPage() {
  const { id } = useParams();
  const orgId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data: org, loading, error, errorValue, reload } = useAsync(() => organizationsApi.get(orgId), [orgId]);
  useMovedToRedirect(errorValue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);

  if (loading) return <DetailSkeleton />;
  if (error || !org) return <EntityLoadError message={error ?? "Organización no encontrada."} errorValue={errorValue} onRetry={reload} />;

  const info: InfoItem[] = [
    { label: "Tipo", value: organizationTypeLabel(org.organizationType) },
    { label: "País", value: org.country, fallback: "Sin dato" },
    { label: "Sitio web", value: org.websiteUrl ? <a href={org.websiteUrl} target="_blank" rel="noreferrer noopener">{org.websiteUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a> : null },
    { label: "Discos como sello", value: org.labelAlbums.length ? org.labelAlbums.length : null },
    { label: "Artistas acreditados", value: org.creditedArtists.length ? org.creditedArtists.length : null },
  ];

  const tabs: TabSpec[] = [
    {
      key: "discografia", label: "Discografía asociada", count: org.labelAlbums.length,
      content: org.labelAlbums.length === 0 ? <TabEmpty>Sin discos como sello.</TabEmpty> : (
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
      ),
    },
    {
      key: "artistas", label: "Artistas acreditados", count: org.creditedArtists.length,
      content: org.creditedArtists.length === 0 ? <TabEmpty>Sin artistas acreditados.</TabEmpty> : (
        <ul style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {org.creditedArtists.map((artist) => (
            <li key={artist.artistId} className="chip"><Link to={`/artistas/${artist.artistId}`}>{artist.artistName}</Link></li>
          ))}
        </ul>
      ),
    },
    {
      key: "personas", label: "Personas relacionadas", count: org.associatedPersons.length,
      content: isAdmin ? (
        <PersonOrgManager
          fixedKind="organization"
          fixedId={org.id}
          rows={org.associatedPersons.map((person) => ({
            id: person.id, role: person.role, fromYear: person.fromYear, toYear: person.toYear,
            otherId: person.personId, otherName: person.personName,
          }))}
          onChanged={reload}
          emptyText="Sin personas relacionadas."
        />
      ) : org.associatedPersons.length === 0 ? <TabEmpty>Sin personas relacionadas.</TabEmpty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Persona</th><th>Rol</th><th>Periodo</th></tr></thead>
            <tbody>
              {org.associatedPersons.map((person) => (
                <tr key={person.id}>
                  <td><Link to={`/personas/${person.personId}`}>{person.personName}</Link><DeceasedMark deceased={person.personIsDeceased} /></td>
                  <td>{person.role}</td>
                  <td className="mono">{person.fromYear ?? "—"}{person.toYear ? `–${person.toYear}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    },
    { key: "historial", label: "Historial", content: <EntityHistory entity="organization" id={org.id} /> },
  ];
  const defaultKey = tabs.find((tab) => (tab.count ?? 0) > 0)?.key ?? "discografia";

  return (
    <>
      <BackLink fallback="/organizaciones" />

      <div className="entity-hero">
        <span className="entity-hero__art">
          {org.pictureUrl ? <img src={org.pictureUrl} alt="" loading="lazy" decoding="async" /> : <span className="placeholder">{initialOf(org.name)}</span>}
        </span>
        <div>
          <h1 className="entity-hero__title">{org.name}</h1>
          <EntityInfo items={info} wide={{ label: "Alias", content: <AliasEditor path="organizations" entityId={org.id} aliases={org.aliases} onChanged={reload} /> }} />
          {org.biography ? <div className="entity-hero__bio"><ExpandableText className="entity-hero__desc" text={org.biography} /></div> : null}
        </div>
      </div>

      {isAdmin ? (
        <div className="page-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}>
            <PencilSimple size={14} weight="bold" aria-hidden="true" />Editar
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setMerging(true)}>
            <GitMerge size={14} weight="bold" aria-hidden="true" />Fusionar con…
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDeleting(true)}>
            <Trash size={14} weight="bold" aria-hidden="true" />Retirar
          </button>
        </div>
      ) : null}

      <EntityTabs tabs={tabs} defaultKey={defaultKey} />

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
