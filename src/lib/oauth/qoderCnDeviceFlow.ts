import { z } from "zod";

const QoderCnDeviceDataSchema = z.object({
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  _qoderMachineId: z.uuid(),
});

/** CN creates its own PKCE challenge; the generic verifier must not replace it. */
export function deviceCodeResponseWithVerifier(
  provider: string,
  deviceData: Record<string, unknown>,
  genericVerifier: string | undefined
): Record<string, unknown> {
  if (provider === "qoder-cn") {
    const parsed = QoderCnDeviceDataSchema.parse(deviceData);
    return { ...deviceData, codeVerifier: parsed.codeVerifier };
  }
  return { ...deviceData, codeVerifier: genericVerifier };
}

/** Only the CN device flow needs to carry its generated machine identity to polling. */
export function qoderCnPollData(provider: string, extraData: unknown): unknown {
  if (provider !== "qoder-cn") return extraData;
  const parsed = z.object({ _qoderMachineId: z.uuid() }).safeParse(extraData);
  if (!parsed.success) throw new Error("Qoder CN device flow machine ID is invalid");
  return parsed.data;
}
