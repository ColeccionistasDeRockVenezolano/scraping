// CRV · Curaduría: portadas y fotos de artista para elegir a ojo (Brian, 2026-10-04).
//
// La mejora de portadas pequeñas aplicó sola las coincidencias claras; aquí
// llegan las dudosas (misma portada con otro recorte, otra edición, escaneo
// distinto…) y los artistas con más de una foto de perfil en las fuentes. Cada
// tarjeta pone la imagen actual al lado de las candidatas: «Usar esta» la
// cambia en la ficha (un run, con «Deshacer» en la barra de abajo) y «Dejar la
// actual» solo descarta las candidatas. Nada cambia sin una decisión.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowSquareOut, Check, Warning, X } from "@phosphor-icons/react";
import { ApiError, imageCandidatesApi, type ImageCandidate, type ImageCandidateGroup, type ImageCandidateKind } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../lib/ToastContext";
import { formatCount } from "../lib/curation";
import { EmptyState, ErrorState } from "../components/StateViews";
import { RowsSkeleton } from "../components/Skeletons";
import { Pagination } from "../components/Pagination";

const LIMIT = 20;
const TABS: ReadonlyArray<{ kind: ImageCandidateKind; param: string; label: string }> = [
  { kind: "album", param: "portadas", label: "Portadas" },
  { kind: "artist", param: "fotos", label: "Fotos de artista" },
];
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  deezer: "Deezer", musicbrainz: "MusicBrainz", discogs: "Discogs", spotify: "Spotify",
};

export function CurationImagesPage() {
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((entry) => entry.param === params.get("tipo")) ?? TABS[0]!;
  const [offset, setOffset] = useState(0);
  // Fichas ya decididas en esta vista: desaparecen al momento, sin esperar la recarga.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(() => imageCandidatesApi.list(tab.kind, { limit: LIMIT, offset }), [tab.kind, offset]);
  const counts = useAsync(() => imageCandidatesApi.summary(), [data]);

  useEffect(() => { setOffset(0); }, [tab.kind]);
  useEffect(() => { setDecided(new Set()); }, [data]);

  async function decide(group: ImageCandidateGroup, candidate: ImageCandidate | null) {
    const key = `${group.kind}:${group.entityId}`;
    setBusy(key);
    try {
      await imageCandidatesApi.decide(group.kind, group.entityId, candidate?.id ?? null);
      setDecided((previous) => new Set(previous).add(key));
      notify("success", candidate
        ? `${group.kind === "album" ? "Portada" : "Foto"} de «${group.name}» cambiada.`
        : `«${group.name}» se queda con su ${group.kind === "album" ? "portada" : "foto"} actual.`);
      counts.reload();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "No se pudo guardar la decisión.");
      if (err instanceof ApiError && err.status === 409) reload();
    } finally {
      setBusy(null);
    }
  }

  const visible = data?.data.filter((group) => !decided.has(`${group.kind}:${group.entityId}`)) ?? [];
  const pending = data ? Math.max(0, data.pagination.total - decided.size) : undefined;

  return (
    <>
      <p className="curation-lead">
        Portadas que podrían cambiarse por la misma en mejor calidad y artistas con más de una foto en las fuentes.
        Compara la imagen actual con las candidatas y elige: «Usar esta» la cambia en la ficha y se puede deshacer;
        «Dejar la actual» descarta las candidatas.
      </p>

      <div className="list-toolbar">
        <div className="segmented" role="group" aria-label="Tipo de imagen">
          {TABS.map((entry) => (
            <button
              key={entry.kind} type="button" className="segmented__option" aria-pressed={entry.kind === tab.kind}
              onClick={() => setParams(entry === TABS[0] ? {} : { tipo: entry.param })}
            >
              {entry.label}
              {counts.data ? <span className="segmented__range">{formatCount(counts.data[entry.kind])}</span> : null}
            </button>
          ))}
        </div>
        {pending !== undefined && !loading ? (
          <p className="dup-count" aria-live="polite">{formatCount(pending)} {pending === 1 ? "ficha pendiente" : "fichas pendientes"}</p>
        ) : null}
      </div>

      {loading && !data ? <RowsSkeleton rows={3} height={260} label="Cargando las imágenes candidatas…" /> : error ? <ErrorState message={error} onRetry={reload} /> : visible.length === 0 ? (
        data && data.pagination.total > decided.size ? (
          <div className="img-pick__more">
            <button type="button" className="btn btn--outline" onClick={reload}>Cargar las siguientes</button>
          </div>
        ) : (
          <EmptyState
            title={tab.kind === "album" ? "No hay portadas por elegir" : "No hay fotos de artista por elegir"}
            hint="Cuando una búsqueda de imágenes deje candidatas dudosas, aparecerán aquí."
          />
        )
      ) : (
        <>
          <ol className={`img-pick-list${loading ? " is-refreshing" : ""}`}>
            {visible.map((group) => {
              const key = `${group.kind}:${group.entityId}`;
              return (
                <li key={key}>
                  <ImageGroupCard group={group} busy={busy === key} disabled={busy !== null} onDecide={(candidate) => void decide(group, candidate)} />
                </li>
              );
            })}
          </ol>
          <Pagination limit={LIMIT} offset={offset} total={data?.pagination.total ?? 0} onOffsetChange={setOffset} />
        </>
      )}
    </>
  );
}

function ImageGroupCard({ group, busy, disabled, onDecide }: {
  group: ImageCandidateGroup; busy: boolean; disabled: boolean; onDecide: (candidate: ImageCandidate | null) => void;
}) {
  const href = group.kind === "album" ? `/discos/${group.entityId}` : `/artistas/${group.entityId}`;
  return (
    <article className="img-pick" aria-busy={busy}>
      <header className="img-pick__head">
        <div>
          <h3 className="img-pick__title"><Link to={href}>{group.name}</Link></h3>
          {group.subtitle ? <p className="img-pick__meta">{group.subtitle}</p> : null}
        </div>
        <button type="button" className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => onDecide(null)}>
          <X size={14} weight="bold" aria-hidden="true" />
          Dejar la actual
        </button>
      </header>
      {group.stale ? (
        <p className="img-pick__stale">
          <Warning size={15} weight="bold" aria-hidden="true" />
          La imagen de esta ficha cambió desde que se propusieron las candidatas: solo se puede dejar la actual.
        </p>
      ) : null}
      <div className="img-pick__grid">
        <ImageTile label="Actual" url={group.currentUrl} current />
        {group.candidates.map((candidate) => (
          <ImageTile
            key={candidate.id}
            label={SOURCE_LABEL[candidate.source] ?? candidate.source}
            url={candidate.url}
            pageUrl={candidate.pageUrl}
            score={candidate.score}
            size={candidate.width && candidate.height ? [candidate.width, candidate.height] : null}
            action={group.stale ? null : (
              <button type="button" className="btn btn--primary btn--sm btn--block" disabled={disabled} onClick={() => onDecide(candidate)}>
                <Check size={14} weight="bold" aria-hidden="true" />
                Usar esta
              </button>
            )}
          />
        ))}
      </div>
    </article>
  );
}

function ImageTile({ label, url, pageUrl = null, score = null, size = null, current = false, action = null }: {
  label: string; url: string | null; pageUrl?: string | null; score?: number | null; size?: [number, number] | null;
  current?: boolean; action?: ReactNode;
}) {
  // El tamaño real se mide al cargar: la base no lo guarda para la imagen actual.
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = size ?? natural;
  return (
    <figure className={`img-tile${current ? " img-tile--current" : ""}`}>
      <a className="img-tile__frame" href={url ?? undefined} target="_blank" rel="noreferrer" title="Abrir la imagen a tamaño completo">
        {url && !failed ? (
          <img
            src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
            onLoad={(event) => setNatural([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])}
            onError={() => setFailed(true)}
          />
        ) : <span className="img-tile__empty">{failed ? "No carga" : "Sin imagen"}</span>}
      </a>
      <figcaption className="img-tile__caption">
        <span className="img-tile__label">{label}</span>
        <span className="img-tile__facts">
          {shown ? `${shown[0]}×${shown[1]} px` : "—"}
          {score !== null ? ` · parecido ${Math.round(score * 100)} %` : ""}
        </span>
        {pageUrl ? (
          <a className="img-tile__source" href={pageUrl} target="_blank" rel="noreferrer">
            Ver en la fuente <ArrowSquareOut size={12} weight="bold" aria-hidden="true" />
          </a>
        ) : null}
      </figcaption>
      {action}
    </figure>
  );
}
