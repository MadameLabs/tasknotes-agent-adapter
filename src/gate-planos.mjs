import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultStateDir } from "./config.mjs";
import { avaliarPlano, caminhoProibido, lerBaseToml, listarForaDoPadrao } from "./planos.mjs";

const git = promisify(execFile);
const CALADO = Object.freeze({ stdout: "", codigo: 0 });
const CONFIG_LITERAL = "<config.agent.local.json do workspace>";

async function rodarGit(dir, args) {
  const { stdout } = await git("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
  return stdout;
}

function ancestralExistente(alvo) {
  let dir = path.dirname(alvo);
  while (!existsSync(dir)) {
    const pai = path.dirname(dir);
    if (pai === dir) return dir;
    dir = pai;
  }
  return dir;
}

async function raizGitDe(arquivo) {
  try {
    return (await rodarGit(ancestralExistente(arquivo), ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

function acharConfig(cwd) {
  if (!cwd) return CONFIG_LITERAL;
  let dir = path.resolve(cwd);
  for (;;) {
    const candidato = path.join(dir, "config.agent.local.json");
    if (existsSync(candidato)) return candidato;
    const pai = path.dirname(dir);
    if (pai === dir) return CONFIG_LITERAL;
    dir = pai;
  }
}

function responder(agente, modo, motivo) {
  let corpo;
  if (agente === "omp") corpo = { bloquear: true, motivo };
  else if (modo === "escrita" && agente === "hermes") corpo = { action: "block", message: motivo };
  else if (modo === "escrita") {
    corpo = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: motivo } };
  } else corpo = { decision: "block", reason: motivo };
  return { stdout: `${JSON.stringify(corpo)}\n`, codigo: 0 };
}

async function escrita({ agente, entrada, env, cwd }, base) {
  const ti = entrada?.tool_input;
  const arquivo = ti?.file_path ?? ti?.path;
  if (typeof arquivo !== "string" || !arquivo) return CALADO;
  const abs = path.resolve(entrada.cwd ?? cwd ?? process.cwd(), arquivo);
  const padrao = caminhoProibido(abs, {
    raizGit: await raizGitDe(abs),
    home: env?.HOME || homedir(),
    extras: base.proibidosExtra,
  });
  if (!padrao) return CALADO;
  const destino = base.pastas[0];
  return responder(agente, "escrita", `Plano não pode ser salvo em ${abs} (padrão ${padrao}). Salve em ${destino}/ .`);
}

async function inicioDaSessao(entrada, desde) {
  const dataValida = (v) => {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  };
  if (desde) {
    const t = dataValida(desde);
    if (t !== null) return t;
  }
  const transcript = entrada?.transcript_path;
  if (typeof transcript !== "string" || !transcript) return null;
  try {
    const texto = await readFile(transcript, "utf8");
    const primeira = texto.slice(0, texto.indexOf("\n") < 0 ? undefined : texto.indexOf("\n")).replace(/^﻿/, "");
    const ts = JSON.parse(primeira)?.timestamp;
    const t = ts ? dataValida(ts) : null;
    if (t !== null) return t;
  } catch {
    // cai para o mtime
  }
  try {
    return (await stat(transcript)).mtimeMs;
  } catch {
    return null;
  }
}

// Caminhos novos ou alterados segundo `git status`, absolutos. Plano que chegou por pull nao aparece.
async function alteradosNoGit(base) {
  const raiz = (await rodarGit(base, ["rev-parse", "--show-toplevel"])).trim();
  const bruto = await rodarGit(base, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const partes = bruto.split("\0");
  const caminhos = [];
  for (let i = 0; i < partes.length; i += 1) {
    const p = partes[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    caminhos.push(path.resolve(raiz, p.slice(3)));
    if (xy.includes("R") || xy.includes("C")) i += 1; // proximo campo e o caminho de origem
  }
  return caminhos;
}

function montarMotivo(pendentes, base, cwd) {
  const config = acharConfig(cwd);
  const linhas = ["Há planos da sessão fora do padrão (faltando tag task, projects ou brand). Promova cada um antes de encerrar:"];
  for (const p of pendentes) {
    const rel = path.relative(base.base, p.caminho).replace(/\\/g, "/");
    linhas.push(`- ${rel} (faltando: ${p.faltando.join(", ")})`);
    linhas.push(`  tasknotes-agent promote "${rel}" --responsavel arthur --marca <MARCA> --projeto <PROJETO> --config ${config}`);
  }
  return linhas.join("\n");
}

async function lerEstado(arquivo) {
  try {
    const v = JSON.parse(await readFile(arquivo, "utf8"));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function saida({ agente, entrada, env, cwd, desde }, base) {
  const inicio = await inicioDaSessao(entrada, desde);
  if (inicio === null) return CALADO;
  let candidatos;
  try {
    candidatos = await alteradosNoGit(base.base);
  } catch {
    return CALADO;
  }
  const pendentes = [];
  for (const caminho of [...new Set(candidatos)].sort()) {
    if (!caminho.toLowerCase().endsWith(".md")) continue;
    if (!base.pastas.some((p) => path.resolve(p) === path.dirname(caminho))) continue;
    try {
      if ((await stat(caminho)).mtimeMs < inicio) continue;
      const r = avaliarPlano(caminho, await readFile(caminho, "utf8"), base.pastas);
      if (r.ehPlano && !r.noPadrao) pendentes.push({ caminho, faltando: r.faltando });
    } catch {
      // arquivo sumiu ou ilegivel: nao e plano da sessao
    }
  }

  const stateDir = path.join(defaultStateDir(env ?? process.env), "gate-planos");
  const sessao = typeof entrada?.session_id === "string" && entrada.session_id ? entrada.session_id : "sem-sessao";
  const seguro = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const arquivoEstado = path.join(stateDir, `${seguro(agente)}-${seguro(sessao)}.json`);

  if (!pendentes.length) {
    await rm(arquivoEstado, { force: true }).catch(() => {});
    return CALADO;
  }
  const conjunto = pendentes.map((p) => p.caminho).sort();
  const anterior = await lerEstado(arquivoEstado);
  const igual = anterior && anterior.length === conjunto.length && anterior.every((v, i) => v === conjunto[i]);
  if (entrada?.stop_hook_active === true || igual) {
    await mkdir(stateDir, { recursive: true });
    const quando = new Date().toISOString();
    const linhas = pendentes.map((p) => JSON.stringify({ quando, sessao, caminho: p.caminho, faltando: p.faltando })).join("\n");
    await appendFile(path.join(stateDir, "pendentes.jsonl"), `${linhas}\n`);
    return CALADO;
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(arquivoEstado, JSON.stringify(conjunto));
  return responder(agente, "saida", montarMotivo(pendentes, base, entrada?.cwd ?? cwd));
}

async function pendentesTodos(base) {
  const fora = await listarForaDoPadrao({ pastas: base.pastas });
  if (!fora.length) return CALADO;
  const linhas = fora.map((p) => `${path.relative(base.base, p.caminho).replace(/\\/g, "/")}\t${p.faltando.join(",")}`);
  return { stdout: `${linhas.join("\n")}\n`, codigo: 1 };
}

export async function executarGatePlanos(modo, { agente = "claude", entrada = {}, env = process.env, cwd = process.cwd(), desde } = {}) {
  try {
    const base = await lerBaseToml(env?.MADAMELABS_BASE_TOML);
    if (!base || !base.base || !base.pastas.length) return CALADO;
    if (modo === "escrita") return await escrita({ agente, entrada, env, cwd }, base);
    if (modo === "saida") return await saida({ agente, entrada, env, cwd, desde }, base);
    if (modo === "pendentes") return await pendentesTodos(base);
    return CALADO;
  } catch {
    return CALADO;
  }
}
