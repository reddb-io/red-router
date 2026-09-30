// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "red-router" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (k: string) => (ns ? `${ns}.${k}` : k),
}));
vi.mock("@/shared/components/ProviderIcon", () => ({
  default: ({ alt }: { alt?: string }) => <span data-testid="provider-icon">{alt}</span>,
}));

import ProviderSettingsPanel from "../ProviderSettingsPanel";
import ProviderPageHeader from "../ProviderPageHeader";

const DEFAULT = "http://127.0.0.1:25050/v1";
const context = { defaultBaseUrl: DEFAULT, baseUrlConfigurable: true };

const custom = {
  id: "c1",
  name: "Remote box",
  isActive: true,
  providerSpecificData: { baseUrl: "http://10.0.0.7:25050/v1", tag: "work" },
};
const plain = { id: "c2", name: "Local", isActive: false, providerSpecificData: {} };

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

const text = () => document.body.textContent ?? "";
const button = (label: string, exact = false) =>
  [...document.body.querySelectorAll("button")].find((b) =>
    exact ? b.textContent?.trim() === label : b.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;
const click = (el: Element | undefined) => {
  expect(el).toBeTruthy();
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

function panel(props: Partial<React.ComponentProps<typeof ProviderSettingsPanel>> = {}) {
  return (
    <ProviderSettingsPanel
      providerName="RedRouter"
      connections={[custom, plain]}
      context={context}
      open
      onToggle={() => {}}
      onEditConnection={() => {}}
      onResetConnection={async () => {}}
      {...props}
    />
  );
}

describe("ProviderSettingsPanel", () => {
  it("shows only a summary while closed, and toggles from its own header", () => {
    const onToggle = vi.fn();
    mount(panel({ open: false, onToggle }));
    expect(text()).toContain("RedRouter settings");
    expect(text()).toContain("2 connections");
    expect(text()).not.toContain("Destination");
    click(button("RedRouter settings"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(button("RedRouter settings")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists each connection with its destination, marked Custom or Default", () => {
    mount(panel());
    expect(text()).toContain("Remote box");
    expect(text()).toContain("http://10.0.0.7:25050/v1");
    expect(text()).toContain("Custom");
    expect(text()).toContain("Group tag");
    expect(text()).toContain(DEFAULT);
    expect(text()).toContain("Default");
    expect(text()).toContain("Disabled");
  });

  it("opens the edit window for the connection that was clicked", () => {
    const onEditConnection = vi.fn();
    mount(panel({ onEditConnection }));
    const edits = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Edit"
    );
    expect(edits).toHaveLength(2);
    click(edits[0]);
    expect(onEditConnection).toHaveBeenCalledWith(custom);
  });

  it("offers Reset only where there is something to reset", () => {
    mount(panel());
    expect(
      [...document.body.querySelectorAll("button")].filter((b) =>
        b.textContent?.includes("Reset to defaults")
      )
    ).toHaveLength(1);
  });

  it("asks first, says what changes, and only then resets", async () => {
    const onResetConnection = vi.fn().mockResolvedValue(undefined);
    mount(panel({ onResetConnection }));
    click(button("Reset to defaults"));
    expect(text()).toContain("Reset to defaults?");
    expect(text()).toContain(`Destination: http://10.0.0.7:25050/v1 → ${DEFAULT}`);
    expect(text()).toContain("Group tag: work → cleared");
    expect(text()).toContain("API key and credentials are not touched");
    expect(onResetConnection).not.toHaveBeenCalled();

    await act(async () => {
      click(button("Reset", true));
    });
    expect(onResetConnection).toHaveBeenCalledWith(custom, ["baseUrl", "tag"]);
    expect(text()).not.toContain("Reset to defaults?");
  });

  it("keeps the dialog open and shows the reason when the reset fails", async () => {
    const onResetConnection = vi.fn().mockRejectedValue(new Error("The reset failed (500)."));
    mount(panel({ onResetConnection }));
    click(button("Reset to defaults"));
    await act(async () => {
      click(button("Reset", true));
    });
    expect(text()).toContain("The reset failed (500).");
    expect(text()).toContain("Reset to defaults?");
  });

  it("cancelling changes nothing", () => {
    const onResetConnection = vi.fn();
    mount(panel({ onResetConnection }));
    click(button("Reset to defaults"));
    click(button("Cancel", true));
    expect(onResetConnection).not.toHaveBeenCalled();
    expect(text()).not.toContain("Reset to defaults?");
  });

  it("shows a custom provider's own settings with an Edit provider button", () => {
    const onEditProvider = vi.fn();
    mount(
      panel({
        providerNode: {
          name: "My gateway",
          prefix: "gw",
          baseUrl: "https://gw.example.com/v1",
          apiType: "chat",
        },
        onEditProvider,
      })
    );
    expect(text()).toContain("Custom provider");
    expect(text()).toContain("My gateway");
    expect(text()).toContain("gw");
    expect(text()).toContain("https://gw.example.com/v1");
    click(button("Edit provider"));
    expect(onEditProvider).toHaveBeenCalledTimes(1);
  });

  it("says so when there is nothing to configure yet", () => {
    mount(panel({ connections: [] }));
    expect(text()).toContain("No connections yet");
    expect(text()).toContain("Add a connection first");
  });
});

describe("the Settings button in the provider header", () => {
  const header = (over: Partial<React.ComponentProps<typeof ProviderPageHeader>> = {}) => (
    <ProviderPageHeader
      providerId="red-router"
      providerInfo={{ id: "red-router", name: "RedRouter", color: "#ff2056" }}
      connectionsCount={1}
      isOpenAICompatible={false}
      isAnthropicProtocolCompatible={false}
      onOpenTutorial={() => {}}
      t={((key: string) => key) as never}
      {...over}
    />
  );

  it("sits at the top, reports whether the panel is open, and toggles it", () => {
    const onToggleSettings = vi.fn();
    mount(header({ onToggleSettings, settingsOpen: false }));
    const cog = button("Settings")!;
    expect(cog.getAttribute("aria-expanded")).toBe("false");
    expect(cog.getAttribute("aria-controls")).toBe("provider-settings-panel");
    click(cog);
    expect(onToggleSettings).toHaveBeenCalledTimes(1);
  });

  it("reflects the open state", () => {
    mount(header({ onToggleSettings: () => {}, settingsOpen: true }));
    expect(button("Settings")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("is absent when the page gives it nothing to open", () => {
    mount(header());
    expect(button("Settings")).toBeUndefined();
  });
});
