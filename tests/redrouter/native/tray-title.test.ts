import assert from "node:assert/strict";
import { test } from "node:test";

const { initSystrayUnix } = await import("../../../bin/cli/tray/traySystray.mjs");

function fakeSystray() {
  const created: Array<{
    menu: { title: string; tooltip: string; items: Array<{ title: string }> };
  }> = [];
  class FakeSysTray {
    constructor(config: (typeof created)[number]) {
      created.push(config);
    }
    onClick() {}
    async ready() {}
  }
  return { ctor: async () => FakeSysTray, created };
}

async function menuOn(platform: string) {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const fake = fakeSystray();
    await initSystrayUnix({ port: 25050, trayOnly: true }, fake.ctor as never);
    return fake.created[0].menu;
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

test("on Linux the tray shows the product name next to the icon", async () => {
  const menu = await menuOn("linux");
  assert.equal(menu.title, "RedRouter");
  assert.match(menu.tooltip, /^RedRouter/);
});

test("macOS keeps the bare icon (no title beside it)", async () => {
  assert.equal((await menuOn("darwin")).title, "");
});

test("the menu still names the product and the port", async () => {
  const menu = await menuOn("linux");
  assert.ok(menu.items[0].title.includes("RedRouter"));
  assert.ok(menu.items[0].title.includes("25050"));
});

test("diagnostic file open failures keep the tray alive and print an offline recovery command", async () => {
  let click: ((action: { seq_id: number }) => Promise<void>) | undefined;
  let menu: { items: Array<{ title: string }> } | undefined;
  class FakeSysTray {
    constructor(config: { menu: typeof menu }) {
      menu = config.menu;
    }
    onClick(callback: typeof click) {
      click = callback;
    }
    async ready() {}
  }
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof original;
  try {
    await initSystrayUnix(
      {
        port: 25050,
        trayOnly: true,
        onShowLogs: async () => {
          throw new Error("text viewer unavailable");
        },
      },
      (async () => FakeSysTray) as never
    );
    assert.equal(menu!.items[2].title, "Open Diagnostic Logs");
    await assert.doesNotReject(click!({ seq_id: 2 }));
    assert.match(stderr, /red-router logs --path/);
  } finally {
    process.stderr.write = original;
  }
});
