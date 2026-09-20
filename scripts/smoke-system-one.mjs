import { pathToFileURL } from "node:url";

const REQUEST_BODY = {
  state: "RedRouter release validation",
  questions: {
    readiness: {
      type: "noul",
      instructions: "Does this state describe a release validation?",
    },
  },
};

function endpoint(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/systemone") ? normalized : `${normalized}/systemone`;
}

function nativeCandidate({ id, baseUrl, model, token }) {
  return {
    id,
    endpoint: endpoint(baseUrl),
    model,
    token,
    body: { ...REQUEST_BODY, model },
    headers: {},
  };
}

/**
 * Build a provider cascade for the release smoke. Configured providers run
 * first; OpenCode Zen's public JEV model is the credential-free final route.
 * A custom native System One endpoint keeps newly available gateways usable
 * without coupling the release workflow to another hard-coded vendor.
 */
export function buildSystemOneSmokeCandidates(env = process.env) {
  const candidates = [];

  if (env.SYSTEM_ONE_SMOKE_BASE_URL && env.SYSTEM_ONE_SMOKE_MODEL) {
    candidates.push(nativeCandidate({
      id: env.SYSTEM_ONE_SMOKE_PROVIDER || "custom",
      baseUrl: env.SYSTEM_ONE_SMOKE_BASE_URL,
      model: env.SYSTEM_ONE_SMOKE_MODEL,
      token: env.SYSTEM_ONE_SMOKE_API_KEY,
    }));
  }

  const typesafeToken = env.TYPESAFE_AI_API_KEY || env.TYPESAFE_API_KEY;
  if (typesafeToken) {
    candidates.push(nativeCandidate({
      id: "typesafe",
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-1.13.0",
      token: typesafeToken,
    }));
  }

  const cloudflareToken = env.CLOUDFLARE_API_TOKEN || env.CF_AIG_TOKEN;
  if (cloudflareToken && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_GATEWAY_ID) {
    candidates.push({
      id: "cloudflare-ai-gateway",
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run`,
      model: "typesafe/jev",
      token: cloudflareToken,
      headers: { "cf-aig-gateway-id": env.CLOUDFLARE_GATEWAY_ID },
      body: {
        model: "typesafe/jev",
        input: REQUEST_BODY,
      },
    });
  }

  if (env.VIVGRID_API_KEY) {
    candidates.push(nativeCandidate({
      id: "vivgrid",
      baseUrl: "https://api.vivgrid.com/v1",
      model: "jev",
      token: env.VIVGRID_API_KEY,
    }));
  }

  if (env.NANO_GPT_API_KEY) {
    candidates.push(nativeCandidate({
      id: "nano-gpt",
      baseUrl: "https://nano-gpt.com/api/v1",
      model: "typesafe/jev-latest",
      token: env.NANO_GPT_API_KEY,
    }));
  }

  candidates.push(nativeCandidate({
    id: "opencode-zen",
    baseUrl: "https://opencode.ai/zen/v1",
    model: "jev-1.13-free",
    token: env.OPENCODE_API_KEY || "public",
  }));

  return candidates;
}

function validNoulPayload(payload) {
  const answer = payload?.answers?.readiness;
  return answer?.type === "noul"
    && typeof answer.noul === "number"
    && answer.noul >= 0
    && answer.noul <= 1;
}

export async function runSystemOneSmoke({
  env = process.env,
  fetchImpl = fetch,
  log = console,
} = {}) {
  const failures = [];

  for (const candidate of buildSystemOneSmokeCandidates(env)) {
    log.info(`System One smoke: trying ${candidate.id} (${candidate.model}).`);
    try {
      const response = await fetchImpl(candidate.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(candidate.token ? { Authorization: `Bearer ${candidate.token}` } : {}),
          ...candidate.headers,
        },
        body: JSON.stringify(candidate.body),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!validNoulPayload(payload)) throw new Error("invalid Noul response");

      log.info(`System One smoke passed via ${candidate.id} (${response.status}, model=${payload.model || candidate.model}).`);
      return { provider: candidate.id, model: payload.model || candidate.model, status: response.status, payload };
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? "timeout" : error?.message || "request failed";
      failures.push(`${candidate.id}: ${reason}`);
      log.warn(`System One smoke: ${candidate.id} unavailable (${reason}); trying the next route.`);
    }
  }

  throw new Error(`System One smoke failed across all routes: ${failures.join("; ")}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await runSystemOneSmoke();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
