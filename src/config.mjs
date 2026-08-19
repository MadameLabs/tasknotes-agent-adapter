import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RESPONSAVEIS = new Set(["arthur", "mayara", "labs"]);

function requiredString(config, key) {
  if (typeof config[key] !== "string" || !config[key].trim()) {
    throw new Error(`missing_${key}`);
  }
  return config[key];
}

export function defaultStateDir(env = process.env, platform = process.platform) {
  return platform === "win32"
    ? join(env.LOCALAPPDATA ?? "", "MadameLabs", "TaskNotesAgent")
    : join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "madamelabs-tasknotes");
}

export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  requiredString(config, "workspace");
  requiredString(config, "vault");
  requiredString(config, "vaultPath");
  requiredString(config, "defaultResponsavel");
  if (!RESPONSAVEIS.has(config.defaultResponsavel)) {
    throw new Error("invalid_defaultResponsavel");
  }
  if (!config.desktop || typeof config.desktop !== "object") throw new Error("missing_desktop");
  requiredString(config.desktop, "baseUrl");
  requiredString(config.desktop, "authToken");
  if (!config.headless || typeof config.headless !== "object") throw new Error("missing_headless");
  requiredString(config.headless, "mtnPath");
  return { ...config, stateDir: defaultStateDir() };
}
