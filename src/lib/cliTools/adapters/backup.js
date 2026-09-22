import fs from "fs/promises";

const NO_ORIGINAL = "__RED_ROUTER_NO_ORIGINAL__";
const backupPath = (configPath) => `${configPath}.red-router-backup`;

export async function backupOriginal(configPath) {
  const target = backupPath(configPath);
  try {
    await fs.access(target);
    return;
  } catch {}

  let content = NO_ORIGINAL;
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch {}
  await fs.writeFile(target, content, "utf-8");
}

export async function restoreOriginal(configPath) {
  const target = backupPath(configPath);
  let content;
  try {
    content = await fs.readFile(target, "utf-8");
  } catch {
    return false;
  }

  if (content === NO_ORIGINAL) await fs.rm(configPath, { force: true });
  else await fs.writeFile(configPath, content, "utf-8");
  await fs.rm(target, { force: true });
  return true;
}
