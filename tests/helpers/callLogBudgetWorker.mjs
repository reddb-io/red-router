import { parentPort } from "node:worker_threads";

parentPort.on("message", ({ id, artifact }) => {
  if (artifact.summary.id === "crash") process.exit(1);
  parentPort.postMessage({
    id,
    result: { relPath: artifact.summary.id, sizeBytes: 1, sha256: "fixture" },
  });
});
