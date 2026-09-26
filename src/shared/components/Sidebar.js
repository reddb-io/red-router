"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { navItem } from "@/shared/ds/nav-item.variants";
<<<<<<< HEAD
import { BrandMark } from "@/shared/components/BrandingProvider";
||||||| e6e8d110
import { APP_CONFIG } from "@/shared/constants/config";
=======
import { APP_CONFIG } from "@/shared/constants/config";
>>>>>>> feat/ds-v2026.09
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import Icon from "./Icon";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["systemone", "embedding", "image", "video", "tts", "stt"];
// Combined entry: webSearch + webFetch share one page at /dashboard/tools-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/tools-providers/web" };

const operateItems = [
  { href: "/dashboard", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/combos", label: "Routing Combos", icon: "layers" },
  // Admin-only while resource scoping is on (the proxy enforces it).
  { href: "/dashboard/models", label: "Models", icon: "view_list", adminOnly: true },
  { href: "/dashboard/autopilot", label: "Autopilot", icon: "auto_awesome", adminOnly: true },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  { href: "/dashboard/endpoint", label: "Endpoint & Keys", icon: "api" },
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
];

const adminSystemItems = [
  { href: "/dashboard/usage-sinks", label: "Usage Sinks", icon: "outbox" },
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

<<<<<<< HEAD
  const linkClass = (active, extra = "") =>
    // DS NavItem: compact rows with a pointer, 44px targets on touch (design.md).
    navItem({ active }).root({ class: cn("group flex items-center gap-3 pointer-coarse:min-h-11", extra) });

  const renderLink = (item) => {
    const active = isActive(item.href);
    return (
      <Link key={item.href} href={item.href} onClick={onClose} className={linkClass(active)} aria-current={active ? "page" : undefined}>
        <Icon name={item.icon} size={18} />
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  const renderSection = (label, children) => {
    const id = `nav-${label.toLowerCase()}`;
    return (
      <section aria-labelledby={id} className="flex flex-col gap-0.5">
        <h2 id={id} className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">{label}</h2>
        {children}
      </section>
    );
  };

  const toolsProvidersActive = pathname.startsWith("/dashboard/tools-providers");
  const visibleDebugItems = debugItems.filter((item) => item.href !== "/dashboard/translator" || enableTranslator);
||||||| e6e8d110
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
=======
  const renderLinks = (label, items) => (
    <section className="mb-5" aria-labelledby={`nav-${label.toLowerCase()}`}>
      <h2 id={`nav-${label.toLowerCase()}`} className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/70">{label}</h2>
      <div className="space-y-0.5">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className={navItem({ active: isActive(item.href) }).root({ class: "flex min-h-11 items-center gap-3 px-3 transition-colors group focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2" })}
          >
            <span className={cn("material-symbols-outlined text-[18px]", isActive(item.href) && "fill-1")}>{item.icon}</span>
            <span className="text-[13px] font-medium whitespace-nowrap">{item.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
>>>>>>> feat/ds-v2026.09

  return (
    <aside className="flex w-72 flex-col border-r border-border-subtle bg-surface transition-colors duration-300 min-h-full">
        <div className="border-b border-border-subtle px-6 py-4">
          <Link href="/dashboard" className="inline-flex min-h-11 items-center text-text-main focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2">
            <BrandMark />
          </Link>
        </div>

        {/* One rhythm for every section: the gap between them lives here, not on each block. */}
        <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5 custom-scrollbar" aria-label="Primary navigation">
          {renderSection("Operate", operateItems.filter((item) => showAdminItems || !item.adminOnly).map(renderLink))}

          {renderSection("Tools", toolItems.map(renderLink))}

<<<<<<< HEAD
          {renderSection("System", (
            <>
              {systemItems.map(renderLink)}

              {/* Tools Providers accordion */}
              {showAdminItems && (
                <>
                  <button
                    type="button"
                    onClick={() => setMediaOpen((v) => !v)}
                    aria-expanded={mediaOpen}
                    className={linkClass(toolsProvidersActive, "w-full text-left")}
||||||| e6e8d110
            {/* Tools Providers accordion */}
            {showAdminItems && (<>
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "w-full flex min-h-11 items-center gap-3 px-3 rounded-md transition-colors group",
                pathname.startsWith("/dashboard/tools-providers")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <span className="text-[13px] font-medium flex-1 text-left">Tools Providers</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            {mediaOpen && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/tools-providers/${kind.id}`}
                    onClick={onClose}
                    className={cn(
                      "flex min-h-11 items-center gap-3 px-4 rounded-md transition-colors group",
                      pathname.startsWith(`/dashboard/tools-providers/${kind.id}`)
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
=======
            {/* Tools Providers accordion */}
            {showAdminItems && (<>
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={navItem({ active: pathname.startsWith("/dashboard/tools-providers") }).root({ class: "w-full flex min-h-11 items-center gap-3 px-3 transition-colors group" })}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <span className="text-[13px] font-medium flex-1 text-left">Tools Providers</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            {mediaOpen && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/tools-providers/${kind.id}`}
                    onClick={onClose}
                    className={navItem({ active: pathname.startsWith(`/dashboard/tools-providers/${kind.id}`) }).root({ class: "flex min-h-11 items-center gap-3 px-4 transition-colors group" })}
>>>>>>> feat/ds-v2026.09
                  >
<<<<<<< HEAD
                    <Icon name="perm_media" size={18} />
                    <span className="flex-1 truncate">Tools Providers</span>
                    <Icon name="expand_more" size={16} className={cn("transition-transform", mediaOpen && "rotate-180")} />
                  </button>
                  {mediaOpen && (
                    <div className="ml-5 flex flex-col gap-0.5 border-s border-muted ps-2">
                      {[
                        ...MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id))
                          .map((kind) => ({ href: `/dashboard/tools-providers/${kind.id}`, label: kind.label, icon: kind.icon })),
                        COMBINED_WEB_ITEM,
                      ].map(renderLink)}
                    </div>
                  )}
                </>
              )}
||||||| e6e8d110
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
=======
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <span className="text-sm">{kind.label}</span>
                  </Link>
                ))}
                <Link
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  onClick={onClose}
                  className={navItem({ active: pathname.startsWith(COMBINED_WEB_ITEM.href) }).root({ class: "flex min-h-11 items-center gap-3 px-4 transition-colors group" })}
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
                className={navItem({ active: isActive(item.href) }).root({ class: "flex min-h-11 items-center gap-3 px-3 transition-colors group" })}
              >
                <span
                  className={cn(
                    "material-symbols-outlined text-[18px]",
                    isActive(item.href) && "fill-1"
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
                className={navItem({ active: isActive(item.href) }).root({ class: "flex min-h-11 items-center gap-3 px-3 transition-colors group" })}
              >
                <span className={cn("material-symbols-outlined text-[18px]", isActive(item.href) && "fill-1")}>{item.icon}</span>
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
                  className={navItem({ active: isActive(item.href) }).root({ class: "flex min-h-11 items-center gap-3 px-3 transition-colors group" })}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive(item.href) && "fill-1"
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
              className={navItem({ active: isActive("/dashboard/profile") }).root({ class: "flex min-h-11 items-center gap-3 px-3 transition-colors group" })}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px]",
                  isActive("/dashboard/profile") && "fill-1"
                )}
              >
                settings
              </span>
              <span className="text-[13px] font-medium">Settings</span>
            </Link>
            )}
          </div>
>>>>>>> feat/ds-v2026.09

              {(showAdminItems ? adminSystemItems : []).map(renderLink)}

              {/* Settings — global configuration, so admin-only while scoping is on */}
              {showAdminItems && renderLink({ href: "/dashboard/profile", label: "Settings", icon: "settings" })}
            </>
          ))}

          {showAdminItems && visibleDebugItems.length > 0 && renderSection("Debug", visibleDebugItems.map(renderLink))}
        </nav>

    </aside>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};
