import { open, type FileHandle } from "node:fs/promises";

import {
  parseConsoleLogLine,
  type ConsoleLogEntry,
  type ConsoleLogFilter,
} from "@/lib/consoleLogEntries";

const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024;
const ONE_HOUR_MS = 60 * 60 * 1000;

export type ConsoleLogTailUpdate =
  { type: "snapshot"; logs: ConsoleLogEntry[] } | { type: "append"; logs: ConsoleLogEntry[] };

function splitCompleteLines(bytes: Buffer): { lines: string[]; partial: Buffer } {
  const end = bytes.lastIndexOf(10);
  if (end < 0) {
    return {
      lines: [],
      partial: bytes.length <= MAX_PARTIAL_LINE_BYTES ? bytes : Buffer.alloc(0),
    };
  }
  const complete = bytes.subarray(0, end + 1).toString("utf8");
  const partial = bytes.subarray(end + 1);
  return {
    lines: complete.split("\n").filter(Boolean),
    partial: partial.length <= MAX_PARTIAL_LINE_BYTES ? partial : Buffer.alloc(0),
  };
}

/** A per-client cursor over the structured Pino file, including rotation and truncation. */
export class ConsoleLogTail {
  private identity: string | null = null;
  private offset = 0;
  private partial: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private initialized = false;

  constructor(
    private readonly filePath: string,
    private readonly filter: Omit<ConsoleLogFilter, "since"> = {},
    private readonly limit = 500
  ) {}

  private parse(lines: readonly string[], now: number): ConsoleLogEntry[] {
    const filter = { ...this.filter, since: now - ONE_HOUR_MS };
    const entries: ConsoleLogEntry[] = [];
    for (const line of lines) {
      const entry = parseConsoleLogLine(line, filter);
      if (entry) entries.push(entry);
      if (entries.length > this.limit * 2) entries.splice(0, this.limit);
    }
    return entries.slice(-this.limit);
  }

  private async snapshot(
    handle: FileHandle,
    identity: string,
    size: number,
    now: number
  ): Promise<ConsoleLogTailUpdate> {
    // Bound the per-client snapshot even when the application log has grown very large.
    // Read through the same descriptor used for stat so rotation cannot mix two files.
    const start = Math.max(0, size - MAX_SNAPSHOT_BYTES);
    const bytes = Buffer.allocUnsafe(size - start);
    let received = 0;
    while (received < bytes.length) {
      const result = await handle.read(bytes, received, bytes.length - received, start + received);
      if (result.bytesRead === 0) break;
      received += result.bytesRead;
    }
    const slice = bytes.subarray(0, received);
    const firstNewline = start > 0 ? slice.indexOf(10) : -1;
    const completeStart = start > 0 ? (firstNewline < 0 ? slice.length : firstNewline + 1) : 0;
    const { lines, partial } = splitCompleteLines(slice.subarray(completeStart));
    this.identity = identity;
    this.offset = size;
    this.partial = partial;
    this.initialized = true;
    return { type: "snapshot", logs: this.parse(lines, now) };
  }

  async poll(now = Date.now()): Promise<ConsoleLogTailUpdate | null> {
    let handle: FileHandle;
    try {
      handle = await open(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const changed = !this.initialized || this.identity !== null;
      this.identity = null;
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      this.initialized = true;
      return changed ? { type: "snapshot", logs: [] } : null;
    }

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("Console log path is not a file");
      const identity = `${stats.dev}:${stats.ino}`;
      if (
        !this.initialized ||
        identity !== this.identity ||
        stats.size < this.offset ||
        stats.size - this.offset > MAX_DELTA_BYTES
      ) {
        return await this.snapshot(handle, identity, stats.size, now);
      }
      if (stats.size === this.offset) return null;

      const expected = stats.size - this.offset;
      const bytes = Buffer.allocUnsafe(expected);
      let received = 0;
      while (received < expected) {
        const { bytesRead } = await handle.read(
          bytes,
          received,
          expected - received,
          this.offset + received
        );
        if (bytesRead === 0) break;
        received += bytesRead;
      }
      if (received === 0) return null;

      this.offset += received;
      const { lines, partial } = splitCompleteLines(
        Buffer.concat([this.partial, bytes.subarray(0, received)])
      );
      this.partial = partial;
      const logs = this.parse(lines, now);
      return logs.length ? { type: "append", logs } : null;
    } finally {
      await handle.close();
    }
  }
}
