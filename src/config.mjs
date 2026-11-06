import { readFile } from "node:fs/promises";
import { bundledMtnPath } from "./mtn-path.mjs";
import { resolveVocabulary } from "./vocabulary.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

// Apelido aceito na linha de comando -> pessoas em BIBLIOTECA/11-pessoas/, para
// que `assignees` grave wikilinks que resolvem de verdade. Responsavel e pessoa,
// nao marca (T8 do projeto base unica, 2026-11): `labs` sao os dois socios.
const RESPONSAVEIS = new Map([
  ["arthur", ["Arthur Cardoso"]],
  ["mayara", ["Mayara Almeida"]],
  ["labs", ["Arthur Cardoso", "Mayara Almeida"]],
  ["misslabs", ["Miss. Labs"]],
]);

// Nomes de marca que ja fizeram papel de responsavel. Config velho ou habito
// gravaria a marca de novo; falhar as claras, dizendo o apelido certo, e o que
// impede uma maquina atrasada de desfazer o corte sem ninguem perceber.
const ANTIGOS = new Map([
  ["Arthur_Cardoso", "arthur"],
  ["Madame_Carmen", "mayara"],
  ["Madame_Labs", "labs"],
]);

export function resolveResponsavel(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^\[\[|\]\]$/g, "");
  if (ANTIGOS.has(raw)) {
    const apelido = ANTIGOS.get(raw);
    throw new Error(`responsavel_antigo: use ${apelido} (${RESPONSAVEIS.get(apelido).join(", ")})`);
  }
  const pessoas = RESPONSAVEIS.get(raw.toLowerCase());
  if (pessoas) return [...pessoas];
  return [...RESPONSAVEIS.values()].some((lista) => lista.length === 1 && lista[0] === raw) ? [raw] : null;
}

function defaultResponsavelValido(value) {
  try {
    return Boolean(resolveResponsavel(value));
  } catch (error) {
    if (String(error?.message).startsWith("responsavel_antigo")) return true;
    throw error;
  }
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
  // Valida, mas guarda o apelido: o texto do gate do SessionStart mostra
  // `--responsavel arthur`, que o create resolve de novo na hora. Nome de marca
  // (config de antes da T8) carrega: derrubar o config inteiro impediria o stop
  // de fechar o cronometro; o create e o promote recusam e dizem o apelido.
  if (!defaultResponsavelValido(config.defaultResponsavel)) throw new Error("invalid_defaultResponsavel");
  // Maquina sem Obsidian nao tem API do plugin: com default headless o bloco
  // desktop e opcional, e pedir --backend desktop sem ele falha no cli com
  // missing_desktop. Quando o bloco existe, continua validado por inteiro.
  if (config.desktop !== undefined || config.defaultBackend !== "headless") {
    if (!config.desktop || typeof config.desktop !== "object") throw new Error("missing_desktop");
    requiredString(config.desktop, "baseUrl");
    requiredString(config.desktop, "authToken");
    if (config.desktop.authToken === "$TASKNOTES_AUTH_TOKEN") {
      if (!process.env.TASKNOTES_AUTH_TOKEN) throw new Error("missing_tasknotes_auth_token");
      config.desktop.authToken = process.env.TASKNOTES_AUTH_TOKEN;
    }
  }
  // headless e mtnPath deixaram de ser obrigatorios: o mtn vem como dependencia
  // do pacote e e resolvido por modulo. O campo continua valendo e vence quando
  // presente, para apontar um clone em desenvolvimento sem reinstalar nada.
  if (config.headless !== undefined && (typeof config.headless !== "object" || config.headless === null)) {
    throw new Error("invalid_headless");
  }
  const headless = { ...config.headless };
  if (headless.mtnPath === undefined) headless.mtnPath = bundledMtnPath();
  else requiredString(headless, "mtnPath");
  // stateDir explicito e o que isola teste e vault temporario do estado real da
  // maquina; sem ele a suite gravava leases de mentira no estado de producao.
  const stateDir = typeof config.stateDir === "string" && config.stateDir.trim()
    ? config.stateDir
    : defaultStateDir();
  return { ...config, headless, stateDir, vocabulary: resolveVocabulary(config.vocabulary) };
}
