"use client";

import { Input, Icon } from "@/shared/components";

/** Reusable endpoint row component */
export default function EndpointRow({ label, url, copyId, copied, onCopy, badge, actions }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
          (badge === "CF" || badge === "TS") ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
        }`}>{label}</span>
      <Input value={url} readOnly className="flex-1 font-mono text-sm" />
      <button
        onClick={() => onCopy(url, copyId)}
        className="p-2 hover:bg-muted/50 rounded text-text-muted hover:text-primary transition-colors shrink-0"
      >
        <Icon name={copied === copyId ? "check" : "content_copy"} size={18} />
      </button>
      {actions}
    </div>
  );
}
