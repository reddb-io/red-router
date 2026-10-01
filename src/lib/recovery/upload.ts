import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class BackupUploadError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function readBackupUpload(request: Request, maximum: number) {
  const multipart = request.headers.get("content-type")?.includes("multipart/form-data");
  const requestLimit = maximum + (multipart ? 64 * 1024 : 0);
  const declared = Number(request.headers.get("content-length"));
  if (declared > requestLimit)
    throw new BackupUploadError("Backup upload exceeds the size limit", 413);
  if (!request.body) throw new BackupUploadError("No file content provided", 400);
  let bytes = 0;
  let exceeded = false;
  const limited = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > requestLimit) {
          exceeded = true;
          throw new BackupUploadError("Backup upload exceeds the size limit", 413);
        }
        controller.enqueue(chunk);
      },
    })
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "redrouter-import-"));
  await fs.chmod(directory, 0o700);
  const filePath = path.join(directory, "upload.sqlite");
  let filename = new URL(request.url).searchParams.get("filename") || "import.sqlite";
  try {
    if (multipart) {
      const form = await new Response(limited, { headers: request.headers }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new BackupUploadError("Upload a .sqlite file", 400);
      filename = file.name;
      if (file.size > maximum)
        throw new BackupUploadError("Backup upload exceeds the size limit", 413);
      await fs.writeFile(filePath, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });
    } else {
      const reader = limited.getReader();
      const handle = await fs.open(filePath, "wx", 0o600);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await handle.writeFile(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        await handle.close();
      }
    }
    const size = (await fs.stat(filePath)).size;
    if (!filename.endsWith(".sqlite"))
      throw new BackupUploadError("Only .sqlite files are accepted", 400);
    if (size < 4096) throw new BackupUploadError("File is too small to be a SQLite database", 400);
    return { filePath, filename, directory };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    if (exceeded) throw new BackupUploadError("Backup upload exceeds the size limit", 413);
    throw error;
  }
}
