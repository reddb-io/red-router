/**
 * Read-only upstream inventory. Run from this repository with:
 * node scripts/ad-hoc/upstream-parity-inventory.mjs
 *
 * This is a structural candidate list, not proof of protocol or runtime parity.
 * It reads remote-tracking refs already fetched locally and never changes files.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { compatibilityAliasMap, providerId } from "./providerInventoryParse.mjs";

const repo = process.cwd();
const upstreams = [
  { name: "9router", ref: "upstream/master", providerDir: "open-sse/providers/registry" },
  {
    name: "OmniRoute",
    ref: "omni-upstream/release/v3.8.51",
    providerDir: "open-sse/config/providers/registry",
  },
];
const localProviderDir = "open-sse/config/providers/registry";

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function pathsAtRef(ref, dir) {
  return git("ls-tree", "-r", "--name-only", ref, "--", dir).split("\n").filter(Boolean);
}

function walk(dir) {
  const result = [];
  for (const entry of readdirSync(path.join(repo, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

function providerMap(files, read) {
  const map = new Map();
  for (const file of files) {
    if (!/\.(?:js|ts)$/.test(file)) continue;
    const id = providerId(read(file), file);
    if (id && !map.has(id)) map.set(id, file);
  }
  return map;
}

function providerAliasMap(files, read) {
  const aliases = new Map();
  for (const file of files) {
    const source = read(file);
    const id = providerId(source, file);
    const alias = source.match(/\balias:\s*["']([^"']+)["']/)?.[1];
    if (id && alias && alias !== id && !aliases.has(alias)) {
      aliases.set(alias, { id, file });
    }
  }
  return aliases;
}

function routeMap(files) {
  const map = new Map();
  for (const file of files) {
    const match = file.match(/^src\/app\/api\/v1\/(.*)\/route\.(?:js|ts)$/);
    if (match) map.set(`/v1/${match[1]}`, file);
  }
  return map;
}

function missing(source, target) {
  return [...source.entries()]
    .filter(([id]) => !target.has(id))
    .map(([id, file]) => ({ id, file }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const localProviderFiles = walk(localProviderDir).filter((file) => file.endsWith("/index.ts"));
const readLocal = (file) => readFileSync(path.join(repo, file), "utf8");
const specialtyIndexFiles = new Set([
  // Image provider entry imported by imageRegistry, not a chat RegistryEntry.
  "open-sse/config/providers/registry/magnific/index.ts",
]);
const unparsedLocalFiles = localProviderFiles.filter(
  (file) => !providerId(readLocal(file), file) && !specialtyIndexFiles.has(file)
);
if (unparsedLocalFiles.length) {
  throw new Error(`Unparsed local provider entries: ${unparsedLocalFiles.join(", ")}`);
}
const localProviders = providerMap(localProviderFiles, readLocal);
const localAliases = providerAliasMap(localProviderFiles, readLocal);
const compatibilityAliasFile = "src/shared/constants/providerCompatibilityAliases.ts";
const compatibilityAliases = compatibilityAliasMap(
  readLocal(compatibilityAliasFile),
  compatibilityAliasFile,
  localProviders
);
const specialtyRegistryFiles = [
  "open-sse/config/audioRegistry.ts",
  "open-sse/config/embeddingRegistry.ts",
  "open-sse/config/imageRegistry.ts",
  "open-sse/config/moderationRegistry.ts",
  "open-sse/config/musicRegistry.ts",
  "open-sse/config/rerankRegistry.ts",
  "open-sse/config/searchRegistry.ts",
  "open-sse/config/upscaleRegistry.ts",
  "open-sse/config/videoRegistry.ts",
];
const specialtySources = specialtyRegistryFiles.map((file) => ({ file, source: readLocal(file) }));
function specialtyMentions(id) {
  const literal = JSON.stringify(id);
  return specialtySources.filter(({ source }) => source.includes(literal)).map(({ file }) => file);
}
const localRoutes = routeMap(walk("src/app/api/v1"));
const results = upstreams.map(({ name, ref, providerDir }) => {
  const providerFiles = pathsAtRef(ref, providerDir).filter((file) =>
    name === "OmniRoute" ? file.endsWith("/index.ts") : file.endsWith(".js")
  );
  const providers = providerMap(providerFiles, (file) => git("show", `${ref}:${file}`));
  const routes = routeMap(pathsAtRef(ref, "src/app/api/v1"));
  const missingProviderFileIds = missing(providers, localProviders).map((candidate) => ({
    ...candidate,
    ...(localAliases.has(candidate.id) ? { localAlias: localAliases.get(candidate.id) } : {}),
    ...(compatibilityAliases.has(candidate.id)
      ? { compatibilityAlias: compatibilityAliases.get(candidate.id) }
      : {}),
    specialtyRegistryMentions: specialtyMentions(candidate.id),
  }));
  return {
    name,
    ref,
    sha: git("rev-parse", ref).trim(),
    providerFileIds: providers.size,
    localProviderFileIds: localProviders.size,
    // Specialty providers may live in another registry. These are review
    // candidates, not evidence that the provider or modality is absent.
    missingProviderFileIds,
    upstreamV1RouteFiles: routes.size,
    localV1RouteFiles: localRoutes.size,
    missingV1RouteFiles: missing(routes, localRoutes),
  };
});

process.stdout.write(
  `${JSON.stringify({ note: "Structural only; audit auth, models and transport per candidate.", results }, null, 2)}\n`
);
