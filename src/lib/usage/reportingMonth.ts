/** Validate an untrusted month without importing persistence into client bundles. */
export function isReportingMonth(value: string): boolean {
  return (
    /^\d{4}-(0[1-9]|1[0-2])$/.test(value) &&
    Number(value.slice(0, 4)) >= 2000 &&
    Number(value.slice(0, 4)) <= 9998
  );
}
