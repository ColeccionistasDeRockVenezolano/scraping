import type { ComponentType, CSSProperties } from "react";
import {
  AmazonLogo, AppleLogo, Butterfly, FacebookLogo, InstagramLogo, LinkSimple, SoundcloudLogo,
  SpotifyLogo, ThreadsLogo, TidalLogo, TiktokLogo, XLogo, YoutubeLogo, type IconProps,
} from "@phosphor-icons/react";

// Deezer y Bandcamp no están en Phosphor: se dibujan en su misma retícula
// (256×256) y con su mismo trazo «regular» (16, redondeado) para que la fila
// se lea como una sola familia junto a los demás logos.
function DeezerLogo({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" aria-hidden="true">
      <line x1="40" y1="192" x2="40" y2="168" /><line x1="84" y1="192" x2="84" y2="128" />
      <line x1="128" y1="192" x2="128" y2="96" /><line x1="172" y1="192" x2="172" y2="136" />
      <line x1="216" y1="192" x2="216" y2="64" />
    </svg>
  );
}

function BandcampLogo({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinejoin="round" aria-hidden="true">
      <path d="M88 72H232L168 184H24Z" />
    </svg>
  );
}

interface Platform { label: string; color: string; Icon: ComponentType<IconProps> }

// Color de marca: solo al pasar el cursor o enfocar; en reposo todos comparten
// el gris del tema para no romper la ficha.
const PLATFORMS: Record<string, Platform> = {
  spotify: { label: "Spotify", color: "#1db954", Icon: SpotifyLogo },
  apple_music: { label: "Apple Music", color: "#fa2d48", Icon: AppleLogo },
  deezer: { label: "Deezer", color: "#a238ff", Icon: DeezerLogo },
  youtube: { label: "YouTube", color: "#ff0033", Icon: YoutubeLogo },
  tidal: { label: "Tidal", color: "#f5f5f5", Icon: TidalLogo },
  amazon_music: { label: "Amazon Music", color: "#25d1da", Icon: AmazonLogo },
  bandcamp: { label: "Bandcamp", color: "#629aa9", Icon: BandcampLogo },
  soundcloud: { label: "SoundCloud", color: "#ff5500", Icon: SoundcloudLogo },
  instagram: { label: "Instagram", color: "#e1306c", Icon: InstagramLogo },
  facebook: { label: "Facebook", color: "#1877f2", Icon: FacebookLogo },
  x: { label: "X", color: "#f5f5f5", Icon: XLogo },
  tiktok: { label: "TikTok", color: "#25f4ee", Icon: TiktokLogo },
  threads: { label: "Threads", color: "#f5f5f5", Icon: ThreadsLogo },
  bluesky: { label: "Bluesky", color: "#0085ff", Icon: Butterfly },
};

// Orden fijo: primero las plataformas de escucha más usadas, luego las redes.
const ORDER = Object.keys(PLATFORMS);

export interface PlatformLink { platform: string; url: string; handle?: string | null }

export function platformLabel(platform: string): string {
  return PLATFORMS[platform]?.label ?? platform;
}

/** Fila de iconos enlazados a las plataformas de escucha o redes de una ficha. */
export function PlatformLinks({ links, subject }: { links: PlatformLink[]; subject: string }) {
  if (links.length === 0) return null;
  const sorted = [...links].sort((a, b) => {
    const ia = ORDER.indexOf(a.platform), ib = ORDER.indexOf(b.platform);
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  });
  return (
    <ul className="platform-links">
      {sorted.map((link) => {
        const platform = PLATFORMS[link.platform];
        const Icon = platform?.Icon ?? LinkSimple;
        const label = platform?.label ?? link.platform;
        const title = link.handle ? `${label} · @${link.handle}` : label;
        return (
          <li key={link.platform}>
            <a className="platform-links__item" href={link.url} target="_blank" rel="noreferrer noopener"
              title={title} aria-label={`${subject} en ${label}`}
              style={{ "--platform-color": platform?.color ?? "var(--text)" } as CSSProperties}>
              <Icon size={20} />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
