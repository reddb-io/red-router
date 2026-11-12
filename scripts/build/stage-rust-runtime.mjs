import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const platform = args.get("--platform") || process.platform;
const arch = args.get("--arch") || process.arch;
const executable = platform === "win32" ? "red-routerd.exe" : "red-routerd";
const binary = resolve(
  args.get("--binary") || join(root, "rust", "red-routerd", "target", "release", executable)
);
const dashboard = resolve(args.get("--dashboard") || join(root, ".build", "rust-dashboard"));
const destination = join(root, "rust-runtime");

if (!existsSync(binary)) throw new Error(`Rust server binary not found: ${binary}`);
if (!existsSync(join(dashboard, "index.html"))) {
  throw new Error(`Rust dashboard build not found: ${dashboard}`);
}
if (basename(binary).toLowerCase() !== executable) {
  throw new Error(`Expected ${executable}, received ${basename(binary)}`);
}

rmSync(join(destination, "dashboard"), { recursive: true, force: true });
mkdirSync(join(destination, `${platform}-${arch}`), { recursive: true });
cpSync(dashboard, join(destination, "dashboard"), { recursive: true });
cpSync(binary, join(destination, `${platform}-${arch}`, executable));
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
writeFileSync(join(destination, "BUILD_SHA"), `${sourceSha}\n`);

console.log(`Staged Rust runtime for ${platform}-${arch} from ${sourceSha.slice(0, 12)}`);
