"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/shared/components";

const PAGE_SIZE = 100;

interface Props<T> {
  models: T[];
  resetKey: string;
  children: (models: T[]) => ReactNode;
}

/** Paginate rendering only. Search, ordering and bulk actions use the full filtered list. */
export default function PaginatedProviderModels<T>({ models, resetKey, children }: Props<T>) {
  const [position, setPosition] = useState({ scope: resetKey, page: 0 });
  const totalPages = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
  const page = position.scope === resetKey ? Math.min(position.page, totalPages - 1) : 0;

  // Reconcile during render so filters never briefly show an empty/stale page.
  // Retain the clamped page after deletions, including when the list grows again.
  if (position.scope !== resetKey || position.page !== page) {
    setPosition({ scope: resetKey, page });
  }

  const start = page * PAGE_SIZE;
  const pageModels = models.slice(start, start + PAGE_SIZE);
  const navigation = (location: "top" | "bottom") =>
    models.length > PAGE_SIZE && (
      <nav
        aria-label={`Model pagination (${location})`}
        className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted"
      >
        <span aria-live={location === "top" ? "polite" : "off"}>
          {start + 1}–{Math.min(start + PAGE_SIZE, models.length)} of {models.length} models
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 0}
            onClick={() => setPosition({ scope: resetKey, page: page - 1 })}
          >
            Previous
          </Button>
          <span>
            Page {page + 1} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page === totalPages - 1}
            onClick={() => setPosition({ scope: resetKey, page: page + 1 })}
          >
            Next
          </Button>
        </div>
      </nav>
    );

  return (
    <div className="space-y-3">
      {navigation("top")}
      {children(pageModels)}
      {navigation("bottom")}
    </div>
  );
}
