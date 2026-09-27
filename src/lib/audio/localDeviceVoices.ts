import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LocalDeviceVoice = {
  id: string;
  name: string;
  locale: string;
  lang: string;
  gender: string;
  model: string;
  voice: string;
};

const WINDOWS_VOICES_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "try { $s.GetInstalledVoices() | ForEach-Object {",
  "$v = $_.VoiceInfo",
  "[PSCustomObject]@{ Name = $v.Name; Culture = $v.Culture.Name; Gender = [string]$v.Gender }",
  "} | ConvertTo-Json -Compress } finally { $s.Dispose() }",
].join("\n");

/** Parse macOS `say -v ?` output without interpreting it as a shell command. */
export function parseMacLocalDeviceVoices(stdout: string): LocalDeviceVoice[] {
  const voices: LocalDeviceVoice[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(.+?)\s{2,}([a-z]{2,3}_[A-Z]{2})(?:\s|$)/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    const locale = match[2].replace("_", "-");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    voices.push({
      id: name,
      name,
      locale,
      lang: locale.split("-")[0],
      gender: "",
      model: "local-device/default",
      voice: name,
    });
  }
  return voices;
}

/** Fixed local command; never pass request fields to execFile. */
export async function listMacLocalDeviceVoices(): Promise<LocalDeviceVoice[]> {
  const { stdout } = await execFileAsync("say", ["-v", "?"], {
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return parseMacLocalDeviceVoices(stdout);
}

/** Normalize Windows SAPI's single-object or array JSON output. */
export function parseWindowsLocalDeviceVoices(stdout: string): LocalDeviceVoice[] {
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const voices: LocalDeviceVoice[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 500)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const voice = row as Record<string, unknown>;
    const name = typeof voice.Name === "string" ? voice.Name.trim() : "";
    const locale = typeof voice.Culture === "string" ? voice.Culture.trim() : "";
    if (!name || !/^[a-z]{2,3}-[A-Z]{2}$/.test(locale) || seen.has(name)) continue;
    seen.add(name);
    voices.push({
      id: name,
      name,
      locale,
      lang: locale.split("-")[0],
      gender: typeof voice.Gender === "string" ? voice.Gender : "",
      model: "local-device/default",
      voice: name,
    });
  }
  return voices;
}

export async function listLocalDeviceVoices(): Promise<LocalDeviceVoice[]> {
  if (process.platform === "darwin") return listMacLocalDeviceVoices();
  if (process.platform !== "win32") throw new Error("Unsupported local voice platform");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_VOICES_SCRIPT],
    { timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true }
  );
  return parseWindowsLocalDeviceVoices(stdout);
}
