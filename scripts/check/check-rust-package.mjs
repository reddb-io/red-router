import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const platform = process.platform;
const arch = process.arch;
const executable = platform === "win32" ? "red-routerd.exe" : "red-routerd";
const required = [
  join(root, "rust-runtime", `${platform}-${arch}`, executable),
  join(root, "rust-runtime", "dashboard", "index.html"),
  join(root, "rust-runtime", "BUILD_SHA"),
];

for (const file of required) {
  if (!existsSync(file)) throw new Error(`Missing Rust release artifact: ${file}`);
}

const builtSha = readFileSync(required[2], "utf8").trim();
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (builtSha !== sourceSha) throw new Error("Rust release artifact was built from another commit");

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.dependencies?.next) throw new Error("Next.js must not be a production dependency");
if (manifest.files?.includes("dist/")) throw new Error("Legacy Next.js dist must not be published");
if (manifest.scripts?.build !== "npm run build:rust") {
  throw new Error("The default build must target Rust and the SPA");
}

console.log(`Validated Rust package for ${platform}-${arch} at ${sourceSha.slice(0, 12)}`);
