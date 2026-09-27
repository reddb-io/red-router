import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Local device TTS — macOS `say` or Windows SAPI + ffmpeg.
 *
 * Ported from the legacy fork (open-sse/handlers/ttsProviders/localDevice.js @
 * c66f917c). Synthesis runs entirely on the operator's machine: macOS `say`
 * renders AIFF, or Windows PowerShell SAPI renders WAV, then ffmpeg transcodes
 * to MP3. No network access, no credentials.
 *
 * Shell safety: macOS values are execFile ARGV elements. Windows uses a fixed
 * PowerShell script and passes user values via child-process environment;
 * untrusted text/voice is never interpolated into the script (Hard Rule #13).
 */
export class LocalDeviceTtsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LocalDeviceTtsError";
    this.status = status;
  }
}

const WINDOWS_SAPI_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "try {",
  "if ($env:OMNIROUTE_TTS_VOICE) { $s.SelectVoice($env:OMNIROUTE_TTS_VOICE) }",
  "$s.SetOutputToWaveFile($env:OMNIROUTE_TTS_OUTPUT)",
  "$s.Speak($env:OMNIROUTE_TTS_TEXT)",
  "} finally { $s.Dispose() }",
].join("\n");

/** Keep user text and voice out of the fixed PowerShell source and argv. */
export function buildWindowsSapiInvocation(
  text: string,
  voiceId: string | null,
  outputPath: string
) {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      WINDOWS_SAPI_SCRIPT,
    ],
    options: {
      env: {
        ...process.env,
        OMNIROUTE_TTS_TEXT: text,
        OMNIROUTE_TTS_VOICE: voiceId ?? "",
        OMNIROUTE_TTS_OUTPUT: outputPath,
      },
      timeout: 60_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  };
}

async function synthesizeMacOrWindows(text: string, voiceId: string | null): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const sourcePath = join(dir, process.platform === "win32" ? "out.wav" : "out.aiff");
  const mp3Path = join(dir, "out.mp3");
  try {
    if (process.platform === "win32") {
      const invocation = buildWindowsSapiInvocation(text, voiceId, sourcePath);
      await execFileAsync(invocation.command, invocation.args, invocation.options);
    } else {
      const args = voiceId ? ["-v", voiceId, "-o", sourcePath, text] : ["-o", sourcePath, text];
      await execFileAsync("say", args, { timeout: 60_000, maxBuffer: 64 * 1024 });
    }
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", sourcePath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path],
      { timeout: 60_000, maxBuffer: 256 * 1024, windowsHide: true }
    );
    return await readFile(mp3Path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new LocalDeviceTtsError(
        500,
        process.platform === "win32"
          ? "Local device TTS requires Windows PowerShell and ffmpeg on PATH"
          : "Local device TTS requires macOS say and ffmpeg on PATH"
      );
    }
    throw new LocalDeviceTtsError(502, "Local device TTS failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function synthesizeLocalDeviceTts(text: string, voice?: string): Promise<Buffer> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new LocalDeviceTtsError(501, "Local device TTS requires macOS or Windows");
  }
  if (!text.trim() || text.length > 10_000) {
    throw new LocalDeviceTtsError(400, "Local device TTS input must contain 1 to 10000 characters");
  }
  const voiceId = typeof voice === "string" && voice.trim() ? voice.trim() : null;
  return synthesizeMacOrWindows(text, voiceId);
}
