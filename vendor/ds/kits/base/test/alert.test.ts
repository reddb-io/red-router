import { createRawSnippet, type Snippet } from "svelte";
import { describe, expect, it } from "vitest";
import { ALERT_FEEDBACK_ROLES, Alert, alert } from "./fixtures/alert-consumer";
import { classes, classesOf, render, rendered } from "./mount";

function text(content: string): Snippet {
  return createRawSnippet(() => ({ render: () => `<span>${content}</span>` }));
}

describe("the Base Alert", () => {
  it("is available with its Feedback Role appearance seam through Base", () => {
    expect(Alert).toBeDefined();
    expect(alert).toBeTypeOf("function");
    expect(ALERT_FEEDBACK_ROLES).toEqual(["info", "success", "warning", "danger"]);
  });

  it("announces info, success, and warning as status, and danger as an error alert", () => {
    for (const feedback of ALERT_FEEDBACK_ROLES) {
      const element = rendered(render(Alert, { feedback, children: text("Deployment changed") }));
      expect(element.getAttribute("role")).toBe(feedback === "danger" ? "alert" : "status");
    }
  });

  it("renders an optional title and caller-owned detail", () => {
    const element = rendered(
      render(Alert, {
        feedback: "success",
        title: "Deployment complete",
        children: text("The new release is live."),
      }),
    );
    expect(element.textContent).toContain("Deployment complete");
    expect(element.textContent).toContain("The new release is live.");
  });

  it("wears only stable Feedback Role names under every meaning", () => {
    for (const feedback of ALERT_FEEDBACK_ROLES) {
      const element = rendered(render(Alert, { feedback }));
      expect(classes(element)).toEqual(classesOf(alert({ feedback })));
      expect([...classes(element)].join(" ")).toContain(`--reddb-color-feedback-${feedback}-`);
      expect([...classes(element)].join(" ")).not.toMatch(/(?:red|green|yellow|neutral)-\d/);
    }
  });

  it("forwards native attributes and merges a caller class", () => {
    const element = rendered(
      render(Alert, { feedback: "warning", id: "quota-warning", class: "mt-4" }),
    );
    expect(element.id).toBe("quota-warning");
    expect(classes(element)).toEqual(classesOf(alert({ feedback: "warning", class: "mt-4" })));
  });
});
