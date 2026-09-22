"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { backupOriginal, restoreOriginal } from "./backup.js";
import { parseTOML, stringifyTOML } from "confbox";

const execAsync = promisify(exec);

const getCodewhaleDir = () => path.join(os.homedir(), ".codewhale");
const getCodewhaleConfigPath = () => path.join(getCodewhaleDir(), "config.toml");

const checkCodewhaleInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where codewhale" : "which codewhale";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getCodewhaleConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const hasRedRouterConfig = (content) => {
  if (!content) return false;
  return content.includes("managed by RedRouter") || content.includes("localhost:25050");
};

const readConfig = async () => {
  try {
    return await fs.readFile(getCodewhaleConfigPath(), "utf-8");
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const installed = await checkCodewhaleInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "CodeWhale CLI is not installed",
      });
    }

    const content = await readConfig();
    let config = null;
    try {
      if (content) config = parseTOML(content);
    } catch {}

    return NextResponse.json({
      installed: true,
      config,
      hasRedRouter: hasRedRouterConfig(content),
      configPath: getCodewhaleConfigPath(),
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const configPath = getCodewhaleConfigPath();
    await fs.mkdir(getCodewhaleDir(), { recursive: true });
    await backupOriginal(configPath);

    let existing = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = parseTOML(raw);
    } catch {}

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    existing.openai = {
      base_url: normalizedBaseUrl,
      api_key: apiKey || "sk_red-router",
      model: model || "provider/model-id",
    };

    const header = "# CodeWhale config — managed by RedRouter\n\n";
    const content = header + stringifyTOML(existing);

    await fs.writeFile(configPath, content, "utf-8");

    return NextResponse.json({
      success: true,
      message: "CodeWhale settings applied successfully!",
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getCodewhaleConfigPath();
    if (await restoreOriginal(configPath)) {
      return NextResponse.json({ success: true, message: "RedRouter settings removed and previous configuration restored" });
    }
    let existing = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = parseTOML(raw);
    } catch {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    delete existing.openai;

    if (Object.keys(existing).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await fs.writeFile(configPath, stringifyTOML(existing), "utf-8");
    }

    return NextResponse.json({ success: true, message: "RedRouter removed from CodeWhale" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
