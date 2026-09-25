import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brandingCss, loadBranding, normalizeBranding, publicBranding, readBrandingAsset, saveBranding } from "@/lib/branding";

let dir;
let env;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-brand-"));
  env = { RED_ROUTER_BRANDING: path.join(dir, "branding.json") };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (doc) => fs.writeFileSync(env.RED_ROUTER_BRANDING, JSON.stringify(doc));

describe("white-label branding", () => {
  it("is the default RedRouter look without a file", () => {
    expect(loadBranding(env)).toBeNull();
    expect(publicBranding(null)).toMatchObject({ name: "RedRouter", custom: false, logo: null, login: { title: "RedRouter" } });
    expect(brandingCss(null)).toBe("");
  });

  it("applies name, login and images from the file", () => {
    write({
      name: "Acme AI", logo: "https://acme.test/logo.svg", favicon: "fav.png",
      login: { subtitle: "Sign in with Acme", background: "#0b1020", footer: "© Acme" },
      theme: { colorScheme: "dark" },
    });
    const brand = publicBranding(loadBranding(env));
    expect(brand).toMatchObject({
      name: "Acme AI", custom: true, logo: "https://acme.test/logo.svg", logoDark: "https://acme.test/logo.svg",
      favicon: "/api/branding/asset/favicon", colorScheme: "dark",
      login: { title: "Acme AI", subtitle: "Sign in with Acme", footer: "© Acme", backgroundColor: "#0b1020", backgroundImage: null },
    });
  });

  it("turns the theme into CSS custom properties on top of the design system", () => {
    const { value } = normalizeBranding({
      theme: { primary: "#2563eb", radius: "8px", fontFamily: "Inter, sans-serif", light: { "--reddb-color-background": "#fff" }, dark: { "--color-surface": "rgb(10, 10, 20)" } },
    });
    const css = brandingCss(value);
    expect(css).toContain("--reddb-color-primary: #2563eb;");
    expect(css).toContain("--reddb-color-brand-hover: color-mix(in srgb, #2563eb 85%, black);");
    expect(css).toContain("--reddb-radius-md: 8px;");
    expect(css).toContain("--reddb-font-family-sans: Inter, sans-serif;");
    expect(css).toMatch(/:root\[data-color-scheme="light"\] \{\n  --reddb-color-background: #fff;\n\}/);
    expect(css).toMatch(/:root\[data-color-scheme="dark"\], :root\.dark \{\n  --color-surface: rgb\(10, 10, 20\);\n\}/);
  });

  it("drops anything that could escape the stylesheet or the branding folder", () => {
    const { value, errors } = normalizeBranding({
      logo: "javascript:alert(1)",
      logoDark: 'https://x.test/a.png") , url("https://evil.test/track',
      favicon: "../../etc/passwd.svg",
      theme: {
        primary: "red; } body { display:none",
        fontFamily: "x; } </style><script>",
        light: { "--reddb-color-background": "#fff; } * { color: red", "background": "red", "--evil}{": "x" },
      },
    });
    expect(value.logo).toBeNull();
    expect(value.logoDark).toBeNull();
    expect(value.favicon).toBeNull();
    expect(value.theme.primary).toBeNull();
    expect(value.theme.fontFamily).toBeNull();
    expect(value.theme.light).toEqual({});
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(brandingCss(value)).not.toMatch(/[<>]|display:none/);
  });

  it("serves a file image only when it sits next to the JSON", () => {
    fs.writeFileSync(path.join(dir, "logo.svg"), "<svg/>");
    write({ logo: "logo.svg" });
    expect(readBrandingAsset("logo", env)).toMatchObject({ type: "image/svg+xml" });
    expect(readBrandingAsset("secret", env)).toBeNull();
    expect(readBrandingAsset("favicon", env)).toBeNull();
  });

  it("re-reads the file when it changes, and saves what the settings page sends", () => {
    write({ name: "One" });
    expect(loadBranding(env).name).toBe("One");
    const later = new Date(Date.now() + 2000);
    saveBranding({ name: "Two" }, env);
    fs.utimesSync(env.RED_ROUTER_BRANDING, later, later);
    expect(loadBranding(env).name).toBe("Two");
    expect(saveBranding([], env).errors).toEqual(["branding must be a JSON object"]);
  });
});
