import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`tenant session loads its workspace and respects owner locks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const password =
      process.env.OMNIROUTE_E2E_PASSWORD ||
      process.env.INITIAL_PASSWORD ||
      "omniroute-e2e-password";
    expect((await page.request.post("/api/auth/login", { data: { password } })).ok()).toBe(true);
    const slug = `tenant-ui-${width}-${Date.now().toString(36)}`;
    const created = await page.request.post("/api/tenants", {
      data: { slug, name: "Workspace fixture" },
    });
    expect(created.ok()).toBe(true);
    const tenant = (await created.json()).tenant;
    try {
      const member = await page.request.post(`/api/tenants/${tenant.id}/users`, {
        data: { email: `admin@${slug}.test`, role: "admin" },
      });
      expect(member.ok()).toBe(true);
      const user = (await member.json()).user;
      const invitation = await page.request.post(
        `/api/tenants/${tenant.id}/users/${user.id}/invite`
      );
      expect(invitation.ok()).toBe(true);
      const { token } = await invitation.json();
      const tenantPassword = "Cobalt-river-Spring-42!";
      const accepted = await page.request.post("/api/auth/tenant/accept-invite", {
        data: { token, password: tenantPassword },
      });
      expect(accepted.ok(), await accepted.text()).toBe(true);
      expect(
        (
          await page.request.put(`/api/tenants/${tenant.id}/routing`, {
            data: { transparent: true, priority: [] },
          })
        ).ok()
      ).toBe(true);
      expect(
        (
          await page.request.post("/api/auth/tenant/login", {
            data: { email: user.email, password: tenantPassword },
          })
        ).ok()
      ).toBe(true);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/login#tenant");
      await expect(page.getByRole("heading", { name: "Workspace fixture" })).toBeVisible();
      await expect(page.getByLabel("Reporting month (UTC)")).toBeVisible();
      await page.getByRole("button", { name: "Members", exact: true }).click();
      await expect(page.getByRole("table")).toContainText(user.email);
      await page.getByRole("button", { name: "Routing", exact: true }).click();
      await expect(page.getByLabel("Model visibility", { exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Save routing", exact: true })).toBeDisabled();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Workspace fixture" })).toBeVisible();
      const [signedOut] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/auth/tenant/logout")),
        page.getByRole("button", { name: "Sign out", exact: true }).click(),
      ]);
      expect(signedOut.ok(), await signedOut.text()).toBe(true);
      await expect(
        page.getByRole("heading", { name: "Tenant sign-in", exact: true })
      ).toBeVisible();
      await expect(page.getByLabel(/^Password(?:\s*\*)?$/)).toBeVisible();
      expect((await page.request.get("/api/tenant/me")).status()).toBe(401);
      expect(errors).toEqual([]);
    } finally {
      expect((await page.request.delete(`/api/tenants/${tenant.id}`)).ok()).toBe(true);
    }
  });
}
