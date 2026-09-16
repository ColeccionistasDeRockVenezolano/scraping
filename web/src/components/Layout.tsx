import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Buildings, Disc, MagnifyingGlass, Stack, User, UsersThree, type Icon } from "@phosphor-icons/react";
import { OperatorPill } from "./OperatorSettings";
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
];

export function Layout({ children }: { children: ReactNode }) {
  const { isAdmin } = useOperator();
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
  return (
    <>
      <header className="topbar">
        <div className="container topbar-row">
          <NavLink to="/" className="brand">
            <span className="brand-badge">CRV</span>
            <span className="brand-text">
              <strong>Coleccionistas De Rock Venezolano</strong>
              <span>Catálogo</span>
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
    </>
  );
}
