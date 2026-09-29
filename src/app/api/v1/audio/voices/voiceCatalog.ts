import { getProviderAlias } from "@/shared/constants/providers";

export type VoiceProvider =
  "elevenlabs" | "deepgram" | "inworld" | "edge-tts" | "minimax" | "minimax-cn";

export type VoiceEntry = {
  id: string;
  name: string;
  lang: string;
  gender: string;
  model: string;
  voice: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function voiceModel(provider: VoiceProvider, id: string): string {
  const prefix = getProviderAlias(provider);
  // Deepgram's model is the voice. The other speech handlers take a separate
  // voice field and require an engine model, so do not advertise an unusable ID.
  const engine =
    provider === "deepgram"
      ? id
      : provider === "inworld"
        ? "inworld-tts-2"
        : provider === "elevenlabs"
          ? "eleven_multilingual_v2"
          : provider === "minimax" || provider === "minimax-cn"
            ? "speech-2.8-hd"
            : "default";
  return `${prefix}/${engine}`;
}

// MiniMax get_voice groups voices by origin. Ported from 9router's
// media-providers/tts/minimax/voices route (normalizeMiniMaxVoices).
const MINIMAX_VOICE_GROUPS = [
  { key: "system_voice", label: "System" },
  { key: "voice_cloning", label: "Cloned" },
  { key: "voice_generation", label: "Generated" },
  { key: "music_generation", label: "Music" },
] as const;

export const MINIMAX_VOICE_TYPES = [
  "all",
  "system",
  "voice_cloning",
  "voice_generation",
  "music_generation",
] as const;

const MINIMAX_LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  "chinese (mandarin)": "zh",
  cantonese: "yue",
  japanese: "ja",
  korean: "ko",
  spanish: "es",
  portuguese: "pt",
  french: "fr",
  german: "de",
  italian: "it",
  russian: "ru",
  arabic: "ar",
  turkish: "tr",
  dutch: "nl",
  ukrainian: "uk",
  vietnamese: "vi",
  indonesian: "id",
  thai: "th",
  polish: "pl",
  romanian: "ro",
  greek: "el",
  czech: "cs",
  finnish: "fi",
  hindi: "hi",
};

function inferMiniMaxLanguage(voiceId: string): string {
  const value = voiceId.trim();
  if (!value.includes("_")) return "custom";
  const name = value.split("_")[0] || "";
  if (!name) return "custom";
  return MINIMAX_LANGUAGE_CODES[name.toLowerCase()] ?? name;
}

function inferMiniMaxGender(voiceId: string): string {
  const tokens = voiceId.toLowerCase().split(/[^a-z]+/);
  if (tokens.includes("female")) return "female";
  if (tokens.includes("male")) return "male";
  return "";
}

/** Throws on a non-zero MiniMax base_resp; the message never carries upstream text. */
function normalizeMiniMaxVoices(provider: VoiceProvider, payload: unknown): VoiceEntry[] {
  const source = record(payload);
  if (!source) throw new Error("Invalid voice catalog response");
  const base = record(source.base_resp) ?? record(source.baseResp);
  const status = Number(base?.status_code ?? base?.statusCode ?? 0);
  if (status !== 0) throw new Error("MiniMax voice catalog rejected the request");

  const voices: VoiceEntry[] = [];
  const seen = new Set<string>();
  for (const group of MINIMAX_VOICE_GROUPS) {
    const list = Array.isArray(source[group.key]) ? (source[group.key] as unknown[]) : [];
    for (const item of list) {
      const voice = record(item);
      if (!voice) continue;
      const id = string(voice.voice_id ?? voice.voiceId);
      if (!id) continue;
      const baseName = string(voice.voice_name ?? voice.voiceName) || id;
      const isSystem = group.key === "system_voice";
      const lang = isSystem ? inferMiniMaxLanguage(id) : "custom";
      const key = `${id}\0${lang}`;
      if (seen.has(key)) continue;
      seen.add(key);
      voices.push({
        id,
        name: isSystem ? baseName : `${baseName} · ${group.label}`,
        lang,
        gender: inferMiniMaxGender(id),
        model: voiceModel(provider, id),
        voice: id,
      });
    }
  }
  return voices.sort((a, b) => {
    if (a.lang !== b.lang) {
      if (a.lang === "custom") return 1;
      if (b.lang === "custom") return -1;
      return a.lang.localeCompare(b.lang);
    }
    return a.name.localeCompare(b.name);
  });
}

export function normalizeVoices(provider: VoiceProvider, payload: unknown): VoiceEntry[] {
  if (provider === "minimax" || provider === "minimax-cn") {
    return normalizeMiniMaxVoices(provider, payload);
  }
  const source = record(payload);
  const list = provider === "edge-tts" ? payload : (source?.voices ?? source?.tts);
  if (!Array.isArray(list)) throw new Error("Invalid voice catalog response");

  const voices: VoiceEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const voice = record(item);
    if (!voice) continue;
    const id = string(
      provider === "elevenlabs"
        ? voice.voice_id
        : provider === "deepgram"
          ? (voice.canonical_name ?? voice.name)
          : provider === "inworld"
            ? voice.voiceId
            : voice.ShortName
    );
    if (!id) continue;
    const labels = record(voice.labels);
    const metadata = record(voice.metadata);
    const tags = Array.isArray(metadata?.tags) ? metadata.tags : [];
    const languages = Array.isArray(voice.languages)
      ? voice.languages.filter((value): value is string => typeof value === "string")
      : [];
    const fallbackLang = provider === "deepgram" ? (id.split("-").at(-1) ?? "en") : "en";
    const fallbackLanguage =
      provider === "edge-tts"
        ? string(voice.Locale).split("-")[0]
        : provider === "elevenlabs"
          ? string(labels?.language).split("-")[0] || "en"
          : fallbackLang;
    const voiceLanguages = languages.length > 0 ? languages : [fallbackLanguage];
    const gender =
      provider === "edge-tts"
        ? string(voice.Gender)
        : provider === "elevenlabs"
          ? string(labels?.gender)
          : provider === "deepgram"
            ? string(tags.find((tag) => tag === "masculine" || tag === "feminine"))
            : string(voice.gender);
    const name = string(
      provider === "edge-tts"
        ? (voice.FriendlyName ?? voice.ShortName)
        : provider === "inworld"
          ? (voice.displayName ?? voice.voiceId)
          : (voice.name ?? id)
    );
    for (const language of voiceLanguages) {
      const lang = language.split("-")[0];
      if (!lang) continue;
      const key = `${id}\0${lang}`;
      if (seen.has(key)) continue;
      seen.add(key);
      voices.push({ id, name, lang, gender, model: voiceModel(provider, id), voice: id });
    }
  }
  return voices;
}
