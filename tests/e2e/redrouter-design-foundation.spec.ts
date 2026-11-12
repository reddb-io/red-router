import { expect, test } from "@playwright/test";

test("the native dashboard shell renders without remote runtime assets", async ({ page }) => {
  const remoteAssets: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") remoteAssets.push(url.href);
  });

  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "application");
  await expect(page.getByRole("heading", { name: "RedRouter", exact: true })).toBeVisible();
  await expect(page.getByLabel("Administrator key")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in locally" })).toBeDisabled();

  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  expect(remoteAssets).toEqual([]);
});
