import { describe, expect, it } from "vitest";
import {
  catalogPage,
  emptyCatalogFilters,
  selectCatalogModels,
  type CatalogModel,
} from "../../../rust-dashboard/catalogModels";

const models: CatalogModel[] = [
  { id: "unknown" },
  { id: "free", type: "chat", reasoning: false, cost: { input: 0 }, limit: { context: 8192 } },
  {
    id: "vision",
    name: "Vision model",
    type: "chat",
    family: "example",
    tool_call: true,
    reasoning: true,
    structured_output: true,
    cost: { input: 2 },
    limit: { context: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
];

describe("catalog discovery controls", () => {
  it("combines metadata, capability, modality and context filters without granting missing capabilities", () => {
    const result = selectCatalogModels(
      models,
      {
        ...emptyCatalogFilters,
        query: "EXAMPLE",
        type: "chat",
        capability: "reasoning",
        inputModality: "image",
        minContext: 128000,
      },
      "id",
      false
    );
    expect(result.map((model) => model.id)).toEqual(["vision"]);
    expect(
      selectCatalogModels(models, { ...emptyCatalogFilters, minContext: 200000 }, "id", false)
    ).toEqual([]);
    expect(
      selectCatalogModels(
        models,
        { ...emptyCatalogFilters, query: "structured output" },
        "id",
        false
      ).map((model) => model.id)
    ).toEqual(["vision"]);
  });
  it("keeps unknown prices last in both directions without confusing free with unknown", () => {
    expect(
      selectCatalogModels(models, emptyCatalogFilters, "input-price", false).map(
        (model) => model.id
      )
    ).toEqual(["free", "vision", "unknown"]);
    expect(
      selectCatalogModels(models, emptyCatalogFilters, "input-price", true).map((model) => model.id)
    ).toEqual(["vision", "free", "unknown"]);
    expect(models[0].id).toBe("unknown");
  });
  it("bounds rendered rows and clamps the page after filters shrink the results", () => {
    const many = Array.from({ length: 121 }, (_, index) => ({ id: String(index) }));
    expect(catalogPage(many, 0).rows).toHaveLength(50);
    expect(catalogPage(many, 2).rows).toHaveLength(21);
    expect(catalogPage(models, 100)).toMatchObject({ page: 0, pageCount: 1, rows: models });
    expect(catalogPage([], 1)).toEqual({ page: 0, pageCount: 1, rows: [] });
  });
});
