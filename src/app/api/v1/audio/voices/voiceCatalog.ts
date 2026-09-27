import { getProviderAlias } from "@/shared/constants/providers";

export type VoiceProvider = "elevenlabs" | "deepgram" | "inworld" | "edge-tts";

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
          : "default";
  return `${prefix}/${engine}`;
}

export function normalizeVoices(provider: VoiceProvider, payload: unknown): VoiceEntry[] {
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
