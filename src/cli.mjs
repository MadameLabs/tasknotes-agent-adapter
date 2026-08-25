#!/usr/bin/env node
import { loadConfig, resolveResponsavel } from "./config.mjs";
import { parseHookPayload } from "./hooks.mjs";
import { diagnoseState, getBinding, openState, recoverLease } from "./state.mjs";
import { sessionEnd } from "./domain.mjs";
import { recoverOrphanTimer, recoverWork, startWork, stopWork } from "./domain.mjs";
import { createTaskNotesApiBackend } from "./backends/tasknotes-api.mjs";
import { createMtnBackend } from "./backends/mtn.mjs";
import { fileURLToPath } from "node:url";

const [command] = process.argv.slice(2);
const configIndex = process.argv.indexOf("--config");
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const option = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const options = (name) => process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1]] : []);
const cli = fileURLToPath(import.meta.url);
const backend = option("--backend", "desktop");
const STATUSES = ["to-do", "em-andamento", "aprovacao", "pausa", "concluido", "cancelado"];
const BACKENDS = ["desktop", "headless"];
const wikilink = (value) => value.startsWith("[[") ? value : `[[${value}]]`;

// Desktop e o padrao porque so ele cria tarefa com Responsavel, Marca e Projeto.
// Headless existe para sessao sem Obsidian aberto e nunca e escolhido sozinho.
function backendFor(config, name) {
  if (!BACKENDS.includes(name)) throw new Error("invalid_backend");
  return name === "headless"
    ? createMtnBackend({ mtnPath: config.headless.mtnPath, vaultPath: config.vaultPath, mtnArgs: config.headless.mtnArgs ?? [] })
    : createTaskNotesApiBackend(config.desktop);
}

function gateContext({ agent, configPath, defaultResponsavel, sessionId, binding }) {
  const base = `node ${cli}`;
  if (binding) {
    return `Gate TaskNotes satisfeito: sessão vinculada a ${binding.taskPath}. Use somente o adaptador Node deste hub. Ao encerrar: ${base} stop --agent ${agent} --session ${sessionId} --status STATUS --config ${configPath}. STATUS é obrigatório e descreve o que aconteceu de fato: aprovacao (terminou e precisa de conferência — o desfecho normal), concluido (terminou e é verificável sozinho, ou o usuário já confirmou), cancelado (abandonado), pausa (SÓ para stand-by real, nunca como desfecho de trabalho terminado).`;
  }
  return `Gate TaskNotes obrigatório no madamelabs-code. Antes de trabalhar, execute ${base} open --config ${configPath} e pergunte em qual tarefa atuar; o usuário pode dispensar tarefa e cronômetro explicitamente. Para criar: ${base} create "TÍTULO" --responsavel ${defaultResponsavel} --marca MARCA [--projeto PROJETO] --config ${configPath}. Para promover uma nota com execução: ${base} promote "CAMINHO_EXATO" --responsavel ${defaultResponsavel} --marca Madame_Labs --projeto PROJETO --backend headless --config ${configPath}. Para iniciar: ${base} start "CAMINHO_EXATO" --agent ${agent} --session ${sessionId} --config ${configPath}. Use somente este adaptador Node. Ao encerrar, ${base} stop exige --status: aprovacao (terminou e precisa de conferência — o desfecho normal), concluido, cancelado ou pausa (só stand-by real).`;
}

if (configIndex === -1 || !process.argv[configIndex + 1]) {
  output({ ok: false, error: "missing_config", message: "--config is required" });
  process.exitCode = 2;
} else {
  let config;
  try {
    config = await loadConfig(process.argv[configIndex + 1]);
  } catch {
    output({ ok: false, error: "config_invalid", message: "configuration could not be loaded" });
    process.exitCode = 1;
  }
  if (config) try {
    if (!["hook-start", "hook-end", "open", "create", "promote", "link-project", "set-status", "start", "stop", "diagnose", "recover", "recover-orphan"].includes(command)) {
      output({ ok: false, error: "unknown_command", message: "unsupported command" });
      process.exitCode = 2;
    } else if (command === "hook-start" || command === "hook-end") {
      const agent = option("--agent");
      const input = await new Promise((resolve) => { let raw = ""; process.stdin.on("data", (chunk) => raw += chunk); process.stdin.on("end", () => resolve(raw ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {})); });
      const event = command === "hook-start" ? "SessionStart" : agent === "claude" ? "SessionEnd" : "Stop";
      const hook = parseHookPayload(agent, event, input);
      const state = await openState(config.stateDir);
      if (command === "hook-end") {
        // O backend vem do vinculo: parar por um caminho diferente do que
        // iniciou nao consegue verificar a identidade do timer.
        const bound = await getBinding(state, hook.sessionKey);
        if (bound) await sessionEnd({ state, api: backendFor(config, bound.backend ?? backend), sessionKey: hook.sessionKey });
      }
      const binding = command === "hook-start" ? await getBinding(state, hook.sessionKey) : null;
      const additionalContext = gateContext({ agent, configPath: process.argv[configIndex + 1], defaultResponsavel: config.defaultResponsavel, sessionId: hook.sessionId, binding });
      // Codex exige hookEventName dentro de hookSpecificOutput no SessionStart.
      // Claude preserva seu evento para o wrapper e os testes de compatibilidade.
      output(command === "hook-start" && agent === "codex"
        ? { hookSpecificOutput: { hookEventName: hook.event, additionalContext } }
        : { ok: true, hookSpecificOutput: { hookEventName: hook.event, additionalContext } });
    } else if (command === "open") {
      const api = backendFor(config, backend);
      const tasks = (await api.listOpen()).map((task) => ({ ...task, path: task.path ?? task.id }));
      output({ ok: true, tasks });
    } else if (command === "create") {
      const title = process.argv[3];
      if (!title) throw new Error("missing_title");
      const responsavel = resolveResponsavel(option("--responsavel", config.defaultResponsavel));
      if (!responsavel) throw new Error("invalid_responsavel");
      const api = backendFor(config, backend);
      const task = await api.createTask({
        title,
        responsavel,
        marcas: options("--marca"),
        projeto: option("--projeto"),
      });
      output({ ok: true, task });
    } else if (command === "promote") {
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const responsavel = resolveResponsavel(option("--responsavel", config.defaultResponsavel));
      const marca = option("--marca");
      const projeto = option("--projeto");
      if (!taskPath || !responsavel || !marca || !projeto) throw new Error("missing_promotion_metadata");
      const api = backendFor(config, backend);
      await api.promoteTask(taskPath, {
        responsavel: wikilink(responsavel),
        marca: wikilink(marca),
        projeto: wikilink(projeto),
      });
      output({ ok: true, result: { taskPath } });
    } else if (command === "link-project") {
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const projetos = options("--projeto").filter((value) => value && !value.startsWith("--"));
      if (!taskPath || !projetos.length) throw new Error("missing_task_or_project");
      const api = backendFor(config, backend);
      await api.setProjects(taskPath, projetos);
      output({ ok: true, result: { taskPath, projects: projetos } });
    } else if (command === "set-status") {
      // Corrige o status de uma tarefa sem vincular sessao nem tocar no cronometro.
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const status = option("--status");
      if (!taskPath) throw new Error("missing_task");
      if (!STATUSES.includes(status)) throw new Error("missing_or_invalid_status");
      const api = backendFor(config, backend);
      await api.setStatus(taskPath, status);
      output({ ok: true, result: { taskPath, status } });
    } else if (command === "start" || command === "stop") {
      const taskPath = process.argv[3];
      const agent = option("--agent");
      const sessionId = option("--session");
      if (!agent || !sessionId || (command === "start" && !taskPath)) throw new Error("missing_session_or_task");
      const status = option("--status");
      // Sem default: pausa como desfecho automatico mentia sobre tarefas terminadas.
      if (command === "stop" && !STATUSES.includes(status)) throw new Error("missing_or_invalid_status");
      const state = await openState(config.stateDir);
      const sessionKey = `${agent}:${sessionId}`;
      const bound = command === "stop" ? await getBinding(state, sessionKey) : null;
      const api = backendFor(config, bound?.backend ?? backend);
      const result = command === "start"
        ? await startWork({ state, api, sessionKey, vault: config.vault, taskPath, backend })
        : await stopWork({ state, api, sessionKey, status });
      output({ ok: true, result });
    } else if (command === "recover") {
      // Recuperacao explicita: libera vinculo e lease de uma sessao morta sem
      // tocar em backend nenhum. Exige o dono esperado, para nao virar caminho
      // de tomar a tarefa de outra sessao viva.
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const agent = option("--agent");
      const sessionId = option("--session");
      if (!taskPath || !agent || !sessionId) throw new Error("missing_session_or_task");
      const state = await openState(config.stateDir);
      const sessionKey = `${agent}:${sessionId}`;
      if (process.argv.includes("--stop-timer")) {
        const binding = await getBinding(state, sessionKey);
        const api = backendFor(config, binding?.backend ?? backend);
        output({ ok: true, result: await recoverWork({ state, api, sessionKey, vault: config.vault, taskPath, stopTimer: true }) });
      } else {
        await recoverLease(state, `${config.vault}:${taskPath}`, sessionKey);
        output({ ok: true, result: { taskPath, released: sessionKey } });
      }
    } else if (command === "recover-orphan") {
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const startTime = option("--start-time");
      if (!taskPath || !startTime) throw new Error("missing_orphan_timer_identity");
      if (!process.argv.includes("--stop-timer")) throw new Error("missing_stop_timer_confirmation");
      const api = backendFor(config, backend);
      output({ ok: true, result: await recoverOrphanTimer({ api, taskPath, startTime }) });
    } else if (command === "diagnose") {
      output({ ok: true, result: await diagnoseState(await openState(config.stateDir)) });
    } else {
      output({ ok: true, command, responsavel: config.defaultResponsavel });
    }
  } catch (error) {
    const code = String(error?.message ?? "operation_failed").split(":", 1)[0];
    output({ ok: false, error: code, message: "TaskNotes operation failed without changing another session" });
    process.exitCode = 2;
  }
}
