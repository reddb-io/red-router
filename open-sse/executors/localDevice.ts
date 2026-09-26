import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Local device TTS — macOS `say` + ffmpeg.
 *
 * Ported from the legacy fork (open-sse/handlers/ttsProviders/localDevice.js @
 * c66f917c). Synthesis runs entirely on the operator's machine: `say` renders
 * an AIFF from the text (optionally with a named voice), then ffmpeg
 * transcodes it to MP3. No network access, no credentials.
 *
 * Shell safety: values are passed as execFile ARGV elements, never
 * interpolated into a shell string (Hard Rule #13).
 */
export class LocalDeviceTtsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LocalDeviceTtsError";
    this.status = status;
  }
}

async function synthesizeMacOrWin(text: string, voiceId: string | null): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const aiffPath = join(dir, "out.aiff");
  const mp3Path = join(dir, "out.mp3");
  try {
    const args = voiceId ? ["-v", voiceId, "-o", aiffPath, text] : ["-o", aiffPath, text];
    await execFileAsync("say", args);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      aiffPath,
      "-codec:a",
      "libmp3lame",
      "-qscale:a",
      "4",
      mp3Path,
    ]);
    return await readFile(mp3Path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      throw new LocalDeviceTtsError(
        500,
        "Local device TTS requires the `say` (macOS) and `ffmpeg` binaries on PATH"
      );
    }
    throw new LocalDeviceTtsError(502, `Local device TTS failed: ${message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function synthesizeLocalDeviceTts(text: string, voice?: string): Promise<Buffer> {
  const voiceId = typeof voice === "string" && voice.trim() ? voice.trim() : null;
  return synthesizeMacOrWin(text, voiceId);
}
