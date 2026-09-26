import type { RegistryEntry } from "../../shared.ts";

/** Atria Dawn's preview is text-only; the upstream rejects images and PDFs. */
export const atriaProvider: RegistryEntry = {
  id: "atria",
  alias: "atria",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.atria-asi.ai/v1/chat/completions",
  modelsUrl: "https://api.atria-asi.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  models: [{ id: "Atria-Dawn-Preview", name: "Atria Dawn Preview" }],
  passthroughModels: true,
};
