"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";
import { providerIdentity } from "open-sse/providers/identity.js";

// Providers whose connection carries its own endpoint in providerSpecificData.baseUrl.
const BASE_URL_FIELDS = {
  "red-router": {
    label: "Remote RedRouter URL",
    placeholder: "https://router.example.com/v1",
    hint: "Use the reachable URL of the second RedRouter. /v1 is added automatically when omitted.",
    required: true,
  },
  "ollama-local": {
    label: "Ollama Host URL",
    placeholder: "http://localhost:11434",
    hint: "Leave blank to use the default local Ollama host.",
    required: false,
  },
};

// Same rule the server applies (src/lib/connectionPrefix.js); the server has the final say.
const MODEL_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
    baseUrl: "",
    defaultModel: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  // "" = shared, "@admin" = password login only, otherwise the owner's e-mail.
  const [owner, setOwner] = useState("");
  const [canAssignOwner, setCanAssignOwner] = useState(false);
  const [modelPrefix, setModelPrefix] = useState("");
  const [prefixError, setPrefixError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => setCanAssignOwner(!!data?.scopeResourcesByUser && !!data?.isAdmin))
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (connection) {
      // The form is reseeded from the connection being edited each time it changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOwner(connection.owner || "");
      setModelPrefix(providerIdentity(connection.provider) && typeof connection.providerSpecificData?.prefix === "string"
        ? connection.providerSpecificData.prefix
        : "");
      setPrefixError("");
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
        baseUrl: typeof connection.providerSpecificData?.baseUrl === "string" ? connection.providerSpecificData.baseUrl : "",
        defaultModel: connection.defaultModel || "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setTestError("");
      setSaveError("");
      setValidationResult(null);
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;
  // Any connection that stores its own endpoint can change it, known provider or not.
  const baseUrlField = connection
    ? (BASE_URL_FIELDS[connection.provider]
      || (typeof connection.providerSpecificData?.baseUrl === "string"
        ? { label: "Base URL", placeholder: "https://api.example.com/v1", hint: "", required: true }
        : null))
    : null;
  const savedBaseUrl = typeof connection?.providerSpecificData?.baseUrl === "string" ? connection.providerSpecificData.baseUrl : "";
  const nextBaseUrl = formData.baseUrl.trim();
  const baseUrlChanged = !!baseUrlField && nextBaseUrl !== savedBaseUrl;
  // Compatible connections route to one default model; any connection that has one can change it.
  const hasDefaultModel = isCompatible || !!connection?.defaultModel;
  const nextDefaultModel = formData.defaultModel.trim();
  const defaultModelChanged = hasDefaultModel && nextDefaultModel !== (connection?.defaultModel || "");
  const missingRequired = (baseUrlField?.required && !nextBaseUrl) || (isCompatible && !nextDefaultModel);
  // Built-in providers only: a custom node's prefix is set on the node.
  const identity = connection ? providerIdentity(connection.provider) : null;
  const savedPrefix = identity && typeof connection?.providerSpecificData?.prefix === "string" ? connection.providerSpecificData.prefix : "";

  // Checked before saving so the reason a name is taken shows here, not as a failed save.
  const checkModelPrefix = async (value) => {
    if (!value) return "";
    if (!MODEL_PREFIX_PATTERN.test(value)) {
      return "Use lowercase letters, digits, \".\", \"_\" and \"-\", starting with a letter or digit.";
    }
    try {
      const res = await fetch(`/api/providers/${connection.id}/prefix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: value }),
      });
      const data = await res.json();
      if (!res.ok || data.valid === false) return data.error || "This model prefix is not available.";
      return "";
    } catch {
      return "Could not check the model prefix. Try again.";
    }
  };

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      // An edited endpoint is tested as typed (with the saved key), not the saved one.
      const res = await fetch(`/api/providers/${connection.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseUrlChanged ? { providerSpecificData: { baseUrl: nextBaseUrl } } : {}),
      });
      const data = await res.json().catch(() => ({}));
      const valid = res.ok && data.valid === true;
      setTestResult(valid ? "success" : "failed");
      if (!valid) setTestError(data.error || `Test failed (HTTP ${res.status})`);
    } catch (error) {
      setTestResult("failed");
      setTestError(error?.message || "Test failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
          ...(baseUrlField ? { providerSpecificData: { ...(connection.providerSpecificData || {}), baseUrl: nextBaseUrl } } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection || missingRequired) return;
    setSaving(true);
    try {
      const nextPrefix = modelPrefix.trim();
      const prefixChanged = !!identity && nextPrefix !== savedPrefix;
      if (prefixChanged) {
        const error = await checkModelPrefix(nextPrefix);
        setPrefixError(error);
        if (error) return;
      }
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
                ...(baseUrlField ? { providerSpecificData: { ...(connection.providerSpecificData || {}), baseUrl: nextBaseUrl } } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }
      
      if (prefixChanged) {
        updates.providerSpecificData = { ...(updates.providerSpecificData || {}), prefix: nextPrefix };
      }
      // The server merges providerSpecificData, so only the changed key is sent;
      // a new RedRouter URL also re-syncs that router's model catalog server-side.
      if (baseUrlChanged) {
        updates.providerSpecificData = { ...(updates.providerSpecificData || {}), baseUrl: nextBaseUrl };
      }
      if (defaultModelChanged) updates.defaultModel = nextDefaultModel;

      if (canAssignOwner) updates.owner = owner || null;

      // onSave resolves to { error } when the server refuses the change (an
      // unreachable RedRouter URL, an invalid one); keep the dialog open and say why.
      setSaveError("");
      const result = await onSave(updates);
      if (result?.error) setSaveError(result.error);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {baseUrlField && (
          <Input
            label={baseUrlField.label}
            value={formData.baseUrl}
            onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
            placeholder={baseUrlField.placeholder}
            hint={baseUrlField.hint || undefined}
            error={baseUrlField.required && !nextBaseUrl ? "Required" : undefined}
          />
        )}

        {hasDefaultModel && (
          <Input
            label="Default Model"
            value={formData.defaultModel}
            onChange={(e) => setFormData({ ...formData, defaultModel: e.target.value })}
            placeholder="gpt-4o-mini"
            error={isCompatible && !nextDefaultModel ? "Required" : undefined}
          />
        )}

        {identity && (
          <Input
            label="Model prefix"
            value={modelPrefix}
            onChange={(e) => {
              setModelPrefix(e.target.value);
              setPrefixError("");
            }}
            placeholder={identity.slug}
            error={prefixError || undefined}
            hint={prefixError ? undefined : modelPrefix.trim()
              ? `Requests to "${modelPrefix.trim()}/<model>" use only this account, and /v1/models lists ${identity.name} models under this prefix.`
              : `Give this account its own prefix (e.g. "${identity.slug}-work") to call it directly. Empty keeps "${identity.slug}/<model>", shared by all ${identity.name} accounts.`}
          />
        )}

        {canAssignOwner && (
          <Input
            label="Owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="user@company.com"
            hint={'Leave blank to share with everyone, or use "@admin" to keep it to the password login.'}
          />
        )}

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}
        {testError && (
          <p className="text-xs text-feedback-danger-foreground" role="alert">{testError}</p>
        )}

        {saveError && (
          <p className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-sm text-feedback-danger-foreground" role="alert">
            {saveError}
          </p>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving || missingRequired}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    owner: PropTypes.string,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

