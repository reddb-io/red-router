import { NextResponse } from "next/server";
import { z } from "zod";
import {
  verifyManagementPassword,
  getStoredManagementPassword,
} from "@/lib/auth/managementPassword";
import { getCachedSettings } from "@/lib/db/settings";
import { OWNER_PRINCIPAL, verifyMfaProof } from "@/lib/db/mfa";

export const INVALID_JSON = { error: "Invalid request" };

export const codeSchema = z.object({ code: z.string().trim().min(1).max(16) });
export const proofSchema = z
  .object({
    code: z.string().trim().max(16).optional(),
    recoveryCode: z.string().trim().max(32).optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Boolean(value.code || value.recoveryCode), { message: "A code is required" });

/** True when `password` is the current management password. */
export async function passwordMatches(password: string | undefined): Promise<boolean> {
  if (!password) return false;
  const settings = await getCachedSettings();
  const stored = getStoredManagementPassword(settings);
  return Boolean(stored) && (await verifyManagementPassword(password, String(stored)));
}

export function proveSecondFactor(proof: { code?: string; recoveryCode?: string }) {
  return verifyMfaProof(OWNER_PRINCIPAL, proof);
}

export function badCode(): Response {
  return NextResponse.json({ error: "Invalid code" }, { status: 400 });
}
