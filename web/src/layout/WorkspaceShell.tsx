import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Eye, LogOut, Menu, PanelRight, ShieldCheck, X } from "lucide-react";
import { getToken, setToken } from "../api";
import { Sidebar } from "./Sidebar";

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="workspace-shell">
      <header className="workspace-topbar">
        <button
          className="icon-button mobile-only"
          type="button"
          aria-label="Open project navigation"
          title="Open project navigation"
          onClick={() => setNavOpen(true)}
        >
          <Menu size={17} />
        </button>

        <Link className="workspace-brand" to="/projects" aria-label="pir review home">
          <span className="brand-mark"><ShieldCheck size={17} /></span>
          <span className="brand-name">pir</span>
          <span className="brand-context">review</span>
        </Link>

        <div className="topbar-divider" />
        <div className="topbar-context">Review workspace</div>

        <div className="topbar-actions">
          <span className="readonly-indicator"><Eye size={13} /> Read only</span>
          {getToken() !== null && (
            <button
              className="icon-button"
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => {
                setToken(null);
                window.location.href = "/login";
              }}
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </header>

      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

      {navOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="Close project navigation"
          onClick={() => setNavOpen(false)}
        >
          <X className="sr-only" size={16} />
        </button>
      )}

      <main className="workspace-main">{children}</main>
    </div>
  );
}

export function InspectorToggle({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`icon-button ${open ? "is-active" : ""}`}
      type="button"
      aria-label={open ? "Close inspector" : "Open inspector"}
      title={open ? "Close inspector" : "Open inspector"}
      onClick={onClick}
    >
      <PanelRight size={16} />
    </button>
  );
}
