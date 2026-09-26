import { Buffer } from "node:buffer";

/**
 * Edge TTS (Bing translator endpoint) — no auth.
 *
 * Ported from the legacy fork (open-sse/handlers/ttsProviders/edgeTts.js @
 * c66f917c). The upstream is reverse-engineered and unofficial (same class of
 * integration as gtts): a Bing `params_AbusePreventionHelper` token is scraped
 * from the translator page, then SSML is POSTed to `tfettts`. Per-IP
 * rate-limited by Bing without notice; on 429/403 the token cache is
 * invalidated and the request retried once.
 */

const EDGE_TTS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REFRESH_MS = 5 * 60 * 1000; // token TTL ~1h, refresh early
const DEFAULT_VOICE = "vi-VN-HoaiMyNeural";
const MIN_AUDIO_BYTES = 1024;

const TOKEN_URL = "https://www.bing.com/translator";
const TTS_URL = "https://www.bing.com/tfettts?isVertical=1&&IG=1&IID=translator.5023&SFX=1";

export class EdgeTtsUpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EdgeTtsUpstreamError";
    this.status = status;
  }
}

interface BingToken {
  key: string;
  token: string;
  cookie: string;
}

const cache: { token: BingToken | null; tokenTime: number } = { token: null, tokenTime: 0 };

async function getBingTtsToken(): Promise<BingToken> {
  const now = Date.now();
  if (cache.token && now - cache.tokenTime < REFRESH_MS) return cache.token;
  const res = await fetch(TOKEN_URL, {
    headers: { "User-Agent": EDGE_TTS_USER_AGENT, "Accept-Language": "vi,en-US;q=0.9,en;q=0.8" },
  });
  if (!res.ok) {
    throw new EdgeTtsUpstreamError(res.status, `Bing translator fetch failed: ${res.status}`);
  }
  const rawCookies = res.headers.getSetCookie?.() || [];
  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");
  const html = await res.text();
  const match = html.match(/params_AbusePreventionHelper\s*=\s*\[([^,]+),([^,]+),/);
  if (!match) {
    throw new EdgeTtsUpstreamError(502, "Failed to parse Bing token");
  }
  cache.token = {
    key: match[1],
    token: match[2].replace(/"/g, ""),
    cookie,
  };
  cache.tokenTime = now;
  return cache.token;
}

async function bingTtsRequest(text: string, voiceId: string, token: BingToken): Promise<Response> {
  const parts = voiceId.split("-");
  const xmlLang = parts.slice(0, 2).join("-");
  const gender = voiceId.toLowerCase().includes("male") ? "Male" : "Female";
  const ssml = `<speak version='1.0' xml:lang='${xmlLang}'><voice xml:lang='${xmlLang}' xml:gender='${gender}' name='${voiceId}'><prosody rate='0.00%'>${text}</prosody></voice></speak>`;
  const body = new URLSearchParams();
  body.append("ssml", ssml);
  body.append("token", token.token);
  body.append("key", token.key);
  return fetch(TTS_URL, {
    method: "POST",
    body: body.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "*/*",
      Origin: "https://www.bing.com",
      Referer: "https://www.bing.com/translator",
      "User-Agent": EDGE_TTS_USER_AGENT,
      ...(token.cookie ? { Cookie: token.cookie } : {}),
    },
  });
}

export async function synthesizeEdgeTts(text: string, voice?: string): Promise<Buffer> {
  const voiceId = typeof voice === "string" && voice.trim() ? voice.trim() : DEFAULT_VOICE;
  let token = await getBingTtsToken();
  let res = await bingTtsRequest(text, voiceId, token);

  // 429/403: invalidate cache and retry once
  if (res.status === 429 || res.status === 403) {
    cache.token = null;
    cache.tokenTime = 0;
    token = await getBingTtsToken();
    res = await bingTtsRequest(text, voiceId, token);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EdgeTtsUpstreamError(
      res.status,
      `Bing TTS failed: ${res.status}${body ? ` - ${body.slice(0, 200)}` : ""}`
    );
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength < MIN_AUDIO_BYTES) {
    throw new EdgeTtsUpstreamError(502, "Bing TTS returned empty audio");
  }
  return Buffer.from(buf);
}
