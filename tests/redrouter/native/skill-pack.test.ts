import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const skillsDir = "skills";
const apiDir = join("src", "app", "api");
const RAW_BASE = "https://raw.githubusercontent.com/reddb-io/red-router/main/skills";

// The RedRouter-owned skill pack for coding agents: an index skill plus one skill per capability.
const CAPABILITIES = [
  "chat",
  "image",
  "tts",
  "stt",
  "embeddings",
  "video",
  "web-search",
  "web-fetch",
] as const;
const PACK_IDS = ["red-router", ...CAPABILITIES.map((name) => `red-router-${name}`)];

// Names of the upstream projects this pack was adapted from: only an explicit attribution line
// may carry them.
const FORBIDDEN = /9router|decolua|omniroute/i;
const ATTRIBUTION_LINE = /^\s*(?:>\s*)?upstream attribution\b/i;

function skillDirs(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function frontMatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  assert.ok(match, "missing front matter");
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

function routeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...routeFiles(path));
    else if (entry.name === "route.ts") files.push(path);
  }
  return files;
}

const routes = routeFiles(apiDir).map((file) =>
  relative("src/app", file).split(/[\\/]/).slice(0, -1)
);

/** Whether a documented path (`/v1/...`, `/api/...`) is served by a Next.js route.ts. */
function routeExists(endpoint: string): boolean {
  const wanted = (endpoint.startsWith("/api/") ? endpoint : `/api${endpoint}`)
    .split("/")
    .filter(Boolean);
  return routes.some((segments) => {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.startsWith("[...") || segment.startsWith("[[...")) {
        // A catch-all at the top of /api/v1 answers every path, so it proves nothing.
        return index >= 3 && wanted.length > index;
      }
      if (index >= wanted.length) return false;
      if (segment.startsWith("[") && segment.endsWith("]")) continue;
      if (segment !== wanted[index]) return false;
    }
    return segments.length === wanted.length;
  });
}

function endpointsIn(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/(?:\/api)?\/v1(?:\/[A-Za-z0-9_{}<>$\-]+)*/g)) {
    found.add(match[0]);
  }
  for (const match of content.matchAll(/\/api\/health\b/g)) found.add(match[0]);
  return [...found];
}

test("every skill directory has a SKILL.md with name and description front matter", () => {
  for (const dir of skillDirs()) {
    const file = join(skillsDir, dir, "SKILL.md");
    assert.ok(existsSync(file), `${dir}: missing SKILL.md`);
    const fields = frontMatter(read(file));
    assert.ok(fields.name, `${dir}: front matter has no name`);
    assert.ok(fields.description, `${dir}: front matter has no description`);
  }
});

test("the pack ships the index and all eight capability skills", () => {
  assert.equal(PACK_IDS.length, 9);
  for (const id of PACK_IDS) {
    const file = join(skillsDir, id, "SKILL.md");
    assert.ok(existsSync(file), `${id}: missing`);
    const fields = frontMatter(read(file));
    assert.equal(fields.name, id, `${id}: front matter name must match the directory`);
    assert.ok(fields.description.length >= 50, `${id}: description is too short`);
  }
});

test("pack files carry no upstream product name outside an explicit attribution line", () => {
  for (const id of PACK_IDS) {
    const lines = read(join(skillsDir, id, "SKILL.md")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line) && !ATTRIBUTION_LINE.test(line)) {
        assert.fail(`${id}/SKILL.md:${index + 1} mentions an upstream product: ${line.trim()}`);
      }
    });
  }
});

test("pack skills use RedRouter environment variables, install name and raw URLs", () => {
  const index = read(join(skillsDir, "red-router", "SKILL.md"));
  assert.match(index, /npm install -g @reddb-io\/red-router/);
  assert.match(index, /RED_ROUTER_BASE_URL/);
  assert.match(index, /RED_ROUTER_API_KEY/);
  for (const capability of CAPABILITIES) {
    assert.ok(
      index.includes(`${RAW_BASE}/red-router-${capability}/SKILL.md`),
      `index does not link red-router-${capability}`
    );
  }
  for (const id of PACK_IDS) {
    const content = read(join(skillsDir, id, "SKILL.md"));
    for (const url of content.match(/https?:\/\/[^\s)`"']+/g) ?? []) {
      if (!url.includes("raw.githubusercontent.com")) continue;
      const linked =
        /^https:\/\/raw\.githubusercontent\.com\/reddb-io\/red-router\/main\/skills\/([\w-]+)\/SKILL\.md$/.exec(
          url
        );
      assert.ok(linked, `${id}: raw URL outside the RedRouter repository: ${url}`);
      assert.ok(existsSync(join(skillsDir, linked[1], "SKILL.md")), `${id}: dangling link ${url}`);
    }
    if (id !== "red-router") {
      assert.match(content, /RED_ROUTER_BASE_URL/, `${id}: does not use RED_ROUTER_BASE_URL`);
    }
  }
});

test("every endpoint a pack skill mentions is a route under src/app/api", () => {
  let checked = 0;
  for (const id of PACK_IDS) {
    const endpoints = endpointsIn(read(join(skillsDir, id, "SKILL.md")));
    if (id !== "red-router") assert.ok(endpoints.length > 0, `${id}: mentions no endpoint`);
    for (const endpoint of endpoints) {
      checked += 1;
      assert.ok(routeExists(endpoint), `${id}: ${endpoint} has no route under ${apiDir}`);
    }
  }
  assert.ok(checked >= 20, `expected many documented endpoints, checked ${checked}`);
});

test("the route matcher rejects paths that do not exist", () => {
  assert.equal(routeExists("/v1/audio/speech"), true);
  assert.equal(routeExists("/v1/videos/some-id"), true);
  assert.equal(routeExists("/v1/models/info"), true);
  assert.equal(routeExists("/v1/not-a-real-endpoint"), false);
  assert.equal(routeExists("/v1/audio/transcribe-everything"), false);
});

test("the agent skills registry points every URL at reddb-io/red-router and lists the pack", async () => {
  const constants = await import("../../../src/shared/constants/agentSkills.ts");
  const source = read("src/shared/constants/agentSkills.ts");

  for (const url of source.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
    assert.match(
      url,
      /^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/(?:\$\{REPO\}|reddb-io\/red-router)/,
      url
    );
  }
  assert.doesNotMatch(source, /diegosouzapw|decolua|9router\.com/i);
  assert.equal(
    constants.getAgentSkillRawUrl("red-router"),
    "https://raw.githubusercontent.com/reddb-io/red-router/main/skills/red-router/SKILL.md"
  );
  assert.equal(
    constants.getAgentSkillBlobUrl("red-router-chat"),
    "https://github.com/reddb-io/red-router/blob/main/skills/red-router-chat/SKILL.md"
  );

  const listed = new Map<string, { isEntry?: boolean }>(
    constants.CURATED_SKILLS.map((skill: { id: string; isEntry?: boolean }) => [skill.id, skill])
  );
  for (const id of PACK_IDS) assert.ok(listed.has(id), `${id} is not in CURATED_SKILLS`);
  assert.equal(listed.get("red-router")?.isEntry, true);
  for (const id of listed.keys()) {
    assert.ok(existsSync(join(skillsDir, id, "SKILL.md")), `${id} is listed but has no SKILL.md`);
  }
});

test("the dashboard skill preview builds its links from the registry, not literals", () => {
  const preview = read(
    "src/app/(dashboard)/dashboard/agent-skills/components/SkillPreviewPane.tsx"
  );
  assert.doesNotMatch(preview, /raw\.githubusercontent\.com|github\.com\//);
  assert.match(preview, /getAgentSkillRawUrl/);
});
