import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { RewritePendingMark } from "../components/RewritePendingMark";
import { BackLink } from "../components/BackLink";
import { ArrowsOutSimple, GitMerge, PencilSimple, Trash } from "@phosphor-icons/react";
import { artistsApi, artistMemberWrites, artistWrites } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useMovedToRedirect } from "../lib/useMovedTo";
import { useOperator } from "../lib/OperatorContext";
import { useToast } from "../lib/ToastContext";
import { DetailSkeleton } from "../components/Skeletons";
import { EntityCard, initialOf } from "../components/EntityCard";
import { DeceasedMark } from "../components/DeceasedMark";
import { AliasEditor } from "../components/AliasEditor";
import { ArtistLogoButton } from "../components/ArtistLogoButton";
import { EntityFormModal } from "../components/EntityFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MergeEntityModal } from "../components/MergeEntityModal";
import { EntityHistory } from "../components/EntityHistory";
import { EntityLoadError } from "../components/RemovedEntityState";
import { EntityPicker } from "../components/EntityPicker";
import { Modal } from "../components/Modal";
import { ARTIST_FIELDS } from "../lib/entityFields";
import { EntityInfo, type InfoGroup, type InfoItem } from "../components/EntityInfo";
import { EntityTabs, TabEmpty, type TabSpec } from "../components/EntityTabs";
import { ExpandableText } from "../components/ExpandableText";
import { albumTypeLabel, artistTypeLabel } from "../lib/labels";
import { ageText, formatDate } from "../lib/format";
import { TITULAR_ROLE, type ArtistMember, type ArtistRelation, type RelatedArtist, type RelatedRule, type SimilarArtist, type SimilarRule } from "../lib/types";

const LINK_PLATFORMS = [
  { key: "youtube", label: "YouTube" },
  { key: "instagram", label: "Instagram" },
  { key: "wordpress", label: "Blog (WordPress)" },
] as const;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Qué es la otra banda respecto de esta: el linaje se lee en los dos sentidos. */
const RELATION_LABELS: Record<ArtistRelation["type"], Record<ArtistRelation["direction"], string>> = {
  successor: { later: "Proyecto sucesor", earlier: "Proyecto anterior" },
  ex_member_project: { later: "Proyecto de exintegrantes", earlier: "Banda de origen" },
  temporary_name: { later: "Nombre temporal", earlier: "Banda de origen" },
};

function relationLabel(relation: ArtistRelation): string {
  return RELATION_LABELS[relation.type][relation.direction];
}

/** Encabezado de cada regla de relacionados, en el orden en que llegan de la API. */
const RELATED_HEADINGS: Record<RelatedRule, string> = {
  lineage: "Linaje documentado",
  shared_members: "Integrantes en común",
  solo_project: "Proyecto solista de un integrante",
  shared_member: "Un integrante en común",
  collaboration: "Colaboraciones",
  guest_member: "Integrantes invitados",
  composer: "Composiciones cruzadas",
};

/** La API más antigua no manda la regla: solo había linaje e integrantes en común. */
function relatedRuleOf(item: RelatedArtist): RelatedRule {
  return item.rule ?? (item.relations?.length ? "lineage" : "shared_members");
}

function quoted(titles: Array<string | null>): string {
  return titles.filter(Boolean).map((title) => `«${title}»`).join(", ");
}

function relatedSubtitle(item: RelatedArtist): string {
  const relation = item.relations?.[0];
  const parts: string[] = [];
  if (relation) {
    const period = relation.startYear === null ? null
      : relation.endYear !== null && relation.endYear !== relation.startYear ? `${relation.startYear}–${relation.endYear}` : String(relation.startYear);
    parts.push([relation.bridgeMembers ? `Vínculo: ${relation.bridgeMembers}` : null, period].filter(Boolean).join(" · "));
  }
  if (item.sharedMembers > 0) parts.push(`${item.sharedMembers} en común: ${item.sharedMemberNames.join(", ")}`);
  const bridges = item.bridges ?? [];
  const rule = relatedRuleOf(item);
  if (rule === "collaboration" && bridges.length) parts.push(`En ${quoted(bridges.map((bridge) => bridge.album))}`);
  if ((rule === "guest_member" || rule === "composer") && bridges.length) {
    // Una persona puente con sus discos: «Persona en «A», «B»».
    const byPerson = new Map<string, Array<string | null>>();
    for (const bridge of bridges) byPerson.set(bridge.person ?? "", [...byPerson.get(bridge.person ?? "") ?? [], bridge.album]);
    const verb = rule === "composer" ? "compuso en" : "en";
    parts.push([...byPerson].map(([person, albums]) => `${person} ${verb} ${quoted(albums)}`).join(" · "));
  }
  return parts.filter(Boolean).join(" — ");
}

/** Agrupa una lista ya ordenada por regla, conservando el orden de llegada. */
function groupByRule<T, R extends string>(items: T[], ruleOf: (item: T) => R): Array<{ rule: R; items: T[] }> {
  const groups: Array<{ rule: R; items: T[] }> = [];
  for (const item of items) {
    const rule = ruleOf(item);
    const last = groups[groups.length - 1];
    if (last?.rule === rule) last.items.push(item);
    else groups.push({ rule, items: [item] });
  }
  return groups;
}

function similarHeading(rule: SimilarRule, genre: string | null, decade: number | null, city: string | null): string {
  const era = decade === null ? null : `años ${decade}`;
  switch (rule) {
    case "same_style": return ["Mismo estilo", genre, era].filter(Boolean).join(" · ");
    case "same_genre_decade": return [genre, era].filter(Boolean).join(" · ");
    case "same_compilation": return "En las mismas recopilaciones";
    case "same_producer": return "Mismo productor";
    case "same_scene": return ["Escena", city, era].filter(Boolean).join(" · ");
    case "near_decade": return [genre, "décadas vecinas"].filter(Boolean).join(" · ");
    case "same_label": return "Mismo sello";
    case "same_genre": return [genre, decade === null ? null : "otras épocas"].filter(Boolean).join(" · ");
  }
}

function similarSubtitle(item: SimilarArtist): string {
  const evidence = item.evidence ?? [];
  if (item.rule === "same_compilation" && evidence.length) return `En ${quoted(evidence)}`;
  if (item.rule === "same_producer" && evidence.length) return `Producción: ${evidence.join(", ")}`;
  if (item.rule === "same_label" && evidence.length) return `Sello: ${evidence.join(", ")}`;
  return [item.originCountry, item.startYear].filter(Boolean).join(" · ");
}

export function ArtistDetailPage() {
  const { id } = useParams();
  const artistId = Number(id);
  const navigate = useNavigate();
  const { isAdmin } = useOperator();
  const { notify } = useToast();
  const { data: artist, loading, error, errorValue, reload } = useAsync(() => artistsApi.get(artistId), [artistId]);
  useMovedToRedirect(errorValue);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [editingMember, setEditingMember] = useState<ArtistMember | null>(null);
  const [merging, setMerging] = useState(false);
  const [viewingImage, setViewingImage] = useState<"photo" | "logo" | null>(null);

  if (loading) return <DetailSkeleton />;
  if (error || !artist) return <EntityLoadError message={error ?? "Artista no encontrado."} errorValue={errorValue} onRetry={reload} />;

  const hasCurrentMember = artist.members.some((member) => member.isCurrent);
  // Una persona aparece una vez aunque tenga varias etapas en la banda
  // (Darrell Laclé en Cultura Tres: 2008–2009 y 2017–2020): sus filas van
  // juntas bajo su nombre (caso Abaddon, 2026-10-04).
  const memberGroups = groupMembersByPerson(artist.members);
  // Un artista puede ser el proyecto o el nombre artístico de una persona
  // (caso Ashwave, 2026-09-30). Entonces la ficha del proyecto es la de alguien
  // y no tiene por qué mandar a otra página a ver quién: su nombre y sus fechas
  // se muestran aquí, con el enlace a la ficha donde están sus créditos
  // (Brian, 2026-10-01, caso Canserbero: «todo en uno, sin perder nada»).
  const titular = artist.members.find((member) => member.role === TITULAR_ROLE) ?? null;
  const titularDead = titular?.personIsDeceased === true;
  const status = artist.disbandedYear ? "Disuelto" : hasCurrentMember ? "Activo" : null;
  const activeYears = artist.formedYear
    ? `${artist.formedYear}–${artist.disbandedYear ?? (status === "Activo" ? "presente" : "?")}`
    : null;
  const originInfo: InfoItem[] = [
    { label: "País de origen", value: artist.originCountry },
    { label: "Ubicación", value: artist.originCity },
    { label: "Estado", value: status, fallback: "Desconocido" },
    { label: "Formado en", value: artist.formedYear, fallback: "Sin dato" },
    { label: "Años activos", value: activeYears },
  ];
  const identityInfo: InfoItem[] = [
    { label: "Nombre real", value: titular ? <Link to={`/personas/${titular.personId}`}>{titular.personName}</Link> : null },
    // En un proyecto solista «formado en» es la carrera, y el nacimiento y el
    // fallecimiento son los de su titular: solo salen si hay quien los tenga.
    ...(titular ? [
      { label: "Nacimiento", value: formatDate(titular.personBirthDate ?? null) },
      { label: "Fallecimiento", value: titularDead ? formatDate(titular.personDeathDate ?? null) : null },
      { label: titularDead ? "Edad al fallecer" : "Edad",
        value: ageText(titular.personBirthDate ?? null, titularDead ? titular.personDeathDate ?? null : null) },
    ] satisfies InfoItem[] : []),
    // Género del artista (su trayectoria); cada disco muestra el suyo.
    { label: "Género", value: artist.genres?.length ? (
      <span className="entity-info__tags">{artist.genres.map((genre) => <span className="badge" key={genre.id}>{genre.name}</span>)}</span>
    ) : null, fallback: "Sin clasificar" },
    { label: "Tipo", value: artistTypeLabel(artist.artistType) },
    { label: "Último sello", value: artist.lastLabel ? <Link to={`/organizaciones/${artist.lastLabel.id}`}>{artist.lastLabel.name}</Link> : null, fallback: "Independiente / sin dato" },
  ];
  const infoGroups: InfoGroup[] = [
    { title: "Origen y trayectoria", items: originInfo },
    { title: "Identidad musical", items: identityInfo },
  ];
  // La API más antigua no manda estos campos: la ficha sigue abriendo sin ellos.
  const related = artist.related ?? [];
  const similar = artist.similar ?? [];
  const links = artist.links ?? [];
  const similarDecade = artist.similarDecade ?? null;
  const relatedGroups = groupByRule(related, relatedRuleOf);
  const similarGroups = groupByRule(similar, (item) => item.rule ?? "same_genre_decade");
  const linksByPlatform = LINK_PLATFORMS
    .map((platform) => ({ ...platform, items: links.filter((link) => link.platform === platform.key) }))
    .filter((group) => group.items.length > 0);

  const tabs: TabSpec[] = [
    {
      key: "discografia", label: "Discografía", count: artist.discography.length,
      content: artist.discography.length === 0 ? <TabEmpty>Sin discos registrados.</TabEmpty> : (
        <div className="grid-cards">
          {artist.discography.map((album) => (
            <EntityCard key={album.albumId} to={`/discos/${album.albumId}`} title={album.title}
              subtitle={[albumTypeLabel(album.albumType), album.releaseYear].filter(Boolean).join(" · ") || undefined}
              imageUrl={album.coverUrl} placeholder={initialOf(album.title)} />
          ))}
        </div>
      ),
    },
    {
      key: "miembros", label: "Miembros", count: memberGroups.length,
      content: (
        <>
          {isAdmin ? (
            <div className="page-actions" style={{ marginBottom: 14 }}>
              <button type="button" className="btn btn--sm" onClick={() => setAddingMember(true)}>+ Añadir miembro</button>
            </div>
          ) : null}
          {artist.members.length === 0 ? <TabEmpty>Sin miembros registrados.</TabEmpty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Persona</th><th>Rol</th><th>Periodo</th><th></th></tr></thead>
                <tbody>
                  {memberGroups.flatMap((group) => group.map((member, index) => (
                    <MemberRow key={member.id} member={member} personSpan={index === 0 ? group.length : 0}
                      canEdit={isAdmin} onEdit={() => setEditingMember(member)} onChanged={reload} />
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ),
    },
    {
      key: "relacionados", label: "Artistas relacionados", count: related.length,
      content: related.length === 0 ? <TabEmpty>Sin linajes, integrantes, colaboraciones ni invitados en común con otros artistas.</TabEmpty> : (
        <>
          {relatedGroups.map((group) => (
            <section key={group.rule}>
              <h3 className="similar-reason">{RELATED_HEADINGS[group.rule]}</h3>
              <div className="grid-cards">
                {group.items.map((item) => {
                  const relation = item.relations?.[0];
                  return (
                    <EntityCard key={item.id} to={`/artistas/${item.id}`} title={item.name} imageUrl={item.pictureUrl} placeholder={initialOf(item.name)}
                      subtitle={relatedSubtitle(item)}
                      tag={relation ? relationLabel(relation) : null}
                      tagTitle={relation?.note ?? undefined} />
                  );
                })}
              </div>
            </section>
          ))}
        </>
      ),
    },
    {
      key: "similares", label: "Artistas similares", count: similar.length,
      content: similar.length === 0 ? <TabEmpty>Aún no hay artistas del mismo género, época o escena.</TabEmpty> : (
        <>
          {similarGroups.map((group) => {
            const heading = similarHeading(group.rule, artist.primaryGenre?.name ?? null, similarDecade, artist.originCity);
            return (
              <section key={group.rule}>
                {heading ? <h3 className="similar-reason">{heading}</h3> : null}
                <div className="grid-cards">
                  {group.items.map((item) => (
                    <EntityCard key={item.id} to={`/artistas/${item.id}`} title={item.name} imageUrl={item.pictureUrl} placeholder={initialOf(item.name)}
                      subtitle={similarSubtitle(item)} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      ),
    },
    {
      key: "enlaces", label: "Enlaces", count: links.length,
      content: linksByPlatform.length === 0 ? <TabEmpty>Sin enlaces registrados.</TabEmpty> : (
        <div className="link-groups">
          {linksByPlatform.map((group) => (
            <section key={group.key}>
              <h3 className="link-group__title">{group.label}</h3>
              <ul className="link-list">
                {group.items.map((link) => (
                  <li key={`${link.albumId}-${link.platform}`}>
                    <a href={link.url} target="_blank" rel="noreferrer noopener">
                      <span>{link.albumTitle}</span>
                      <span className="link-list__host">{hostOf(link.url)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ),
    },
    { key: "historial", label: "Historial", content: <EntityHistory entity="artist" id={artist.id} /> },
  ];

  return (
    <>
      <BackLink fallback="/artistas" />

      <section className="entity-hero artist-profile" aria-label={`Ficha de ${artist.name}`}>
        <div className="artist-profile__media">
          {artist.pictureUrl ? (
            <button type="button" className="entity-hero__art artist-profile__image-button" aria-label={`Ampliar foto de ${artist.name}`} onClick={() => setViewingImage("photo")}>
              <img src={artist.pictureUrl} alt="" loading="eager" decoding="async" />
              <span className="artist-profile__photo-hint" aria-hidden="true"><ArrowsOutSimple size={16} /><span>Ampliar foto</span></span>
            </button>
          ) : <span className="entity-hero__art"><span className="placeholder">{initialOf(artist.name)}</span></span>}
          {artist.logoUrl ? (
            <ArtistLogoButton key={artist.logoUrl} src={artist.logoUrl} artistId={artist.id} name={artist.name} onOpen={() => setViewingImage("logo")} />
          ) : null}
        </div>
        <div className="artist-profile__content">
          <h1 className="entity-hero__title">{artist.name}<DeceasedMark deceased={artist.isDeceased} /></h1>
          <EntityInfo items={[]} groups={infoGroups} />
          <div className="artist-profile__aliases">
            <h2>Alias</h2>
            <AliasEditor path="artists" entityId={artist.id} aliases={artist.aliases} onChanged={reload} compactTypeLabels />
          </div>
        </div>
        {artist.biography ? <div className="artist-profile__biography entity-hero__bio"><h2>Biografía</h2><ExpandableText className="entity-hero__desc" text={artist.biography} /></div> : null}
        <RewritePendingMark kind="artist" id={artist.id} onDone={reload} />
      </section>

      {viewingImage ? (
        <Modal title={`${viewingImage === "photo" ? "Foto" : "Logo"} de ${artist.name}`} wide onClose={() => setViewingImage(null)}>
          <div className="artist-image-viewer">
            <img src={viewingImage === "photo" ? artist.pictureUrl ?? "" : artist.logoUrl ?? ""} alt={`${viewingImage === "photo" ? "Foto" : "Logo"} de ${artist.name}`} />
          </div>
        </Modal>
      ) : null}

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

      <EntityTabs tabs={tabs} defaultKey="discografia" />

      {editing ? (
        <EntityFormModal
          title={`Editar «${artist.name}»`}
          fields={ARTIST_FIELDS}
          initialValues={{
            name: artist.name, artistType: artist.artistType, originCountry: artist.originCountry, originCity: artist.originCity,
            formedYear: artist.formedYear, disbandedYear: artist.disbandedYear, pictureUrl: artist.pictureUrl,
            biography: artist.biography, notes: artist.notes,
          }}
          onSubmit={(values, note) => artistWrites.update(artist.id, { ...values, note })}
          onSuccess={() => { setEditing(false); reload(); notify("success", "Artista actualizado."); }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Retirar «${artist.name}»`}
          description="Se retira del catálogo. Si tiene discos u otras dependencias, la API lo rechazará."
          confirmLabel="Retirar"
          danger
          onConfirm={async (note) => {
            await artistWrites.remove(artist.id, note);
            notify("success", "Artista retirado.");
            navigate("/artistas");
          }}
          onClose={() => setDeleting(false)}
        />
      ) : null}

      {addingMember ? (
        <MemberFormModal artistId={artist.id} onClose={() => setAddingMember(false)} onDone={() => { setAddingMember(false); reload(); }} />
      ) : null}

      {editingMember ? (
        <MemberFormModal artistId={artist.id} member={editingMember} onClose={() => setEditingMember(null)}
          onDone={() => { setEditingMember(null); reload(); }} />
      ) : null}

      {merging ? (
        <MergeEntityModal
          kind="artist"
          entityId={artist.id}
          entityName={artist.name}
          onMerged={(keepId) => { setMerging(false); navigate(`/artistas/${keepId}`, { replace: true }); }}
          onClose={() => setMerging(false)}
        />
      ) : null}
    </>
  );
}

/** Membresías agrupadas por persona, en el orden en que aparece cada una. */
function groupMembersByPerson(members: ArtistMember[]): ArtistMember[][] {
  const groups = new Map<number, ArtistMember[]>();
  for (const member of members) groups.set(member.personId, [...(groups.get(member.personId) ?? []), member]);
  return [...groups.values()];
}

/** `personSpan` > 0: primera fila de la persona (ocupa sus etapas); 0: etapa siguiente. */
function MemberRow({ member, personSpan, canEdit, onEdit, onChanged }: {
  canEdit: boolean; onEdit: () => void; onChanged: () => void; member: ArtistMember; personSpan: number;
}) {
  const { notify } = useToast();
  const [removing, setRemoving] = useState(false);

  return (
    <tr>
      {personSpan > 0 ? (
        <td rowSpan={personSpan}><Link to={`/personas/${member.personId}`}>{member.personName}</Link><DeceasedMark deceased={member.personIsDeceased} /></td>
      ) : null}
      <td>{member.role}</td>
      <td className="mono">{member.fromYear ?? "—"}{member.isCurrent ? "–presente" : member.toYear ? `–${member.toYear}` : ""}</td>
      <td className="row-actions">
        {canEdit ? (
          <>
            <button type="button" className="btn btn--sm" onClick={onEdit} title="Corregir rol, periodo o persona">
              <PencilSimple size={14} weight="bold" aria-hidden="true" />Editar
            </button>
            <button type="button" className="btn btn--sm btn--danger" onClick={() => setRemoving(true)}>
              <Trash size={14} weight="bold" aria-hidden="true" />Quitar
            </button>
          </>
        ) : null}
      </td>
      {removing ? (
        <ConfirmDialog
          title={`Quitar a ${member.personName}`}
          description="Se retira la membresía; no borra a la persona ni sus créditos."
          confirmLabel="Quitar"
          danger
          onConfirm={async (note) => {
            await artistMemberWrites.remove(member.id, note);
            notify("success", "Miembro retirado.");
            setRemoving(false);
            onChanged();
          }}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </tr>
  );
}

/**
 * Alta y edición de una membresía. En edición solo viaja lo que cambió; la
 * persona se corrige con su extremo (la API la sustituye con auditoría).
 */
function MemberFormModal({ artistId, member, onDone, onClose }: {
  artistId: number; member?: ArtistMember; onDone: () => void; onClose: () => void;
}) {
  const editing = member !== undefined;
  const [personId, setPersonId] = useState<number | null>(member?.personId ?? null);
  const [personLabel, setPersonLabel] = useState<string | null>(member?.personName ?? null);
  const [role, setRole] = useState(member?.role ?? "");
  const [fromYear, setFromYear] = useState(member?.fromYear === null || member?.fromYear === undefined ? "" : String(member.fromYear));
  const [toYear, setToYear] = useState(member?.toYear === null || member?.toYear === undefined ? "" : String(member.toYear));
  const [isCurrent, setIsCurrent] = useState(member?.isCurrent ?? false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const currentId = useId();
  const roleId = useId();
  const fromId = useId();
  const toId = useId();
  const noteId = useId();
  const { notify } = useToast();

  function parseYear(value: string): number | null {
    const text = value.trim();
    if (!text) return null;
    return Number(text);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (personId === null || !role.trim()) { setError("Persona y rol son obligatorios."); return; }
    const nextFrom = parseYear(fromYear);
    const nextTo = isCurrent ? null : parseYear(toYear);
    if ((nextFrom !== null && (!Number.isInteger(nextFrom) || nextFrom < 1000 || nextFrom > 9999))
      || (nextTo !== null && (!Number.isInteger(nextTo) || nextTo < 1000 || nextTo > 9999))) {
      setError("Los años van de 1000 a 9999."); return;
    }
    if (nextFrom !== null && nextTo !== null && nextTo < nextFrom) { setError("El año final no puede ser anterior al inicial."); return; }
    if (!note.trim()) { setError("El motivo es obligatorio."); return; }
    setBusy(true);
    setError(undefined);
    try {
      if (!member) {
        await artistMemberWrites.create({
          artistId, personId, role: role.trim(), isCurrent,
          ...(nextFrom === null ? {} : { fromYear: nextFrom }),
          ...(nextTo === null ? {} : { toYear: nextTo }),
          note: note.trim(),
        });
        notify("success", "Miembro añadido.");
      } else {
        const changes: Record<string, unknown> = {};
        if (personId !== member.personId) changes["personId"] = personId;
        if (role.trim() !== member.role) changes["role"] = role.trim();
        if (nextFrom !== member.fromYear) changes["fromYear"] = nextFrom;
        if (nextTo !== member.toYear) changes["toYear"] = nextTo;
        if (isCurrent !== member.isCurrent) changes["isCurrent"] = isCurrent;
        if (Object.keys(changes).length === 0) { setError("No hay cambios que guardar."); setBusy(false); return; }
        await artistMemberWrites.update(member.id, { ...changes, note: note.trim() });
        notify("success", "Miembro actualizado.");
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Corregir membresía de ${member.personName}` : "Añadir miembro"} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {error ? <p className="form-error-banner" role="alert">{error}</p> : null}
        <EntityPicker kind="person" label="Persona *" value={personId} valueLabel={personLabel}
          onSelect={(id, label) => { setPersonId(id); setPersonLabel(label); }} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor={roleId}>Rol *</label><input id={roleId} value={role} onChange={(event) => setRole(event.target.value)} placeholder="Guitarra, voz…" /></div>
          <div className="field"><label htmlFor={fromId}>Desde (año)</label><input id={fromId} type="number" value={fromYear} onChange={(event) => setFromYear(event.target.value)} /></div>
          <div className="field"><label htmlFor={toId}>Hasta (año)</label><input id={toId} type="number" value={isCurrent ? "" : toYear} disabled={isCurrent} onChange={(event) => setToYear(event.target.value)} /></div>
          <div className="checkbox-field field">
            <input id={currentId} type="checkbox" checked={isCurrent} onChange={(event) => setIsCurrent(event.target.checked)} />
            <label htmlFor={currentId}>Miembro actual</label>
          </div>
          <div className="field span-2">
            <label htmlFor={noteId}>Motivo *</label>
            <textarea id={noteId} rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar corrección" : "Añadir"}</button>
        </div>
      </form>
    </Modal>
  );
}
