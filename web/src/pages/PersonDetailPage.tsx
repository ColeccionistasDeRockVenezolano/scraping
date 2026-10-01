import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { RewritePendingMark } from "../components/RewritePendingMark";
import { BackLink } from "../components/BackLink";
import { DeceasedMark } from "../components/DeceasedMark";
import { ArrowsSplit, GitMerge, PencilSimple, Trash } from "@phosphor-icons/react";
import { personWrites, personsApi } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useMovedToRedirect } from "../lib/useMovedTo";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { DetailSkeleton } from "../components/Skeletons";
import { AliasEditor } from "../components/AliasEditor";
import { EntityFormModal } from "../components/EntityFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { ConvertPersonModal } from "../components/ConvertPersonModal";
import { SplitPersonModal } from "../components/SplitPersonModal";
import { PersonOrgManager } from "../components/PersonOrgManager";
import { EntityHistory } from "../components/EntityHistory";
import { EntityLoadError } from "../components/RemovedEntityState";
import { entityHref } from "../lib/routes";
import { initialOf } from "../components/EntityCard";
import { PERSON_FIELDS } from "../lib/entityFields";
import { EntityInfo, type InfoItem } from "../components/EntityInfo";
import { EntityTabs, TabEmpty, type TabSpec } from "../components/EntityTabs";
import { ExpandableText } from "../components/ExpandableText";
import { creditTypeLabel, membershipNoun, nameClassLabel } from "../lib/labels";
import { ageText, formatDate } from "../lib/format";

export function PersonDetailPage() {
  const { id } = useParams();
  const personId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data: person, loading, error, errorValue, reload } = useAsync(() => personsApi.get(personId), [personId]);
  useMovedToRedirect(errorValue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [converting, setConverting] = useState<"organization" | "artist" | null>(null);

  if (loading) return <DetailSkeleton />;
  if (error || !person) return <EntityLoadError message={error ?? "Persona no encontrada."} errorValue={errorValue} onRetry={reload} />;

  const dead = person.isDeceased === true;
  // Un solista no está «en una banda»: está al frente de su proyecto, y si la
  // persona ES el artista (caso Ashwave) las dos fichas son la misma identidad
  // repartida en dos tipos. El vínculo se nombra por lo que es.
  const vinculo = membershipNoun(person.bands);
  const info: InfoItem[] = [
    { label: "Nacionalidad", value: person.nationality, fallback: "Sin dato" },
    { label: "Venezolano/a", value: person.isVenezuelan === true ? "Sí" : person.isVenezuelan === false ? "No (extranjero/a)" : null, fallback: "Sin dato" },
    { label: "Estado", value: dead ? "Fallecido/a" : null, fallback: "Sin dato" },
    { label: "Nacimiento", value: formatDate(person.birthDate) },
    { label: "Fallecimiento", value: dead ? formatDate(person.deathDate) : null },
    { label: dead ? "Edad al fallecer" : "Edad", value: dead && !person.deathDate ? null : ageText(person.birthDate, dead ? person.deathDate : null) },
    { label: person.bands.length === 1 ? vinculo.singular : vinculo.plural, value: person.bands.length ? (
      <>
        {[...new Map(person.bands.map((band) => [band.artistId, band])).values()].slice(0, 4).map((band, index) => (
          <span key={band.artistId}>{index > 0 ? ", " : ""}<Link to={`/artistas/${band.artistId}`}>{band.artistName}</Link></span>
        ))}
        {new Set(person.bands.map((band) => band.artistId)).size > 4 ? ` y ${new Set(person.bands.map((band) => band.artistId)).size - 4} más` : ""}
      </>
    ) : null },
  ];

  const bandPeriod = (band: { fromYear: number | null; toYear: number | null; isCurrent: boolean }) =>
    `${band.fromYear ?? "—"}${band.isCurrent ? "–presente" : band.toYear ? `–${band.toYear}` : ""}`;

  const tabs: TabSpec[] = [
    {
      key: "bandas", label: person.bands.length === 1 ? vinculo.singular : vinculo.plural, count: person.bands.length,
      content: person.bands.length === 0 ? <TabEmpty>Sin bandas ni proyectos registrados.</TabEmpty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{vinculo.singular}</th><th>Rol</th><th>Periodo</th></tr></thead>
            <tbody>
              {person.bands.map((band) => (
                <tr key={band.id}>
                  <td><Link to={`/artistas/${band.artistId}`}>{band.artistName}</Link></td>
                  <td>{band.role}</td>
                  <td className="mono">{bandPeriod(band)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    },
    {
      key: "discos", label: "Créditos de disco", count: person.albumCredits.length,
      content: person.albumCredits.length === 0 ? <TabEmpty>Sin créditos registrados.</TabEmpty> : (
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
      ),
    },
    {
      key: "pistas", label: "Créditos de pista", count: person.trackCredits.length,
      content: person.trackCredits.length === 0 ? <TabEmpty>Sin créditos registrados.</TabEmpty> : (
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
      ),
    },
    {
      key: "organizaciones", label: "Organizaciones", count: person.organizations.length,
      content: isAdmin ? (
        <PersonOrgManager
          fixedKind="person"
          fixedId={person.id}
          rows={person.organizations.map((org) => ({
            id: org.id, role: org.role, fromYear: org.fromYear, toYear: org.toYear,
            otherId: org.organizationId, otherName: org.organizationName,
          }))}
          onChanged={reload}
          emptyText="Sin organizaciones registradas."
        />
      ) : person.organizations.length === 0 ? <TabEmpty>Sin vínculos con organizaciones.</TabEmpty> : (
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
      ),
    },
    { key: "historial", label: "Historial", content: <EntityHistory entity="person" id={person.id} /> },
  ];
  // La pestaña inicial es la primera con datos: una persona sin bandas abre en sus créditos.
  const defaultKey = tabs.find((tab) => (tab.count ?? 0) > 0)?.key ?? "bandas";

  return (
    <>
      <BackLink fallback="/personas" />

      <div className="entity-hero">
        <span className="entity-hero__art">
          {person.pictureUrl ? <img src={person.pictureUrl} alt="" loading="lazy" decoding="async" /> : <span className="placeholder">{initialOf(person.name)}</span>}
        </span>
        <div>
          <h1 className="entity-hero__title">{person.name}<DeceasedMark deceased={person.isDeceased} /></h1>
          <EntityInfo items={info} wide={{ label: "Alias", content: <AliasEditor path="persons" entityId={person.id} aliases={person.aliases} onChanged={reload} /> }} />
          {person.biography ? <div className="entity-hero__bio"><ExpandableText className="entity-hero__desc" text={person.biography} /></div> : null}
          <RewritePendingMark kind="person" id={person.id} onDone={reload} />
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
          <button type="button" className="btn btn--sm" onClick={() => setSplitting(true)}>
            <ArrowsSplit size={14} weight="bold" aria-hidden="true" />Dividir en varias…
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDeleting(true)}>
            <Trash size={14} weight="bold" aria-hidden="true" />Retirar
          </button>
        </div>
      ) : null}

      {person.nameClass !== "ok" ? (
        <div className="alert-block" role="alert" style={{ marginTop: 14 }}>
          <strong>Este nombre no parece de una persona: {nameClassLabel(person.nameClass).toLowerCase()}.</strong>
          <p style={{ margin: "6px 0 0" }}>{person.nameClassReason}</p>
          {isAdmin ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button type="button" className="btn btn--sm" onClick={() => setConverting("organization")}>Convertir en organización…</button>
              <button type="button" className="btn btn--sm" onClick={() => setConverting("artist")}>Convertir en artista…</button>
            </div>
          ) : null}
        </div>
      ) : null}

      <EntityTabs tabs={tabs} defaultKey={defaultKey} />

      {editing ? (
        <EntityFormModal
          title={`Editar «${person.name}»`}
          fields={PERSON_FIELDS}
          initialValues={{
            name: person.name, nationality: person.nationality, isVenezuelan: person.isVenezuelan, isDeceased: person.isDeceasedFlag ?? null,
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

      {merging ? (
        <MergeEntityModal
          kind="person"
          entityId={person.id}
          entityName={person.name}
          onMerged={(keepId) => { setMerging(false); navigate(`/personas/${keepId}`, { replace: true }); }}
          onClose={() => setMerging(false)}
        />
      ) : null}

      {splitting ? (
        <SplitPersonModal
          personId={person.id}
          personName={person.name}
          onSplit={(result) => {
            setSplitting(false);
            if (result.targetIds.length) navigate(`/personas/${result.targetIds[0]}`, { replace: true });
          }}
          onClose={() => setSplitting(false)}
        />
      ) : null}

      {converting ? (
        <ConvertPersonModal
          person={{ id: person.id, name: person.name, nameClassReason: person.nameClassReason }}
          kind={converting}
          onConverted={(result) => {
            setConverting(null);
            navigate(entityHref(result.targetKind, result.targetId), { replace: true });
          }}
          onClose={() => setConverting(null)}
        />
      ) : null}
    </>
  );
}
