import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Buildings, ClockCounterClockwise, Disc, MagnifyingGlass, Stack, User, UsersThree, type Icon } from "@phosphor-icons/react";
import { OperatorPill } from "./OperatorSettings";
import { UndoBar } from "./UndoBar";
import { useOperator } from "../lib/OperatorContext";

interface NavItem { to: string; label: string; mobileLabel?: string; end?: boolean; icon: Icon; adminOnly?: boolean }

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: "/", label: "Buscar", end: true, icon: MagnifyingGlass },
  { to: "/artistas", label: "Artistas", icon: UsersThree },
  { to: "/discos", label: "Discos", icon: Disc },
  { to: "/personas", label: "Personas", icon: User },
  { to: "/organizaciones", label: "Organizaciones", mobileLabel: "Organiz.", icon: Buildings },
  // Revisión y Duplicados viven dentro, como pestañas (CurationLayout).
  { to: "/curaduria", label: "Curaduría", mobileLabel: "Curad.", icon: Stack, adminOnly: true },
  // Todo cambio del catálogo, con su «Deshacer» / «Rehacer».
  { to: "/historial", label: "Historial", mobileLabel: "Hist.", icon: ClockCounterClockwise, adminOnly: true },
];

export function Layout({ children }: { children: ReactNode }) {
  const { isAdmin } = useOperator();
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
  return (
    <>
      <header className="topbar">
        <div className="container topbar-row">
          <NavLink to="/" className="brand">
            <span className="brand-logo" aria-hidden="true">
              <img src={`${import.meta.env.BASE_URL}crv-logo.jpg`} alt="" width="160" height="160" />
            </span>
            <span className="brand-text">
              <strong>Coleccionistas</strong>
              <span>de Rock Venezolano · Catálogo</span>
            </span>
          </NavLink>
          <nav className="main-nav" aria-label="Principal">
            {items.map((item) => (
              <NavLink key={item.to} to={item.to} {...(item.end === undefined ? {} : { end: item.end })} className={({ isActive }) => (isActive ? "active" : "")}>
                <item.icon className="nav-icon" aria-hidden="true" weight="bold" />
                <span className="nav-label">{item.label}</span>
                <span className="nav-label-mobile">{item.mobileLabel ?? item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="topbar-actions">
            <OperatorPill />
          </div>
        </div>
      </header>
      <main>
        <div className="container">{children}</div>
      </main>
      <UndoBar />
    </>
  );
}
