import { printHeading, printInfo, printSuccess, printError } from "../io.mjs";
import path from "node:path";
import fs from "node:fs";
import { registerContexts } from "./contexts.mjs";
import { guardHostConfigTarget } from "../utils/config-home-guard.mjs";

function ensureBackup(configPath) {
  if (!fs.existsSync(configPath)) return;
  const backupDir = path.join(path.dirname(configPath), ".omniroute.bak");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(configPath) + ".bak");
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function mergeClaudeSettings(existingContent, generatedContent) {
  const generated = JSON.parse(generatedContent);
  let current = {};
  if (existingContent && existingContent.trim()) {
    current = JSON.parse(existingContent);
    if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
  }
  return JSON.stringify(
    {
      ...current,
      ...generated,
      env: {
        ...(current.env && typeof current.env === "object" && !Array.isArray(current.env)
          ? current.env
          : {}),
        ...(generated.env || {}),
      },
    },
    null,
    2
  );
}

async function runConfigListCommand(opts = {}) {
  const { detectAllTools } = await import("../../../src/lib/cli-helper/tool-detector.ts");
  const tools = await detectAllTools();

  if (opts.json) {
    console.log(JSON.stringify(tools, null, 2));
  } else {
    printHeading("CLI Tool Configuration Status");
    for (const t of tools) {
      const status = t.configured
        ? "✓ Configured"
        : t.installed
          ? "✗ Not configured"
          : "✗ Not installed";
      console.log(`  ${t.name.padEnd(14)} ${status}`);
      if (t.version) console.log(`    version: ${t.version}`);
      console.log(`    config:  ${t.configPath}`);
    }
  }
  return 0;
}

async function runConfigGetCommand(toolId, opts = {}) {
  if (!toolId) {
    printError("Tool ID required. Usage: red-router config get <tool>");
    return 1;
  }
  const { detectTool } = await import("../../../src/lib/cli-helper/tool-detector.ts");
  const tool = await detectTool(toolId);
  if (!tool) {
    printError(`Unknown tool: ${toolId}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(tool, null, 2));
  } else {
    printHeading(`${tool.name} Configuration`);
    console.log(`  Installed:  ${tool.installed ? "Yes" : "No"}`);
    console.log(`  Configured: ${tool.configured ? "Yes" : "No"}`);
    console.log(`  Config:     ${tool.configPath}`);
    if (tool.version) console.log(`  Version:    ${tool.version}`);
    if (tool.configContents) {
      console.log(`\n  Contents:`);
      console.log(tool.configContents);
    }
  }
  return 0;
}

async function runConfigSetCommand(toolId, opts = {}) {
  if (!toolId) {
    printError("Tool ID required. Usage: red-router config set <tool> [options]");
    return 1;
  }

  const baseUrl = opts.baseUrl || "http://localhost:25050/v1";
  const apiKey = opts.apiKey;
  const model = opts.model;

  if (!apiKey) {
    printError("API key required. Use --api-key or set OMNIROUTE_API_KEY.");
    return 1;
  }

  const { generateConfig } = await import("../../../src/lib/cli-helper/config-generator/index.js");
  const result = await generateConfig(toolId, { baseUrl, apiKey, model });

  if (!result.success) {
    printError(result.error || "Failed to generate config");
    return 1;
  }

  const guard = await guardHostConfigTarget(result.configPath, {
    toolLabel: toolId,
    hostCommand: `red-router config set ${toolId}`,
    allowContainerWrite: Boolean(opts.allowContainerWrite ?? opts["allow-container-write"]),
  });
  if (guard !== 0) return guard;

  const nonInteractive = opts.nonInteractive || opts.yes;

  if (!nonInteractive) {
    console.log(`\n  About to write config to: ${result.configPath}`);
    console.log(`  Content preview:\n`);
    console.log(result.content);
    console.log("");

    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question("Proceed? [y/N] ", resolve));
    rl.close();

    if (!/^y(es)?$/i.test(answer)) {
      console.log("Aborted.");
      return 0;
    }
  }

  const dir = path.dirname(result.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const backupPath = ensureBackup(result.configPath);
  if (backupPath) printInfo(`Backup saved to: ${backupPath}`);

  let content = result.content;
  if (toolId === "claude" && fs.existsSync(result.configPath)) {
    content = mergeClaudeSettings(fs.readFileSync(result.configPath, "utf-8"), result.content);
  }

  fs.writeFileSync(result.configPath, content, "utf-8");
  printSuccess(`Config written to ${result.configPath}`);
  return 0;
}

async function runConfigValidateCommand(toolId, opts = {}) {
  if (!toolId) {
    printError("Tool ID required. Usage: red-router config validate <tool>");
    return 1;
  }

  const baseUrl = opts.baseUrl || "http://localhost:25050/v1";
  const apiKey = opts.apiKey || "test-key";
  const model = opts.model;

  const { generateConfig } = await import("../../../src/lib/cli-helper/config-generator/index.js");
  const result = await generateConfig(toolId, { baseUrl, apiKey, model });

  if (!result.success) {
    printError(`Validation failed: ${result.error}`);
    return 1;
  }

  printSuccess(`Config for ${toolId} is valid`);
  if (opts.json) {
    console.log(JSON.stringify({ valid: true, content: result.content }, null, 2));
  }
  return 0;
}

export function registerConfig(program) {
  const config = program.command("config").description("Show or update CLI tool configuration");

  config
    .command("list")
    .description("List all CLI tools and config status")
    .option("--json", "Output as JSON")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runConfigListCommand({ ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  config
    .command("get <tool>")
    .description("Show current config for a tool")
    .option("--json", "Output as JSON")
    .action(async (tool, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runConfigGetCommand(tool, { ...opts, output: globalOpts.output });
      if (exitCode !== 0) process.exit(exitCode);
    });

  config
    .command("set <tool>")
    .description("Write config for a tool")
    .option("--model <model>", "Model identifier (where applicable)")
    .option("--non-interactive", "Do not prompt for confirmation")
    .option("--yes", "Skip confirmation prompt")
    .option(
      "--allow-container-write",
      "Write the config even when RedRouter runs in a container and the target is not mounted from the host"
    )
    .action(async (tool, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runConfigSetCommand(tool, {
        ...opts,
        apiKey: opts.apiKey || globalOpts.apiKey || process.env.OMNIROUTE_API_KEY,
        baseUrl: opts.baseUrl || globalOpts.baseUrl || process.env.OMNIROUTE_BASE_URL,
        output: globalOpts.output,
      });
      if (exitCode !== 0) process.exit(exitCode);
    });

  config
    .command("validate <tool>")
    .description("Validate config format without writing")
    .option("--model <model>", "Model identifier (where applicable)")
    .option("--json", "Output as JSON")
    .action(async (tool, opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runConfigValidateCommand(tool, {
        ...opts,
        apiKey: opts.apiKey || globalOpts.apiKey || process.env.OMNIROUTE_API_KEY,
        baseUrl: opts.baseUrl || globalOpts.baseUrl || process.env.OMNIROUTE_BASE_URL,
        output: globalOpts.output,
      });
      if (exitCode !== 0) process.exit(exitCode);
    });

  // Convenience alias: `config opencode` → `config set opencode`
  // Matches the documented CLI usage in docs/frameworks/OPENCODE.md.
  config
    .command("opencode")
    .description("Generate OpenCode config (alias for 'config set opencode')")
    .option("--model <model>", "Model identifier")
    .option("--non-interactive", "Do not prompt for confirmation")
    .option("--yes", "Skip confirmation prompt")
    .option(
      "--allow-container-write",
      "Write the config even when RedRouter runs in a container and the target is not mounted from the host"
    )
    .action(async (opts, cmd) => {
      const globalOpts = cmd.parent.optsWithGlobals();
      const exitCode = await runConfigSetCommand("opencode", {
        ...opts,
        apiKey: opts.apiKey || globalOpts.apiKey || process.env.OMNIROUTE_API_KEY,
        baseUrl: opts.baseUrl || globalOpts.baseUrl || process.env.OMNIROUTE_BASE_URL,
        output: globalOpts.output,
      });
      if (exitCode !== 0) process.exit(exitCode);
    });

  // Register contexts/profiles CRUD as a subgroup of config.
  registerContexts(config);
}
