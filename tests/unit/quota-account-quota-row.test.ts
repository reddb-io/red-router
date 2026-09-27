/**
 * Task 6 — AccountQuotaRow structural tests
 *
 * These tests use source-level assertions (readFileSync) so they work with the
 * Node.js native test runner without a DOM / React rendering setup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ACCOUNT_QUOTA_ROW_PATH = join(
  ROOT,
  "src/app/(dashboard)/dashboard/costs/quota-share/components/AccountQuotaRow.tsx"
);

const POOL_CARD_PATH = join(
  ROOT,
  "src/app/(dashboard)/dashboard/costs/quota-share/components/PoolCard.tsx"
);

const EN_PATH = join(ROOT, "src/i18n/messages/en.json");

// ── Load sources ─────────────────────────────────────────────────────────────

const accountQuotaSrc = readFileSync(ACCOUNT_QUOTA_ROW_PATH, "utf8");
const poolCardSrc = readFileSync(POOL_CARD_PATH, "utf8");

// ── English catalog ─────────────────────────────────────────────────────────

const NEW_KEYS = ["accountQuotaTitle", "accountQuotaNone"] as const;

test("English catalog contains account quota labels", () => {
  const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<string, Record<string, string>>;
  for (const key of NEW_KEYS) {
    assert.equal(typeof en.quotaShare?.[key], "string", `en.json missing quotaShare.${key}`);
  }
});

// ── AccountQuotaRow structural assertions ────────────────────────────────────

test("AccountQuotaRow: fetches /api/usage/provider-limits endpoint", () => {
  assert.ok(accountQuotaSrc.includes("/api/usage/provider-limits"));
});

test("AccountQuotaRow: guards caches with optional chaining", () => {
  assert.ok(accountQuotaSrc.includes("caches?.["));
});

test("AccountQuotaRow: guards connectionIds before use", () => {
  assert.ok(accountQuotaSrc.includes("Array.isArray(connectionIds)"));
});

test("AccountQuotaRow: guards parsed quotas before iteration", () => {
  assert.ok(accountQuotaSrc.includes("Array.isArray(parsed)"));
});

test("AccountQuotaRow: renders empty state", () => {
  assert.ok(accountQuotaSrc.includes("accountQuotaNone"));
});

test("AccountQuotaRow: renders provider icons", () => {
  assert.ok(accountQuotaSrc.includes("ProviderIcon"));
});

test("AccountQuotaRow: cleans up fetch on unmount", () => {
  assert.ok(accountQuotaSrc.includes("alive = false"));
});

// ── PoolCard mounts AccountQuotaRow ──────────────────────────────────────────

test("PoolCard: imports AccountQuotaRow", () => {
  assert.ok(poolCardSrc.includes("AccountQuotaRow"));
});

test("PoolCard: mounts AccountQuotaRow in JSX", () => {
  assert.ok(poolCardSrc.includes("<AccountQuotaRow"));
});

test("PoolCard: passes connectionIds to AccountQuotaRow", () => {
  assert.ok(poolCardSrc.includes("connectionIds={connectionIds}"));
});

test("PoolCard: declares connectionIds in its props", () => {
  assert.ok(poolCardSrc.includes("connectionIds?:"));
});
