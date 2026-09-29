"use client";

import { Suspense, useEffect, useInsertionEffect, useState } from "react";
import Sidebar from "../Sidebar";
import SidebarResizeHandle from "../SidebarResizeHandle";
import Header from "../Header";
import NotificationToast from "../NotificationToast";
import MaintenanceBanner from "../MaintenanceBanner";
import CommandPalette from "../CommandPalette";
import NavigationProgress from "../NavigationProgress";
import { useIsElectron } from "@/shared/hooks/useElectron";
import { useSidebarWidth } from "@/shared/hooks/useSidebarWidth";
import {
  installDashboardCsrfFetch,
  prefetchDashboardCsrfToken,
} from "@/shared/utils/dashboardCsrf";
import { installBasePathFetch } from "@/shared/utils/basePathFetch";

const isE2EMode = process.env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE === "1";

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const isElectron = useIsElectron();
  const sidebarWidth = useSidebarWidth();

  const isMacElectron =
    isElectron &&
    typeof globalThis.window !== "undefined" &&
    globalThis.electronAPI?.platform === "darwin";

  useEffect(() => {
    if (typeof document === "undefined") return;

    document.body.classList.toggle("electron-macos", isMacElectron);

    return () => {
      document.body.classList.remove("electron-macos");
    };
  }, [isMacElectron]);

  useInsertionEffect(() => {
    // basePath rewrite must wrap native fetch first so CSRF's originalFetch
    // chain (and bare `fetch("/api/...")` call sites) hit the subpath.
    const uninstallBasePathFetch = installBasePathFetch();
    const uninstallDashboardCsrfFetch = installDashboardCsrfFetch();
    void prefetchDashboardCsrfToken();
    return () => {
      uninstallDashboardCsrfFetch();
      uninstallBasePathFetch();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    // No bg-bg here: the body grid wallpaper (globals.css body::before) shows through
    // this transparent wrapper into the content area. body's --color-bg is the base fill.
    <div className="flex h-dvh min-h-0 w-full overflow-hidden">
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Desktop: keep visibility independent from Tailwind hidden/lg:flex ordering. */}
      <div
        className="dashboard-sidebar-desktop relative"
        data-resizing={sidebarWidth.resizing ? "true" : undefined}
        style={{ "--rr-sidebar-panel-width": `${sidebarWidth.width}px` } as React.CSSProperties}
      >
        <Sidebar
          panelOpen={sidebarWidth.open}
          onPanelOpenChange={sidebarWidth.setOpen}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          isMacElectron={isMacElectron}
        />
        {sidebarWidth.open && (
          <SidebarResizeHandle
            width={sidebarWidth.width}
            resizing={sidebarWidth.resizing}
            onPointerDown={sidebarWidth.startDrag}
            onKeyDown={sidebarWidth.onKeyDown}
            onReset={sidebarWidth.reset}
          />
        )}
      </div>

      {/* Sidebar - Mobile: rail and panel side by side, full viewport height */}
      <div
        className={`fixed start-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out h-dvh ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={
          {
            top: "var(--ios-safe-top, 0px)",
            bottom: "var(--ios-safe-bottom, 0px)",
            "--rr-sidebar-panel-width": "min(18rem, calc(100vw - 4.5rem))",
          } as React.CSSProperties
        }
      >
        <Sidebar
          onClose={() => setSidebarOpen(false)}
          onOpenCommandPalette={() => {
            setSidebarOpen(false);
            setCommandPaletteOpen(true);
          }}
          isMacElectron={isMacElectron}
        />
      </div>

      {/* Main content */}
      <main
        id="main-content"
        className="relative flex min-h-0 flex-1 min-w-0 flex-col transition-colors duration-300"
      >
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />
        {!isE2EMode && <MaintenanceBanner />}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 sm:p-6 lg:p-10">
          {/* Fluid up to a 4K cap (3840px): content follows the viewport on large
              monitors and only centers (side gutters) beyond ~4K, instead of the prior
              1280px cap that left big empty margins on wide screens. */}
          <div className="max-w-[3840px] mx-auto w-full h-full min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">{children}</div>
          </div>
        </div>
      </main>

      {/* Global notification toast system */}
      <NotificationToast />

      <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
    </div>
  );
}
