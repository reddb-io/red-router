import { handleSystemOneCore } from "../open-sse/handlers/systemOneCore.js";

const apiKey = process.env.TYPESAFE_AI_API_KEY?.trim();
if (!apiKey) {
  console.error("TYPESAFE_AI_API_KEY is required for the real System One release smoke test.");
  process.exit(2);
}

const result = await handleSystemOneCore({
  body: {
    state: "RedRouter release validation",
    model: "jev-latest",
    questions: {
      readiness: {
        type: "noul",
        instructions: "Does this state describe a release validation?",
      },
    },
  },
  credentials: { apiKey },
});

let payload = null;
try { payload = await result.response.clone().json(); } catch {}

if (!result.success || !payload || typeof payload !== "object" || Array.isArray(payload)) {
  console.error(`System One smoke failed with status ${result.status}.`);
  process.exit(1);
}
if (!payload.answers || typeof payload.answers !== "object" || Array.isArray(payload.answers)) {
  console.error("System One smoke returned no answers object.");
  process.exit(1);
}

console.log(`System One smoke passed (${result.status}, model=${payload.model || "jev-latest"}).`);
