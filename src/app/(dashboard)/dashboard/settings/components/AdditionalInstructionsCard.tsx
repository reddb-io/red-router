"use client";

import { Button, Card, Toggle } from "@/shared/components";
import { usePromptSettings } from "./usePromptSettings";

const readAdditionalInstructions = (data: Record<string, unknown>) => ({
  customSystemPromptEnabled: data.customSystemPromptEnabled === true,
  customSystemPrompt: typeof data.customSystemPrompt === "string" ? data.customSystemPrompt : "",
});

export default function AdditionalInstructionsCard() {
  const state = usePromptSettings("/api/settings", "PATCH", readAdditionalInstructions);
  const { config } = state;

  return (
    <Card
      title="Additional appended instructions"
      subtitle="The custom system prompt previously shown in Endpoints. Appends an extra instruction to chat requests across this router."
    >
      <div className="space-y-4">
        <Toggle
          checked={config?.customSystemPromptEnabled ?? false}
          onChange={(customSystemPromptEnabled) => state.edit({ customSystemPromptEnabled })}
          label="Add additional appended instructions"
          disabled={state.disabled}
        />
        <label htmlFor="router-additional-prompt" className="block text-sm font-medium">
          Appended instructions
        </label>
        <textarea
          id="router-additional-prompt"
          value={config?.customSystemPrompt ?? ""}
          onChange={(event) => state.edit({ customSystemPrompt: event.target.value })}
          rows={5}
          maxLength={10000}
          disabled={state.disabled}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <p className="text-xs text-text-muted">
          This can be enabled alongside the before/after instructions above. Text is kept when
          disabled. Changes take effect after saving.
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
            Save appended instructions
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
