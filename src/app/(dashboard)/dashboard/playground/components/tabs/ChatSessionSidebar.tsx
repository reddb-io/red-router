"use client";

// src/app/(dashboard)/dashboard/playground/components/tabs/ChatSessionSidebar.tsx
//
// Compact session list for the Playground chat: a column from `sm` up, a select + icon buttons
// below it. Presentational only — persistence lives in hooks/useChatSessions.ts.

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Icon from "@/shared/components/Icon";
import { Button, Input, Select } from "@/shared/components";
import type { ChatSession } from "../../chatSessions";

interface ChatSessionSidebarProps {
  sessions: ChatSession[];
  activeId: string | null;
  /** Locks switching / creating / deleting while a response is streaming. */
  disabled?: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onRequestDelete: (id: string) => void;
}

const ICON_BUTTON =
  "shrink-0 p-1.5 rounded text-text-muted hover:text-text-main hover:bg-black/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:flex pointer-coarse:items-center pointer-coarse:justify-center";

export default function ChatSessionSidebar({
  sessions,
  activeId,
  disabled = false,
  onSelect,
  onNew,
  onRename,
  onRequestDelete,
}: ChatSessionSidebarProps) {
  const t = useTranslations("playground");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (session: ChatSession) => {
    setEditingId(session.id);
    setDraft(session.title);
  };
  const commitEdit = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };
  const cancelEdit = () => setEditingId(null);

  const renameInput = (
    <Input
      autoFocus
      value={draft}
      aria-label={t("renameChat")}
      inputClassName="py-1"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelEdit();
        }
      }}
    />
  );

  const active = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <>
      {/* Column layout from sm up */}
      <aside
        className="hidden sm:flex w-56 shrink-0 flex-col border-r border-border bg-bg-alt"
        aria-label={t("chatSessions")}
      >
        <div className="p-2 border-b border-border">
          <Button
            variant="secondary"
            size="sm"
            icon="add"
            fullWidth
            onClick={onNew}
            disabled={disabled}
          >
            {t("newChat")}
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto p-1 space-y-0.5">
          {sessions.length === 0 && (
            <li className="px-2 py-3 text-xs text-text-muted">{t("noChats")}</li>
          )}
          {sessions.map((session) => {
            const isActive = session.id === activeId;
            return (
              <li
                key={session.id}
                className={`group flex items-center gap-0.5 rounded-md ${
                  isActive ? "bg-primary/10 text-text-main" : "text-text-muted hover:bg-black/5"
                }`}
              >
                {editingId === session.id ? (
                  <div className="flex-1 min-w-0 p-0.5">{renameInput}</div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onSelect(session.id)}
                      disabled={disabled && !isActive}
                      aria-current={isActive ? "true" : undefined}
                      title={session.title}
                      className="flex-1 min-w-0 truncate text-left text-sm px-2 py-1.5 disabled:opacity-60"
                    >
                      {session.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(session)}
                      className={`${ICON_BUTTON} opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100`}
                      title={t("renameChat")}
                      aria-label={t("renameChat")}
                    >
                      <Icon icon={Pencil} size="sm" color="current" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestDelete(session.id)}
                      disabled={disabled}
                      className={`${ICON_BUTTON} hover:text-feedback-danger-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100`}
                      title={t("deleteChat")}
                      aria-label={t("deleteChat")}
                    >
                      <Icon icon={Trash2} size="sm" color="current" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Collapsed layout under sm */}
      <div className="sm:hidden flex items-end gap-1 px-2 py-2 border-b border-border bg-bg-alt">
        <div className="flex-1 min-w-0">
          {editingId ? (
            renameInput
          ) : (
            <Select
              aria-label={t("chatSessions")}
              value={activeId ?? ""}
              disabled={disabled || sessions.length === 0}
              placeholder={t("noChats")}
              options={sessions.map((s) => ({ value: s.id, label: s.title }))}
              onChange={(e) => onSelect(e.target.value)}
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => active && startEdit(active)}
          disabled={!active || editingId !== null}
          className={ICON_BUTTON}
          title={t("renameChat")}
          aria-label={t("renameChat")}
        >
          <Icon icon={Pencil} size="md" color="current" />
        </button>
        <button
          type="button"
          onClick={() => active && onRequestDelete(active.id)}
          disabled={!active || disabled}
          className={`${ICON_BUTTON} hover:text-feedback-danger-foreground`}
          title={t("deleteChat")}
          aria-label={t("deleteChat")}
        >
          <Icon icon={Trash2} size="md" color="current" />
        </button>
        <button
          type="button"
          onClick={onNew}
          disabled={disabled}
          className={ICON_BUTTON}
          title={t("newChat")}
          aria-label={t("newChat")}
        >
          <Icon icon={Plus} size="md" color="current" />
        </button>
      </div>
    </>
  );
}
