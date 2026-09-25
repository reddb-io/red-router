"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";
import PageHeading from "../PageHeading";
import Breadcrumbs from "../Breadcrumbs";
import { getPageInfo, hasOwnHeading } from "@/shared/utils/pageInfo";
import Icon from "../Icon";

// Toasts use the DS feedback roles (surface / foreground / border per status).
// Literal class strings, so Tailwind's scanner generates every one of them.
const FEEDBACK = {
  success: "border-feedback-success-border bg-feedback-success-surface text-feedback-success-foreground",
  danger: "border-feedback-danger-border bg-feedback-danger-surface text-feedback-danger-foreground",
  warning: "border-feedback-warning-border bg-feedback-warning-surface text-feedback-warning-foreground",
  info: "border-feedback-info-border bg-feedback-info-surface text-feedback-info-foreground",
};

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: FEEDBACK.success,
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: FEEDBACK.danger,
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: FEEDBACK.warning,
      icon: "warning",
    };
  }
  return {
    wrapper: FEEDBACK.info,
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  const isChat = pathname === "/dashboard/basic-chat";
  const pageInfo = getPageInfo(pathname);
  const crumbs = pageInfo.breadcrumbs?.length ? <Breadcrumbs items={pageInfo.breadcrumbs} /> : null;
  let heading = null;
  if (!isChat && hasOwnHeading(pathname)) {
    heading = crumbs && <div className="mb-[var(--reddb-spatial-gap-lg)]">{crumbs}</div>;
  } else if (!isChat && pageInfo.title) {
    heading = (
      <PageHeading
        title={pageInfo.title}
        description={pageInfo.description}
        context={crumbs}
        className="mb-[var(--reddb-spatial-inset-lg)]"
      />
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg">
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-md border px-3 py-2 shadow-sm ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <Icon name={style.icon} size={18} className="leading-5" />
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <Icon name="close" size={16} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-scrim/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Desktop */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Sidebar - Mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <main className="flex flex-col flex-1 h-full min-w-0 relative transition-colors duration-300 isolate">
        <Header key={pathname} onMenuClick={() => setSidebarOpen(true)} />
        {/* One page frame for every page: the layout owns the width (pages never
            set their own max width or centering), and the scrollbar's gutter is
            always reserved so content does not shift between short and long pages. */}
        <div className={`flex-1 overflow-y-auto custom-scrollbar [scrollbar-gutter:stable] ${isChat ? "flex flex-col overflow-hidden" : "p-4 sm:p-6 lg:p-8"}`}>
          <div className={isChat ? "flex-1 w-full h-full flex flex-col" : "dashboard-page w-full max-w-7xl mx-auto"}>
            {heading}
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
