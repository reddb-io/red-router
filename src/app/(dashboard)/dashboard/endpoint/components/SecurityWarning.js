"use client";


import Icon from "@/shared/components/Icon";
/** Security warning banner with optional action link */
export default function SecurityWarning({ message, action }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-feedback-warning-surface border border-feedback-warning-border text-feedback-warning-foreground">
<<<<<<< HEAD
      <Icon name="warning" size={16} className="shrink-0 mt-0.5" />
||||||| e6e8d110
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--reddb-color-feedback-warning-surface)] border border-[var(--reddb-color-feedback-warning-border)] text-[var(--reddb-color-feedback-warning-foreground)]">
      <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">warning</span>
=======
      <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">warning</span>
>>>>>>> feat/ds-v2026.09
      <p className="text-xs flex-1">{message}</p>
      {action && (
        <a
          href={action.href}
          className="text-xs font-medium underline shrink-0 hover:opacity-80"
          onClick={action.href.startsWith("#") ? (e) => {
            e.preventDefault();
            document.getElementById(action.href.slice(1))?.scrollIntoView({ behavior: "smooth" });
          } : undefined}
        >
          {action.label}
        </a>
      )}
    </div>
  );
}
