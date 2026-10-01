export const SETUP_PROGRESS_KEY = "redrouter:setup:v1";
export interface SetupSelection {
  connectionId: string;
  model: string;
  apiKeyId: string;
}
export interface SetupProgress extends SetupSelection {
  copiedSelection: string;
  organized: boolean;
}
export function selectionFingerprint(selection: SetupSelection, baseUrl: string): string {
  return JSON.stringify([baseUrl, selection.connectionId, selection.model, selection.apiKeyId]);
}
/** Only selections and completed actions survive a reload; never secrets or readiness. */
export function readSetupProgress(storage: Pick<Storage, "getItem">): SetupProgress | null {
  try {
    const value = JSON.parse(storage.getItem(SETUP_PROGRESS_KEY) || "null");
    if (!value || typeof value !== "object") return null;
    return {
      connectionId: typeof value.connectionId === "string" ? value.connectionId.slice(0, 200) : "",
      model: typeof value.model === "string" ? value.model.slice(0, 2048) : "",
      apiKeyId: typeof value.apiKeyId === "string" ? value.apiKeyId.slice(0, 200) : "",
      copiedSelection:
        typeof value.copiedSelection === "string" ? value.copiedSelection.slice(0, 5000) : "",
      organized: value.organized === true,
    };
  } catch {
    return null;
  }
}
export function writeSetupProgress(
  storage: Pick<Storage, "setItem">,
  progress: SetupProgress
): void {
  try {
    const { connectionId, model, apiKeyId, copiedSelection, organized } = progress;
    storage.setItem(
      SETUP_PROGRESS_KEY,
      JSON.stringify({ connectionId, model, apiKeyId, copiedSelection, organized })
    );
  } catch {
    /* Restricted browser storage does not block setup. */
  }
}
