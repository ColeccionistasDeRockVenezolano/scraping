import { useEffect, useRef, useState } from "react";
import { ArrowsOutSimple } from "@phosphor-icons/react";
import { classifyLogoAspect, knownLogoAspect, type LogoAspect } from "../lib/logoAspect";

export function ArtistLogoButton({ src, artistId, name, onOpen }: { src: string; artistId: number; name: string; onOpen: () => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const catalogAspect = knownLogoAspect(src, artistId);
  const [detectedAspect, setDetectedAspect] = useState<LogoAspect | null>(null);
  const aspect = catalogAspect ?? detectedAspect;

  useEffect(() => {
    const image = imageRef.current;
    if (!catalogAspect && image?.complete && image.naturalWidth && image.naturalHeight) {
      setDetectedAspect(classifyLogoAspect(image.naturalWidth, image.naturalHeight));
    }
  }, [src, catalogAspect]);

  return (
    <button type="button" className={`entity-hero__logo artist-profile__image-button artist-profile__logo--${aspect ?? "pending"}`}
      style={{ width: 88, height: aspect === "wide" ? 30 : 88 }}
      aria-label={`Ampliar logo de ${name}`} onClick={onOpen}>
      <img ref={imageRef} src={src} alt="" loading="eager" decoding="async" onLoad={(event) => {
        const image = event.currentTarget;
        if (!catalogAspect && image.naturalWidth && image.naturalHeight) {
          setDetectedAspect(classifyLogoAspect(image.naturalWidth, image.naturalHeight));
        }
      }} />
      <ArrowsOutSimple className="artist-profile__logo-hint" size={14} weight="bold" aria-hidden="true" />
    </button>
  );
}
