"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["textClassification", "embedding", "image", "video", "tts", "stt"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

const operateItems = [
  { href: "/dashboard", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/combos", label: "Routing Combos", icon: "layers" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
];

const toolItems = [
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

const systemItems = [
  { href: "/dashboard/setup", label: "Setup", icon: "route" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/endpoint", label: "Endpoint & Keys", icon: "api" },
];

const adminSystemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
];

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [enableTranslator, setEnableTranslator] = useState(false);
  // While resource scoping is on, shared-infrastructure entries are admin-only.
  // The proxy enforces the same list; hiding them here only avoids dead links.
  // Settings lives in the same section and stays visible to everyone.
  const [showAdminItems, setShowAdminItems] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then(res => res.json())
      .then(data => { if (data.enableTranslator) setEnableTranslator(true); })
      .catch(() => {});
  }, []);

  // Hide shared-infrastructure controls from scoped non-admin users.
  useEffect(() => {
    fetch("/api/auth/status")
      .then(res => res.json())
      .then(data => setShowAdminItems(!data?.scopeResourcesByUser || !!data?.isAdmin))
      .catch(() => {});
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  };

  const renderLinks = (label, items) => (
    <section className="mb-5" aria-labelledby={`nav-${label.toLowerCase()}`}>
      <h2 id={`nav-${label.toLowerCase()}`} className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/70">{label}</h2>
      <div className="space-y-0.5">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-md px-3 transition-colors group focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2",
              isActive(item.href) ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text-main"
            )}
          >
            <span className={cn("material-symbols-outlined text-[18px]", isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors")}>{item.icon}</span>
            <span className="text-[13px] font-medium whitespace-nowrap">{item.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );

  return (
    <aside className="flex w-72 flex-col border-r border-border-subtle bg-surface transition-colors duration-300 min-h-full">
        <div className="border-b border-border-subtle px-5 py-5">
          <Link href="/dashboard" className="inline-flex min-h-11 items-center text-text-main focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2">
            <span className="text-lg font-semibold tracking-tight">{APP_CONFIG.name}</span>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-5 overflow-y-auto custom-scrollbar" aria-label="Primary navigation">
          {renderLinks("Operate", operateItems)}

          {/* System section */}
          <div className="pt-3 mt-2 space-y-0.5">
            <p className="px-3 text-[10px] font-semibold text-text-muted/70 uppercase tracking-[0.14em] mb-2">
              System
            </p>

            {/* Media Providers accordion */}
            {showAdminItems && (<>
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "w-full flex min-h-11 items-center gap-3 px-3 rounded-md transition-colors group",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <span className="text-[13px] font-medium flex-1 text-left">Media Providers</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            {mediaOpen && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    onClick={onClose}
                    className={cn(
                      "flex min-h-11 items-center gap-3 px-4 rounded-md transition-colors group",
                      pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <span className="text-sm">{kind.label}</span>
                  </Link>
                ))}
                <Link
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  onClick={onClose}
                  className={cn(
                    "flex min-h-11 items-center gap-3 px-4 rounded-md transition-colors group",
                    pathname.startsWith(COMBINED_WEB_ITEM.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">{COMBINED_WEB_ITEM.icon}</span>
                  <span className="text-sm">{COMBINED_WEB_ITEM.label}</span>
                </Link>
              </div>
            )}
            </>)}

            {systemItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "flex min-h-11 items-center gap-3 px-3 rounded-md transition-colors group",
                  isActive(item.href)
                    ? "bg-primary/10 text-primary"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                <span
                  className={cn(
                    "material-symbols-outlined text-[18px]",
                    isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                  )}
                >
                  {item.icon}
                </span>
                <span className="text-[13px] font-medium">{item.label}</span>
              </Link>
            ))}

            {(showAdminItems ? adminSystemItems : []).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "flex min-h-11 items-center gap-3 px-3 rounded-md transition-colors group",
                  isActive(item.href)
                    ? "bg-primary/10 text-primary"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                <span className={cn("material-symbols-outlined text-[18px]", isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors")}>{item.icon}</span>
                <span className="text-[13px] font-medium">{item.label}</span>
              </Link>
            ))}

            {/* Debug items (inside System section, before Settings) */}
            {(showAdminItems ? debugItems : []).map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "flex min-h-11 items-center gap-3 px-3 rounded-md transition-colors group",
                    isActive(item.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  <span className="text-[13px] font-medium">{item.label}</span>
                </Link>
              ) : null;
            })}

            {/* Settings — global configuration, so admin-only while scoping is on */}
            {showAdminItems && (
            <Link
              href="/dashboard/profile"
              onClick={onClose}
              className={cn(
                "flex min-h-11 items-center gap-3 px-3 rounded-md transition-colors group",
                isActive("/dashboard/profile")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                settings
              </span>
              <span className="text-[13px] font-medium">Settings</span>
            </Link>
            )}
          </div>

          {renderLinks("Tools", toolItems)}
        </nav>

    </aside>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};
