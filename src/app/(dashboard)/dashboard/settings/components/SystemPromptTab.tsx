"use client";

import { Button, Card, Toggle } from "@/shared/components";
import { usePromptSettings } from "./usePromptSettings";

const readPromptConfig = (data: Record<string, unknown>) => ({
  enabled: data.enabled === true,
  prefixPrompt: typeof data.prefixPrompt === "string" ? data.prefixPrompt : "",
  suffixPrompt: typeof data.suffixPrompt === "string" ? data.suffixPrompt : "",
});

export default function SystemPromptTab() {
  const state = usePromptSettings("/api/settings/system-prompt", "PUT", readPromptConfig);
  const { config } = state;

  return (
    <Card
      title="Before and after client instructions"
      subtitle="Add text before or after the existing system instructions in chat requests."
    >
      <div className="space-y-5">
        <Toggle
          checked={config?.enabled ?? false}
          onChange={(enabled) => state.edit({ enabled })}
          label="Add before and after instructions"
          disabled={state.disabled}
        />
        <div>
          <label htmlFor="router-prefix-prompt" className="block text-sm font-medium mb-2">
            Before client instructions
          </label>
          <textarea
            id="router-prefix-prompt"
            value={config?.prefixPrompt ?? ""}
            onChange={(event) => state.edit({ prefixPrompt: event.target.value })}
            rows={6}
            maxLength={50000}
            disabled={state.disabled}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label htmlFor="router-suffix-prompt" className="block text-sm font-medium mb-2">
            After client instructions
          </label>
          <textarea
            id="router-suffix-prompt"
            value={config?.suffixPrompt ?? ""}
            onChange={(event) => state.edit({ suffixPrompt: event.target.value })}
            rows={6}
            maxLength={50000}
            disabled={state.disabled}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <p className="text-xs text-text-muted">
          Text is kept when disabled. Changes take effect after saving.
        </p>
        {state.error && (
          <p role="alert" className="text-sm text-red-500">
            {state.error}
          </p>
        )}
        {state.message && (
          <p role="status" className="text-sm text-text-muted">
            {state.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            onClick={() => void state.save()}
            disabled={state.disabled || !state.dirty}
            loading={state.saving}
          >
            Save prompt additions
          </Button>
          {!config && !state.loading && (
            <Button variant="secondary" onClick={state.retry}>
              Retry loading
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
