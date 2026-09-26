"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal, Icon } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

export default function JcodeToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [jcodeStatus, setJcodeStatus] = useState(initialStatus || null);
  const [checkingJcode, setCheckingJcode] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const hasInitializedModel = useRef(false);

  const currentBaseUrl = jcodeStatus?.config?.providers?.["red-router"]?.base_url || "";

  const getConfigStatus = () => {
    if (!jcodeStatus?.installed) return null;
    if (!jcodeStatus?.hasRedRouter) return "not_configured";
    const currentProvider = jcodeStatus.config?.providers?.["red-router"];
    if (!currentProvider) return "not_configured";
    return matchKnownEndpoint(currentProvider.base_url, { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialStatus) setJcodeStatus(initialStatus);
  }, [initialStatus]);

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  useEffect(() => {
    if (jcodeStatus?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const provider = jcodeStatus.config?.providers?.["red-router"];
      if (provider) {
        if (provider.default_model) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSelectedModel(provider.default_model);
        }
        // Try to match API key from env file
        const envApiKey = jcodeStatus.envApiKey;
        if (envApiKey && apiKeys?.some(k => k.key === envApiKey)) {
          setSelectedApiKey(envApiKey);
        }
      }
    }
  }, [jcodeStatus, apiKeys]);

  const checkJcodeStatus = async () => {
    setCheckingJcode(true);
    try {
      const res = await fetch("/api/cli-tools/jcode-settings");
      const data = await res.json();
      setJcodeStatus(data);
    } catch (error) {
      setJcodeStatus({ installed: false, error: error.message });
    } finally {
      setCheckingJcode(false);
    }
  };

  useEffect(() => {
    if (isExpanded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!jcodeStatus) checkJcodeStatus();
      fetchModelAliases();
    }
  }, [isExpanded]);

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return "http://127.0.0.1:25050";
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_red-router" : null);

      const res = await fetch("/api/cli-tools/jcode-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          models: selectedModel ? [selectedModel] : [],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Remember the endpoint so it stays selectable next time
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: "Settings applied successfully!" });
        checkJcodeStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleResetSettings = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/jcode-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setSelectedModel("");
        setSelectedApiKey("");
        checkJcodeStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleModelSelect = (model) => {
    setSelectedModel(model.value);
    setModalOpen(false);
  };

  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_red-router" : "<API_KEY_FROM_DASHBOARD>");

    const configToml = `[providers.red-router]
type = "openai-compatible"
base_url = "${getEffectiveBaseUrl()}"
auth = "bearer"
api_key_env = "JCODE_RED_ROUTER_API_KEY"
env_file = "provider-red-router.env"
default_model = "${selectedModel || "claude-code/claude-opus-4-7"}"
requires_api_key = true

[[providers.red-router.models]]
id = "${selectedModel || "claude-code/claude-opus-4-7"}"`;

    const envContent = `JCODE_RED_ROUTER_API_KEY="${keyToUse}"`;

    return [
      {
        filename: "~/.jcode/config.toml",
        content: configToml,
      },
      {
        filename: "~/.config/jcode/provider-red-router.env",
        content: envContent,
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src={tool.image || "/providers/jcode.png"} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-feedback-success-surface text-feedback-success-foreground rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-feedback-warning-surface text-feedback-warning-foreground rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-feedback-info-surface text-feedback-info-foreground rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <Icon name="expand_more" size={20} className={`text-text-muted transition-transform ${isExpanded ? "rotate-180" : ""}`} />
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checkingJcode && (
            <div className="flex items-center gap-2 text-text-muted">
              <Icon name="progress_activity" size={24} className="animate-spin" />
              <span>Checking jcode CLI...</span>
            </div>
          )}

          {!checkingJcode && jcodeStatus && !jcodeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-feedback-warning-surface border border-feedback-warning-border rounded-lg">
                <div className="flex items-start gap-3">
<<<<<<< HEAD
                  <Icon name="warning" size={24} className="text-feedback-warning-foreground" />
||||||| e6e8d110
                  <span className="material-symbols-outlined text-[var(--reddb-color-feedback-warning-foreground)]">warning</span>
=======
                  <span className="material-symbols-outlined text-feedback-warning-foreground">warning</span>
>>>>>>> feat/ds-v2026.09
                  <div className="flex-1">
                    <p className="font-medium text-feedback-warning-foreground">jcode CLI not detected locally</p>
                    <p className="text-sm text-text-muted mt-1">Install jcode to enable automatic configuration:</p>
                    <code className="block mt-2 p-2 bg-black/20 rounded text-xs font-mono">
                      curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash
                    </code>
                    <p className="text-sm text-text-muted mt-2">Manual configuration is still available if red-router is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-feedback-warning-surface !border-feedback-warning-border !text-feedback-warning-foreground dark:!text-feedback-warning-foreground hover:!bg-feedback-warning-surface">
<<<<<<< HEAD
                    <Icon name="content_copy" size={18} className="mr-1" />
||||||| e6e8d110
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-[var(--reddb-color-feedback-warning-surface)] !border-[var(--reddb-color-feedback-warning-border)] !text-[var(--reddb-color-feedback-warning-foreground)] dark:!text-[var(--reddb-color-feedback-warning-foreground)] hover:!bg-[var(--reddb-color-feedback-warning-surface)]">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
=======
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
>>>>>>> feat/ds-v2026.09
                    Manual Config
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!checkingJcode && jcodeStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {/* Info notes */}
                {tool.notes && tool.notes.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {tool.notes.map((note, idx) => (
                      <div key={idx} className={`flex items-start gap-2 p-2 rounded text-xs ${
                        note.type === "info" ? "bg-feedback-info-surface text-feedback-info-foreground" :
                        note.type === "warning" ? "bg-feedback-warning-surface text-feedback-warning-foreground" :
                        "bg-muted text-text-muted"
                      }`}>
                        <Icon name={note.type === "info" ? "info" : note.type === "warning" ? "warning" : "help"} size={14} className="mt-0.5" />
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Endpoint (selector) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <Icon name="arrow_forward" size={14} className="hidden text-text-muted sm:inline" />
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                    currentUrl={currentBaseUrl}
                  />
                </div>

                {/* Current configured */}
                {jcodeStatus?.config?.providers?.["red-router"]?.base_url && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <Icon name="arrow_forward" size={14} className="hidden text-text-muted sm:inline" />
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {jcodeStatus.config.providers["red-router"].base_url}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <Icon name="arrow_forward" size={14} className="hidden text-text-muted sm:inline" />
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {/* Default Model */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Default Model</span>
                  <Icon name="arrow_forward" size={14} className="hidden text-text-muted sm:inline" />
                  <div className="relative w-full min-w-0">
                    <input type="text" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} placeholder="claude-code/claude-opus-4-7" className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5" />
<<<<<<< HEAD
                    {selectedModel && <button onClick={() => setSelectedModel("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-feedback-danger-foreground rounded transition-colors" title="Clear"><Icon name="close" size={14} /></button>}
||||||| e6e8d110
                    {selectedModel && <button onClick={() => setSelectedModel("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-[var(--reddb-color-feedback-danger-foreground)] rounded transition-colors" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
=======
                    {selectedModel && <button onClick={() => setSelectedModel("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-feedback-danger-foreground rounded transition-colors" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
>>>>>>> feat/ds-v2026.09
                  </div>
                  <button onClick={() => setModalOpen(true)} disabled={!hasActiveProviders} className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${hasActiveProviders ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Select</button>
                </div>

                {/* Usage hint */}
                <div className="flex flex-col gap-1 p-3 bg-feedback-info-surface border border-feedback-info-border rounded-lg">
                  <p className="text-xs font-medium text-feedback-info-foreground">Usage:</p>
                  <code className="text-xs font-mono text-text-muted">jcode --provider-profile red-router</code>
                  <code className="text-xs font-mono text-text-muted">jcode --provider-profile red-router --model {selectedModel || "claude-code/claude-opus-4-7"}</code>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-feedback-success-surface text-feedback-success-foreground" : "bg-feedback-danger-surface text-feedback-danger-foreground"}`}>
<<<<<<< HEAD
                  <Icon name={message.type === "success" ? "check_circle" : "error"} size={14} />
||||||| e6e8d110
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-[var(--reddb-color-feedback-success-surface)] text-[var(--reddb-color-feedback-success-foreground)]" : "bg-[var(--reddb-color-feedback-danger-surface)] text-[var(--reddb-color-feedback-danger-foreground)]"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
=======
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
>>>>>>> feat/ds-v2026.09
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={!selectedModel} loading={applying}>
                  <Icon name="save" size={14} className="mr-1" />Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetSettings} disabled={!jcodeStatus?.hasRedRouter} loading={restoring}>
                  <Icon name="restore" size={14} className="mr-1" />Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <Icon name="content_copy" size={14} className="mr-1" />Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={handleModelSelect}
          selectedModel={selectedModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Model for jcode"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="jcode - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
