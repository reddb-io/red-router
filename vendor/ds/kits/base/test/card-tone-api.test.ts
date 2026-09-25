import { describe, expect, it } from "vitest";
import { CARD_TONES } from "./fixtures/surface-separation-consumer";

describe("the Base Card tone vocabulary", () => {
  it("publishes the shared tone set through the Base Kit entry point", () => {
    expect(CARD_TONES).toEqual([
      "neutral",
      "brand",
      "success",
      "warning",
      "danger",
      "info",
    ]);
  });
});
