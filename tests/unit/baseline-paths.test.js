import { describe, expect, it } from "vitest";
import { failedTestNames, normalizeTestPath } from "../__baseline__/paths.mjs";

describe("baseline path normalization", () => {
  it.each([
    ["/work/app/tests/unit/a.test.js", "tests/unit/a.test.js"],
    ["C:\\work\\app\\tests\\unit\\a.test.js", "tests/unit/a.test.js"],
    ["tests/unit/a.test.js", "tests/unit/a.test.js"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeTestPath(input)).toBe(expected);
  });

  it("formats failed assertions and rejects malformed reports", () => {
    expect(failedTestNames({ testResults: [{ name: "/x/tests/unit/a.test.js", assertionResults: [
      { status: "passed", fullName: "ok" },
      { status: "failed", fullName: "broken" },
    ] }] })).toEqual(["tests/unit/a.test.js :: broken"]);
    expect(() => failedTestNames({})).toThrow(/testResults/);
  });
});
