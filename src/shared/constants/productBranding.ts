export const DEFAULT_INSTANCE_NAME = "RedRouter";

/** Keep custom instance names, but do not display the inherited upstream default. */
export function displayInstanceName(value: string | null | undefined): string {
  return value && value !== "OmniRoute" ? value : DEFAULT_INSTANCE_NAME;
}
