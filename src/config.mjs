import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Slug aceito na linha de comando -> nome da nota-ancora em ENGENHARIA/00-conhecimento/,
// para que Responsavel grave um wikilink que resolve de verdade.
const RESPONSAVEIS = new Map([
  ["arthur", "Arthur_Cardoso"],
  ["mayara", "Madame_Carmen"],
  ["labs", "Madame_Labs"],
]);

export function resolveResponsavel(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^\[\[|\]\]$/g, "");
  return RESPONSAVEIS.get(raw.toLowerCase())
    ?? ([...RESPONSAVEIS.values()].includes(raw) ? raw : null);
}

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
  if (config.defaultBackend !== undefined && !["desktop", "headless"].includes(config.defaultBackend)) {
    throw new Error("invalid_defaultBackend");
  }
  const defaultResponsavel = resolveResponsavel(config.defaultResponsavel);
  if (!defaultResponsavel) throw new Error("invalid_defaultResponsavel");
  config.defaultResponsavel = defaultResponsavel;
  if (!config.desktop || typeof config.desktop !== "object") throw new Error("missing_desktop");
  requiredString(config.desktop, "baseUrl");
  requiredString(config.desktop, "authToken");
  if (config.desktop.authToken === "$TASKNOTES_AUTH_TOKEN") {
    if (!process.env.TASKNOTES_AUTH_TOKEN) throw new Error("missing_tasknotes_auth_token");
    config.desktop.authToken = process.env.TASKNOTES_AUTH_TOKEN;
  }
  if (!config.headless || typeof config.headless !== "object") throw new Error("missing_headless");
  requiredString(config.headless, "mtnPath");
  // stateDir explicito e o que isola teste e vault temporario do estado real da
  // maquina; sem ele a suite gravava leases de mentira no estado de producao.
  const stateDir = typeof config.stateDir === "string" && config.stateDir.trim()
    ? config.stateDir
    : defaultStateDir();
  return { ...config, stateDir };
}
