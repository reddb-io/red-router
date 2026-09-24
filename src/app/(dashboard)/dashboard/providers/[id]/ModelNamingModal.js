"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Select } from "@/shared/components";

/**
 * Rename a provider model and give it an alias. The display name is what /v1/models
 * shows for the model; the alias is a bare id clients may call instead ("fast"), listed
 * in /v1/models as its own entry under its own display name. When the provider has
 * connection model prefixes the alias may route through one of them.
 */
export default function ModelNamingModal({ isOpen, model, storagePrefix, routePrefixes, displayName, alias, aliasName, aliasTarget, onClose, onSaved }) {
  const [name, setName] = useState("");
  const [nextAlias, setNextAlias] = useState("");
  const [nextAliasName, setNextAliasName] = useState("");
  const [routePrefix, setRoutePrefix] = useState(storagePrefix);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Seed the form from the model being edited each time the modal opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(displayName || "");
    setNextAlias(alias || "");
    setNextAliasName(aliasName || "");
    const savedPrefix = aliasTarget?.includes("/") ? aliasTarget.slice(0, aliasTarget.indexOf("/")) : "";
    setRoutePrefix(routePrefixes.some((p) => p.value === savedPrefix) ? savedPrefix : storagePrefix);
    setError("");
  }, [isOpen, displayName, alias, aliasName, aliasTarget, routePrefixes, storagePrefix]);

  if (!model) return null;

  const handleSave = async () => {
    const aliasValue = nextAlias.trim();
    if (aliasValue && /[\s/]/.test(aliasValue)) {
      setError("An alias cannot contain \"/\" or spaces.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nameRes = await fetch("/api/models/names", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${storagePrefix}/${model.id}`, name }),
      });
      if (!nameRes.ok) {
        setError((await nameRes.json().catch(() => ({}))).error || "Could not save the display name.");
        return;
      }
      if (aliasValue) {
        const aliasRes = await fetch("/api/models/alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: `${routePrefix}/${model.id}`, alias: aliasValue, name: nextAliasName }),
        });
        if (!aliasRes.ok) {
          setError((await aliasRes.json().catch(() => ({}))).error || "Could not save the alias.");
          return;
        }
      }
      if (alias && alias !== aliasValue) {
        await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });
      }
      await onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Name & alias" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          <code className="rounded bg-sidebar px-1.5 py-0.5 font-mono">{`${storagePrefix}/${model.id}`}</code>
        </p>
        <Input
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={model.name || model.id}
          hint="The name /v1/models shows for this model. Empty keeps the catalog name."
        />
        <Input
          label="Alias"
          value={nextAlias}
          onChange={(e) => {
            setNextAlias(e.target.value);
            setError("");
          }}
          placeholder="fast"
          hint="A short id clients can call instead of the full model id. It is listed in /v1/models as its own model."
        />
        {nextAlias.trim() && routePrefixes.length > 1 && (
          <Select
            label="Alias routes through"
            value={routePrefix}
            onChange={(e) => setRoutePrefix(e.target.value)}
            options={routePrefixes}
            hint="A connection prefix sends the alias to that account only."
          />
        )}
        {nextAlias.trim() && (
          <Input
            label="Alias display name"
            value={nextAliasName}
            onChange={(e) => setNextAliasName(e.target.value)}
            placeholder={nextAlias.trim()}
            hint="Optional. The name /v1/models shows for the alias."
          />
        )}
        {error && <p className="text-xs text-[var(--reddb-color-feedback-danger-foreground)]">{error}</p>}
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

ModelNamingModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  model: PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string }),
  storagePrefix: PropTypes.string.isRequired,
  routePrefixes: PropTypes.arrayOf(PropTypes.shape({ value: PropTypes.string, label: PropTypes.string })).isRequired,
  displayName: PropTypes.string,
  alias: PropTypes.string,
  aliasName: PropTypes.string,
  aliasTarget: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
