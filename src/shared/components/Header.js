"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import HeaderMenu from "@/shared/components/HeaderMenu";
import HeaderLanguage from "@/shared/components/HeaderLanguage";
import ThemeToggle from "@/shared/components/ThemeToggle";
import DonateModal from "@/shared/components/DonateModal";
import Button from "@/shared/components/Button";
import { applicationShell } from "@/shared/ds/application-shell.variants";
import { useHeaderSearchStore } from "@/store/headerSearchStore";

export default function Header({ onMenuClick, showMenuButton = true }) {
  const [displayName, setDisplayName] = useState("");
  const [loginMethod, setLoginMethod] = useState("");
  const [donateOpen, setDonateOpen] = useState(false);

  const shell = applicationShell();

  useEffect(() => {
    let cancelled = false;

    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDisplayName(data?.displayName || data?.samlName || data?.samlEmail || data?.oidcName || data?.oidcEmail || "");
          setLoginMethod(data?.loginMethod || "");
        }
      } catch {
        if (!cancelled) {
          setDisplayName("");
          setLoginMethod("");
        }
      }
    }

    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.assign("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    // The DS shell header: a sunken bar for navigation and global actions. The
    // page's title lives in the content area as its PageHeading.
    <header className={shell.header({ class: "z-20 flex items-center justify-between gap-3 px-4 lg:px-8" })}>
      <div className={shell.headerContainer({ class: "flex shrink-0 items-center gap-3 lg:hidden" })}>
        {showMenuButton && (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open navigation"
            className="text-foreground transition-colors hover:text-primary pointer-coarse:min-h-11"
          >
            <span className="material-symbols-outlined" aria-hidden="true">menu</span>
          </button>
        )}
      </div>

      {/* Right actions */}
      <div className={shell.headerContainer({ class: "ml-auto flex shrink-0 items-center gap-1" })}>
        {displayName && (loginMethod === "OIDC" || loginMethod === "SAML") && (
          <div
            className="hidden sm:flex items-center max-w-[220px] px-3 py-1.5 rounded-full border border-border bg-surface/70 text-xs text-text-muted truncate"
            title={displayName}
          >
            <span className="material-symbols-outlined text-[14px] mr-1.5 text-primary">person</span>
            <span className="truncate">{displayName}</span>
            <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {loginMethod}
            </span>
          </div>
        )}
        <HeaderSearch />
        <Button variant="ghost" size="sm" icon="volunteer_activism" onClick={() => setDonateOpen(true)} aria-label="Donate">
          <span className="hidden sm:inline">Donate</span>
        </Button>
        <ThemeToggle />
        <HeaderLanguage />
        <HeaderMenu onLogout={handleLogout} />
      </div>
      <DonateModal isOpen={donateOpen} onClose={() => setDonateOpen(false)} />
    </header>
  );
}

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);

  if (!visible) return null;

  return (
    <div className="relative w-[160px] sm:w-[220px]">
      <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-text-muted text-[16px] pointer-events-none">
        search
      </span>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full h-8 pl-7 pr-7 rounded-lg border border-border bg-surface/60 text-sm focus:outline-none focus:border-primary/50 transition-colors"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main p-0.5 rounded"
          aria-label="Clear search"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      )}
    </div>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
