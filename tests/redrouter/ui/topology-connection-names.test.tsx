// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const push = vi.fn();
const router = { push };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/dynamic", async () => {
  const { default: ProviderTopology } = await import("@/app/(dashboard)/home/ProviderTopology");
  return { default: () => ProviderTopology };
});
vi.mock("@/hooks/useLiveDashboard", () => ({
  useLiveRequests: () => ({ activeRequests: [] }),
}));
vi.mock("@/app/(dashboard)/home/HomeRecentRequests", () => ({ default: () => null }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}));
vi.mock("@/shared/components/flow/FlowCanvas", () => ({
  FlowCanvas: ({
    nodes,
    nodeTypes,
    onNodeClick,
  }: {
    nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
    nodeTypes: Record<string, React.ComponentType<{ data: Record<string, unknown> }>>;
    onNodeClick: (event: React.MouseEvent, node: unknown) => void;
  }) => (
    <div data-testid="topology">
      {nodes.map((node) => {
        const Component = nodeTypes[node.type];
        return (
          <div key={node.id} data-testid={node.id} onClick={(event) => onNodeClick(event, node)}>
            <Component data={node.data} />
          </div>
        );
      })}
    </div>
  ),
}));

import HomePageClient from "@/app/(dashboard)/dashboard/HomePageClient";

const provider = "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441";
const secondProvider = "openai-compatible-chat-12669115-2545-4896-b003-cb4dac09d441";
let root: Root;
let container: HTMLDivElement;
let connections: Array<Record<string, unknown>>;
let nodes: Array<Record<string, unknown>>;
let nodeLookupFailed: boolean;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  connections = [{ id: "key-1", provider, name: "Karavela", isActive: true }];
  nodes = [{ id: provider, name: "OAI-COMPAT" }];
  nodeLookupFailed = false;
  push.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/provider-nodes" && nodeLookupFailed) throw new Error("Discovery offline");
      const body =
        url === "/api/providers"
          ? { connections }
          : url === "/api/provider-nodes"
            ? { nodes }
            : url === "/api/settings"
              ? { showProviderTopologyOnHome: true }
              : {};
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderHome() {
  await act(async () => root.render(<HomePageClient />));
}

it("renders Karavela from the connection instead of OAI-COMPAT and keeps navigation identity", async () => {
  await renderHome();
  const node = container.querySelector(`[data-testid="provider-${provider}"]`);
  expect(node?.textContent).toBe("Karavela");
  expect(node?.querySelector("[title]")?.getAttribute("title")).toBe("Karavela");
  act(() => node?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(push).toHaveBeenCalledWith(`/proxy/providers/${provider}`);
});

it("retains the connection name when node discovery fails", async () => {
  nodeLookupFailed = true;
  await renderHome();
  expect(container.querySelector(`[data-testid="provider-${provider}"]`)?.textContent).toBe(
    "Karavela"
  );
});

it("keeps distinct providers separate and includes only enabled names in each grouped node", async () => {
  connections.push(
    { id: "key-2", provider, name: "Backup", isActive: true },
    { id: "key-3", provider, name: "Disabled", isActive: false },
    { id: "key-4", provider: secondProvider, name: "Second gateway", isActive: true }
  );
  await renderHome();
  expect(container.querySelector(`[data-testid="provider-${provider}"]`)?.textContent).toBe(
    "Karavela, Backup"
  );
  expect(container.querySelector(`[data-testid="provider-${secondProvider}"]`)?.textContent).toBe(
    "Second gateway"
  );
});
