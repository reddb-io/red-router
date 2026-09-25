import { describe, expect, it } from "vitest";
import { FREE_PROVIDERS, NO_AUTH_PROVIDERS } from "@/shared/constants/providers.js";

describe("no-auth providers shown without a connection", () => {
  it("leaves out retired (hidden) providers such as MiMo Code Free", () => {
    expect(FREE_PROVIDERS["mimo-free"]).toMatchObject({ noAuth: true, hidden: true });
    const ids = NO_AUTH_PROVIDERS.map((p) => p.id);
    expect(ids).not.toContain("mimo-free");
    expect(NO_AUTH_PROVIDERS.every((p) => p.noAuth && !p.hidden)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });
});
