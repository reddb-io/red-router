"use client";

// Phase 1t.2 extraction — Issue #3501
import { Pencil, TriangleAlert } from "lucide-react";
import { useState } from "react";
import Icon from "@/shared/components/Icon";
import { useRouter } from "next/navigation";
import { Card, Button } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getApiLabel, getApiPath } from "../providerPageHelpers";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface ProviderNode {
  name?: string;
  baseUrl?: string;
  apiType?: string;
  chatPath?: string;
  prefix?: string;
  /** Optional operator-supplied remote icon URL (#2166). */
  iconUrl?: string;
  [key: string]: unknown;
}

interface CompatibleNodeCardProps {
  providerId: string;
  providerNode: ProviderNode;
  isCcCompatible: boolean;
  isAnthropicCompatible: boolean;
  isAnthropicProtocolCompatible: boolean;
  gateConnectionFlow: (callback: () => void) => void;
  openApiKeyAddFlow: () => void;
  onOpenEditNodeModal: () => void;
  /** Renames the provider without the rest of the edit form. */
  onRenameNode?: (name: string) => Promise<void>;
  t: ProviderMessageTranslator;
}

export default function CompatibleNodeCard({
  providerId,
  providerNode,
  isCcCompatible,
  isAnthropicCompatible,
  isAnthropicProtocolCompatible,
  gateConnectionFlow,
  openApiKeyAddFlow,
  onOpenEditNodeModal,
  onRenameNode,
  t,
}: CompatibleNodeCardProps) {
  const router = useRouter();
  const nodeName = typeof providerNode.name === "string" ? providerNode.name : "";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const commitRename = async () => {
    if (!onRenameNode || saving) return;
    const next = draft.trim();
    if (!next || next === nodeName.trim()) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    setSaving(true);
    try {
      await onRenameNode(next);
      setRenaming(false);
      setRenameError(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Could not rename the provider");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {providerNode.iconUrl && (
            <ProviderIcon
              providerId={providerId}
              src={providerNode.iconUrl}
              size={32}
              className="shrink-0 rounded-lg"
              fallbackText={isCcCompatible ? "CC" : isAnthropicCompatible ? "AC" : "OC"}
            />
          )}
          <div>
            {nodeName && (
              <div className="mb-0.5 flex items-center gap-1">
                {renaming ? (
                  <input
                    autoFocus
                    value={draft}
                    maxLength={200}
                    disabled={saving}
                    aria-label="Rename provider"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commitRename();
                      if (event.key === "Escape") {
                        setRenaming(false);
                        setRenameError(null);
                      }
                    }}
                    onBlur={() => void commitRename()}
                    className="rounded border border-control-edge bg-surface px-2 py-1 text-base font-semibold text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  />
                ) : (
                  <>
                    <p className="text-base font-semibold text-text-main">{nodeName}</p>
                    {onRenameNode && (
                      <button
                        type="button"
                        title="Rename provider"
                        aria-label="Rename provider"
                        onClick={() => {
                          setDraft(nodeName);
                          setRenameError(null);
                          setRenaming(true);
                        }}
                        className="rounded p-0.5 text-ink-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Icon icon={Pencil} size="sm" color="current" />
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {renameError && (
              <p role="alert" className="text-xs text-feedback-danger-foreground">
                {renameError}
              </p>
            )}
            <h2 className="text-lg font-semibold">
              {isCcCompatible
                ? t("ccCompatibleDetailsTitle")
                : isAnthropicCompatible
                  ? t("anthropicCompatibleDetails")
                  : t("openaiCompatibleDetails")}
            </h2>
            <p className="text-sm text-text-muted">
              {getApiLabel(t, isAnthropicProtocolCompatible, providerNode?.apiType)} ·{" "}
              {(providerNode.baseUrl || "").replace(/\/$/, "")}/
              {getApiPath(
                isCcCompatible,
                isAnthropicCompatible,
                providerNode?.apiType,
                providerNode?.chatPath
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="add" onClick={() => gateConnectionFlow(openApiKeyAddFlow)}>
            {t("add")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="edit"
            onClick={onOpenEditNodeModal}
          >
            {t("edit")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="delete"
            onClick={async () => {
              if (
                !confirm(
                  t("deleteCompatibleNodeConfirm", {
                    type: isCcCompatible
                      ? t("ccCompatibleLabel")
                      : isAnthropicCompatible
                        ? t("anthropic")
                        : t("openai"),
                  })
                )
              )
                return;
              try {
                const res = await fetch(`/api/provider-nodes/${providerId}`, {
                  method: "DELETE",
                });
                if (res.ok) {
                  router.push("/dashboard/providers");
                  router.refresh();
                }
              } catch (error) {
                console.error("Error deleting provider node:", error);
              }
            }}
          >
            {t("delete")}
          </Button>
        </div>
      </div>
      {isCcCompatible && (
        <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-text-muted">
          <div className="flex items-start gap-2">
            <Icon icon={TriangleAlert} size="md" color="feedback-warning-foreground" className="mt-0.5" />
            <p>{t("ccCompatibleValidationHint")}</p>
          </div>
        </div>
      )}
    </Card>
  );
}
