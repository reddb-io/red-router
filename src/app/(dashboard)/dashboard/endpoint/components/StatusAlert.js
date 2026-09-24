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
    <div className={`p-2 rounded text-sm ${className} ${status.type === "success" ? "bg-feedback-success-surface text-feedback-success-foreground" :
        status.type === "warning" ? "bg-feedback-warning-surface text-feedback-warning-foreground" :
        status.type === "info" ? "bg-feedback-info-surface text-feedback-info-foreground" :
          "bg-feedback-danger-surface text-feedback-danger-foreground"
      }`}>
      {renderMessage(status.message)}
    </div>
  );
}
