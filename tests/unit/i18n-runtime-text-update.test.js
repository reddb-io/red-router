import { describe, expect, it } from "vitest";
import { processTextNode } from "@/i18n/runtime.js";

// The minimum of a DOM text node processTextNode reads: its value and an element parent.
const textNode = (value) => ({
  nodeValue: value,
  parentElement: { tagName: "H1", hasAttribute: () => false, parentElement: null },
});

describe("runtime i18n and text React updates in place", () => {
  it("keeps the new text when React rewrites a node, instead of restoring the first one", () => {
    const title = textNode("Quota Tracker");
    processTextNode(title);
    expect(title.nodeValue).toBe("Quota Tracker");

    // Navigating from Quota Tracker to Combos reuses the same <h1> text node.
    title.nodeValue = "Routing Combos";
    processTextNode(title);
    expect(title.nodeValue).toBe("Routing Combos");

    // A later pass over the page (e.g. new nodes elsewhere) must not bring the old title back.
    processTextNode(title);
    expect(title.nodeValue).toBe("Routing Combos");
  });
});
