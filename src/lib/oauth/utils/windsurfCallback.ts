type WindsurfCallbackResult =
  | { ok: true; token: string; state: string }
  | { ok: false; reason: "invalid_callback" | "missing_token" | "state_mismatch" };

/** Parse the copied implicit-flow callback without accepting a token from another redirect. */
export function parseWindsurfCallback(
  input: string,
  redirectUri: string,
  expectedState: string
): WindsurfCallbackResult {
  if (!redirectUri || !expectedState || input.length > 24 * 1024) {
    return { ok: false, reason: "invalid_callback" };
  }

  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(input);
    expected = new URL(redirectUri);
  } catch {
    return { ok: false, reason: "invalid_callback" };
  }

  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  ) {
    return { ok: false, reason: "invalid_callback" };
  }

  const tokens = callback.searchParams.getAll("access_token");
  if (tokens.length !== 1 || !tokens[0]) return { ok: false, reason: "missing_token" };

  const states = callback.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) {
    return { ok: false, reason: "state_mismatch" };
  }

  return { ok: true, token: tokens[0], state: states[0] };
}
