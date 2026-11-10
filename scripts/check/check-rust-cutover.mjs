#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROUTE_FILE = /^route\.(?:[cm]?[jt]sx?)$/;
const DISPOSITIONS = new Set([
  "cutover-server",
  "local-companion",
  "post-cutover-companion",
  "retire",
]);
const GATE_STATES = new Set(["ready", "partial", "pending"]);

function normalized(path) {
  return path.replaceAll("\\", "/");
}

function walkRouteFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkRouteFiles(path, output);
    else if (entry.isFile() && ROUTE_FILE.test(entry.name)) output.push(path);
  }
  return output;
}

export function inventoryNextRoutes(root = ROOT) {
  const apiRoot = join(root, "src/app/api");
  return walkRouteFiles(apiRoot)
    .map((path) => normalized(relative(apiRoot, path)))
    .sort();
}

export function inventoryRustRoutes(root = ROOT) {
  const source = readFileSync(join(root, "rust/red-routerd/src/lib.rs"), "utf8");
  return new Set([...source.matchAll(/\.route\(\s*"([^"]+)"/g)].map((match) => match[1]));
}

export function loadCutoverManifest(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "config/migration/rust-backend-cutover.json"), "utf8"));
}

function routeFamilies(routes) {
  const families = new Map();
  for (const route of routes) {
    const family = route.split("/", 1)[0];
    families.set(family, (families.get(family) || 0) + 1);
  }
  return families;
}

export function validateCutoverManifest(
  manifest,
  { nextRoutes, rustRoutes, requireReady = false }
) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be an object"];
  }
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const target = manifest.target;
  if (
    !target ||
    target.server !== "red-routerd" ||
    target.frontend !== "static-spa" ||
    target.defaultStorage !== "sqlite" ||
    target.nodeRequiredAtRuntime !== false ||
    target.typescriptDurableWritesAllowed !== false
  ) {
    errors.push("target must pin the Node-free red-routerd + static SPA + SQLite boundary");
  }

  const actualFamilies = routeFamilies(nextRoutes);
  const inventory = manifest.nextRouteInventory;
  const expectedFamilies = inventory?.families;
  if (!inventory || !expectedFamilies || typeof expectedFamilies !== "object") {
    errors.push("nextRouteInventory.families must be an object");
  } else {
    if (inventory.expectedTotal !== nextRoutes.length) {
      errors.push(
        `Next route total changed: manifest=${inventory.expectedTotal}, actual=${nextRoutes.length}`
      );
    }
    for (const [family, count] of actualFamilies) {
      const record = expectedFamilies[family];
      if (!record) {
        errors.push(`unclassified Next route family: ${family} (${count} route(s))`);
        continue;
      }
      if (record.routeCount !== count) {
        errors.push(
          `Next route family ${family} changed: manifest=${record.routeCount}, actual=${count}`
        );
      }
      if (!DISPOSITIONS.has(record.disposition)) {
        errors.push(`Next route family ${family} has invalid disposition: ${record.disposition}`);
      }
    }
    for (const family of Object.keys(expectedFamilies)) {
      if (!actualFamilies.has(family))
        errors.push(`stale Next route family in manifest: ${family}`);
    }
  }

  const gates = manifest.cutoverGates;
  if (!Array.isArray(gates) || gates.length !== 5) {
    errors.push("cutoverGates must contain the five production cutover gates");
  } else {
    const seen = new Set();
    for (const gate of gates) {
      const id = typeof gate?.id === "string" ? gate.id : "<missing>";
      if (seen.has(id)) errors.push(`duplicate cutover gate: ${id}`);
      seen.add(id);
      if (!GATE_STATES.has(gate?.state)) errors.push(`cutover gate ${id} has invalid state`);
      if (!Array.isArray(gate?.blockers))
        errors.push(`cutover gate ${id} blockers must be an array`);
      if (!Array.isArray(gate?.requiredRustRoutes)) {
        errors.push(`cutover gate ${id} requiredRustRoutes must be an array`);
      } else {
        for (const route of gate.requiredRustRoutes) {
          if (typeof route !== "string" || !route.startsWith("/")) {
            errors.push(`cutover gate ${id} has an invalid Rust route reference`);
          } else if (!rustRoutes.has(route)) {
            errors.push(`cutover gate ${id} references missing Rust route: ${route}`);
          }
        }
      }
      if (gate?.state === "ready" && gate.blockers?.length) {
        errors.push(`ready cutover gate ${id} must not retain blockers`);
      }
      if (gate?.state !== "ready" && !gate.blockers?.length) {
        errors.push(`unfinished cutover gate ${id} must describe at least one blocker`);
      }
      if (requireReady && gate?.state !== "ready") {
        errors.push(`cutover gate is not ready: ${id} (${gate?.state || "missing"})`);
      }
    }
  }
  return errors;
}

function main() {
  const manifest = loadCutoverManifest();
  const nextRoutes = inventoryNextRoutes();
  const rustRoutes = inventoryRustRoutes();
  const requireReady = process.argv.includes("--require-ready");
  const errors = validateCutoverManifest(manifest, { nextRoutes, rustRoutes, requireReady });
  if (errors.length) {
    console.error(`[rust-cutover] FAIL — ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  const states = Object.fromEntries(
    ["ready", "partial", "pending"].map((state) => [
      state,
      manifest.cutoverGates.filter((gate) => gate.state === state).length,
    ])
  );
  console.log(
    `[rust-cutover] OK — ${nextRoutes.length} Next routes classified; ` +
      `${rustRoutes.size} Rust routes inventoried; gates ready=${states.ready}, ` +
      `partial=${states.partial}, pending=${states.pending}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
