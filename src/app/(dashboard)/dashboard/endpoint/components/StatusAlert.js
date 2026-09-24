"use client";

/** Reusable status alert */
export default function StatusAlert({ status, className = "" }) {
  const renderMessage = (msg) => {
    const parts = msg.split(/(https?:\/\/[^\s]+)/g);
    return parts.map((part, i) =>
      /^https?:\/\//.test(part)
        ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline font-medium">{part}</a>
        : part
    );
  };

  return (
    <div className={`p-2 rounded text-sm ${className} ${status.type === "success" ? "bg-[var(--reddb-color-feedback-success-surface)] text-[var(--reddb-color-feedback-success-foreground)]" :
        status.type === "warning" ? "bg-[var(--reddb-color-feedback-warning-surface)] text-[var(--reddb-color-feedback-warning-foreground)]" :
        status.type === "info" ? "bg-[var(--reddb-color-feedback-info-surface)] text-[var(--reddb-color-feedback-info-foreground)]" :
          "bg-[var(--reddb-color-feedback-danger-surface)] text-[var(--reddb-color-feedback-danger-foreground)]"
      }`}>
      {renderMessage(status.message)}
    </div>
  );
}
