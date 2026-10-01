import AdditionalInstructionsCard from "../components/AdditionalInstructionsCard";
import SystemPromptTab from "../components/SystemPromptTab";

export default function PromptSettingsPage() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted max-w-prose">
        Instructions this router adds to chat requests, across clients and provider connections.
        These controls add to the instructions sent by your client.
      </p>
      <SystemPromptTab />
      <AdditionalInstructionsCard />
    </div>
  );
}
