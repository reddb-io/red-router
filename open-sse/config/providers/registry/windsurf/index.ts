import type { RegistryEntry } from "../../shared.ts";
import { WINDSURF_MODELS } from "../../../windsurfModels.ts";

export const windsurfProvider: RegistryEntry = {
  id: "windsurf",
  alias: "ws",
  format: "openai",
  executor: "windsurf",
  baseUrl: "https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetChatMessage",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  forceStream: true,
  models: WINDSURF_MODELS,
};
