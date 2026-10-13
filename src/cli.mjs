#!/usr/bin/env node
import { loadConfig, resolveResponsavel } from "./config.mjs";
import { parseHookPayload } from "./hooks.mjs";
import { diagnoseState, getBinding, openState, recoverLease } from "./state.mjs";
import { sessionEnd } from "./domain.mjs";
import { recoverOrphanTimer, recoverWork, startWork, stopWork } from "./domain.mjs";
import { createTaskNotesApiBackend } from "./backends/tasknotes-api.mjs";
import { createMtnBackend } from "./backends/mtn.mjs";
import { statusValue } from "./vocabulary.mjs";
import { lastActivity } from "./time-entries.mjs";

const [command] = process.argv.slice(2);
const configIndex = process.argv.indexOf("--config");
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const option = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const options = (name) => process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1]] : []);
const requestedBackend = option("--backend");
const BACKENDS = ["desktop", "headless"];
const wikilink = (value) => value.startsWith("[[") ? value : `[[${value}]]`;
// Data de calendario AAAA-MM-DD que existe de fato e nao esta no futuro.
const isPastOrTodayDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
    && value <= new Date().toLocaleDateString("sv-SE");
};

// Desktop e o padrao; ambos os backends criam e promovem tarefa com metadados.
// Headless pode ser escolhido explicitamente ou como default configurado.
function backendFor(config, name) {
  if (!BACKENDS.includes(name)) throw new Error("invalid_backend");
  if (name === "desktop" && !config.desktop) throw new Error("missing_desktop");
  return name === "headless"
    ? createMtnBackend({ mtnPath: config.headless.mtnPath, vaultPath: config.vaultPath, mtnArgs: config.headless.mtnArgs ?? [], vocabulary: config.vocabulary })
    : createTaskNotesApiBackend({ ...config.desktop, vocabulary: config.vocabulary });
}

// Encerrar nao e a mesma coisa que comecar: quem para o cronometro nao escolhe
// se o Obsidian esta aberto. O backend do vinculo continua na frente, porque e
// dele a identidade do timer, mas o headless entra atras como plano B -- ele le
// o mesmo arquivo do vault e verifica a mesma identidade.
function backendCandidates(config, primary) {
  // Sem bloco desktop na config, encerrar vai direto ao headless em vez de
  // falhar em missing_desktop.
  return [primary, "headless"]
    .filter((name, index, all) => all.indexOf(name) === index)
    .filter((name) => name !== "desktop" || config.desktop)
    .map((name) => ({ backend: name, api: backendFor(config, name) }));
}

function hookEventFor(command, agent, input) {
  const expected = command === "hook-start" ? "SessionStart" : "SessionEnd";
  const event = input?.hook_event_name ?? expected;
  // Codex changed its configured end hook to SessionEnd. Keep Stop only for
  // payloads from older Codex hook configurations; reject unrelated host events.
  if (event === expected || (command === "hook-end" && agent === "codex" && event === "Stop")) return event;
  throw new Error("invalid_hook_event");
}

function gateContext({ agent, configPath, defaultResponsavel, sessionId, binding, workspace }) {
  // O gate imprime o comando que a pessoa (ou o agente) deve digitar, e desde
  // que o adaptador virou pacote instalado esse comando e o `bin`, nao o
  // caminho do arquivo. Imprimir `node <caminho do modulo global>` mandava
  // decorar um caminho que muda a cada reinstalacao.
  const base = "tasknotes-agent";
  // O gate nao e um lembrete de abertura: e a regra que a sessao reavalia a
  // cada mensagem. Por isso os dois textos descrevem o mesmo ciclo -- detectar
  // execucao, materializar o artefato duravel, promover, iniciar, concluir a
  // fase e avancar -- e nao so o comando da vez.
  if (binding) {
    return [
      `Gate TaskNotes satisfeito: sessão vinculada a ${binding.taskPath}. Use somente o adaptador Node deste hub.`,
      `Reclassifique a intenção a cada mensagem: quando o trabalho troca de artefato durável — o design terminou e começa o plano, o plano terminou e começa a implementação —, isso é uma nova fase. Encerre a fase terminada com ${base} stop --agent ${agent} --session ${sessionId} --status concluido --config ${configPath} e só então promova e inicie o próximo artefato; nunca deixe duas tarefas abertas representando a mesma feature.`,
      `O cronômetro acompanha a tarefa, não a resposta: continua correndo entre as mensagens e só para no desfecho da tarefa, quando a pessoa usuária confirma o resultado, troca de assunto ou encerra o trabalho. Terminar uma resposta ou entregar uma etapa não é desfecho. No desfecho, o agente decide o status a partir do contexto; só pergunte à pessoa usuária diante de ambiguidade material: ${base} stop --agent ${agent} --session ${sessionId} --status STATUS --config ${configPath}. STATUS é obrigatório e descreve o que aconteceu de fato: aprovacao (terminou e precisa de conferência), concluido (terminou e é verificável sozinho, ou o usuário já confirmou), cancelado (abandonado), pausa (SÓ para stand-by real, nunca como desfecho de trabalho terminado).`,
    ].join("\n\n");
  }
  return [
    `Gate TaskNotes obrigatório no ${workspace}. Esta sessão não tem tarefa vinculada.`,
    `Reclassifique a intenção a cada mensagem: o pedido em curso tem execução? Se tem, existe um artefato durável — briefing, design, especificação, plano ou tarefa direta — que a represente? O ciclo é detectar a intenção de execução, materializar o artefato durável, promover a nota a tarefa, iniciar o cronômetro, concluir a fase e avançar para o artefato seguinte.`,
    `Plan Mode e update_plan são camada efêmera da sessão: não criam tarefa por si sós e não substituem o artefato durável.`,
    `Fase terminada é encerrada com --status concluido antes de a seguinte ser rastreada, para não haver duas tarefas simultâneas representando a mesma feature.`,
    `Listar: ${base} open --backend headless --config ${configPath}`,
    `Criar: ${base} create "TÍTULO" --responsavel ${defaultResponsavel} --marca MARCA --projeto PROJETO --backend headless --config ${configPath}`,
    `Promover uma nota com execução: ${base} promote "CAMINHO_EXATO" --responsavel ${defaultResponsavel} --marca Madame_Labs --projeto PROJETO --config ${configPath}`,
    `Iniciar: ${base} start "CAMINHO_EXATO" --agent ${agent} --session ${sessionId} --backend headless --config ${configPath}`,
    `A pessoa usuária pode dispensar tarefa e cronômetro explicitamente; nunca escolher ou criar silenciosamente. Use somente este adaptador Node. O cronômetro acompanha a tarefa, não a resposta: não pare ao fim de cada resposta, só no desfecho da tarefa (confirmação, troca de assunto ou encerramento). No desfecho, o agente decide o status a partir do contexto; só pergunte diante de ambiguidade material. ${base} stop exige --status: aprovacao (terminou e precisa de conferência), concluido (verificável sozinho, ou já confirmado), cancelado (abandonado) ou pausa (só stand-by real).`,
  ].join("\n\n");
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
    const backend = requestedBackend ?? config.defaultBackend ?? "desktop";
    if (!["hook-start", "hook-end", "open", "create", "promote", "link-project", "set-status", "start", "stop", "diagnose", "recover", "recover-orphan", "fix-time", "suggest-end"].includes(command)) {
      output({ ok: false, error: "unknown_command", message: "unsupported command" });
      process.exitCode = 2;
    } else if (command === "hook-start" || command === "hook-end") {
      const agent = option("--agent");
      const input = await new Promise((resolve) => { let raw = ""; process.stdin.on("data", (chunk) => raw += chunk); process.stdin.on("end", () => resolve(raw ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {})); });
      const event = hookEventFor(command, agent, input);
      const hook = parseHookPayload(agent, event, input);
      const state = await openState(config.stateDir);
      if (command === "hook-end") {
        const bound = await getBinding(state, hook.sessionKey);
        const result = bound
          ? await sessionEnd({ state, apis: backendCandidates(config, bound.backend ?? backend), sessionKey: hook.sessionKey })
          : { ok: true, stopped: false };
        // SessionEnd nao instrui ninguem: nao ha mais sessao para ler o gate. O
        // texto so vinha junto por o hook-end compartilhar caminho de codigo
        // com o hook-start.
        output({ ok: true, hookSpecificOutput: { hookEventName: hook.event }, result });
      } else {
        const binding = await getBinding(state, hook.sessionKey);
        const additionalContext = gateContext({ agent, configPath: process.argv[configIndex + 1], defaultResponsavel: config.defaultResponsavel, sessionId: hook.sessionId, binding, workspace: config.workspace });
        // Codex exige hookEventName dentro de hookSpecificOutput no SessionStart.
        // Claude preserva seu evento para o wrapper e os testes de compatibilidade.
        output(agent === "codex"
          ? { hookSpecificOutput: { hookEventName: hook.event, additionalContext } }
          : { ok: true, hookSpecificOutput: { hookEventName: hook.event, additionalContext } });
      }
    } else if (command === "open") {
      const api = backendFor(config, backend);
      const tasks = (await api.listOpen()).map((task) => ({ ...task, path: task.path ?? task.id }));
      output({ ok: true, tasks });
    } else if (command === "create") {
      const title = process.argv[3];
      const responsavel = resolveResponsavel(option("--responsavel", config.defaultResponsavel));
      const marca = option("--marca");
      const projeto = option("--projeto");
      if (!title || !responsavel || !marca || !projeto) throw new Error("missing_create_metadata");
      const api = backendFor(config, backend);
      const task = await api.createTask({
        title,
        responsavel,
        marcas: [marca],
        projeto,
      });
      output({ ok: true, task });
    } else if (command === "promote") {
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const responsavel = resolveResponsavel(option("--responsavel", config.defaultResponsavel));
      const marca = option("--marca");
      const projeto = option("--projeto");
      if (!taskPath || !responsavel || !marca || !projeto) throw new Error("missing_promotion_metadata");
      // Promover e escrita de frontmatter num arquivo que ainda nao e tarefa, e
      // a API do plugin nao alcanca esse arquivo: GET e PUT /api/tasks/<path>
      // respondem 404 "Task not found" enquanto a tag `task` nao esta la, e nao
      // existe endpoint de arquivo. Por isso o promote usa sempre o headless,
      // mesmo com o Obsidian aberto -- antes disso, o backend padrao devolvia
      // `unsupported_backend` e a promocao so funcionava com --backend headless.
      const api = backendFor(config, "headless");
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
      const role = option("--status");
      const status = statusValue(config.vocabulary, role);
      const completedDate = option("--completed-date");
      if (!taskPath) throw new Error("missing_task");
      if (!status) throw new Error("missing_or_invalid_status");
      if (completedDate !== undefined) {
        // Data de conclusao so existe em tarefa fechada, e so no passado ou hoje.
        if (!["concluido", "cancelado"].includes(role)) throw new Error("completed_date_requires_closed_status");
        if (!isPastOrTodayDate(completedDate)) throw new Error("invalid_completed_date");
      }
      // Com data explicita, sempre headless: a API do plugin grava a data do
      // dia ao fechar, e o campo e escrita de frontmatter, como no fix-time.
      const api = backendFor(config, completedDate !== undefined ? "headless" : backend);
      await api.setStatus(taskPath, status, completedDate !== undefined ? { completedDate } : {});
      output({ ok: true, result: { taskPath, status, ...(completedDate !== undefined ? { completedDate } : {}) } });
    } else if (command === "start" || command === "stop") {
      const taskPath = process.argv[3];
      const agent = option("--agent");
      const sessionId = option("--session");
      if (!agent || !sessionId || (command === "start" && !taskPath)) throw new Error("missing_session_or_task");
      // O agente diz o papel (`aprovacao`) e o vault grava o seu valor (`review`
      // no ENGENHARIA). Sem default: pausa como desfecho automatico mentia
      // sobre tarefas terminadas.
      const status = statusValue(config.vocabulary, option("--status"));
      if (command === "stop" && !status) throw new Error("missing_or_invalid_status");
      const state = await openState(config.stateDir);
      const sessionKey = `${agent}:${sessionId}`;
      const bound = command === "stop" ? await getBinding(state, sessionKey) : null;
      const result = command === "start"
        ? await startWork({ state, api: backendFor(config, backend), sessionKey, vault: config.vault, taskPath, backend, vocabulary: config.vocabulary })
        : await stopWork({ state, apis: backendCandidates(config, bound?.backend ?? backend), sessionKey, status });
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
    } else if (command === "fix-time") {
      // Corrige o inicio ou o fim de uma entrada de tempo ja fechada -- o caso e
      // o cronometro que ficou aberto depois que a sessao morreu e so foi
      // parado horas depois. Sempre headless, como o promote: a API do plugin
      // nao edita entrada de tempo. Entrada ainda presa a uma sessao viva nao
      // se corrige: quem manda nela e o `stop` daquela sessao.
      const taskPath = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
      const startTime = option("--entry");
      const reason = option("--reason");
      if (!taskPath || !startTime) throw new Error("missing_task_or_entry");
      if (!reason) throw new Error("missing_reason");
      const state = await diagnoseState(await openState(config.stateDir));
      if (state.bindings.some((binding) => binding.vault === config.vault && binding.taskPath === taskPath && binding.timerIdentity?.startTime === startTime)) {
        throw new Error("time_entry_bound_to_session");
      }
      const result = await backendFor(config, "headless").retimeEntry(taskPath, { startTime, newStart: option("--start"), newEnd: option("--end") });
      output({ ok: true, result: { taskPath, reason, ...result } });
    } else if (command === "suggest-end") {
      // So le: aponta a ultima atividade real no transcript da sessao dona,
      // para o agente mostrar a fonte antes de corrigir com fix-time.
      const agent = option("--agent");
      const sessionId = option("--session");
      if (!agent || !sessionId) throw new Error("missing_session");
      output({ ok: true, result: { agent, sessionId, ...await lastActivity({ agent, sessionId, after: option("--after") }) } });
    } else if (command === "diagnose") {
      const result = await diagnoseState(await openState(config.stateDir));
      // `--timers` le o vault e mostra ha quanto tempo cada cronometro esta
      // aberto: e por ele que se acha o cronometro esquecido por sessao morta.
      if (process.argv.includes("--timers")) {
        const now = Date.now();
        result.openTimers = (await backendFor(config, "headless").getActiveTimers()).map((item) => ({
          taskPath: item.task.id,
          startTime: item.session.startTime,
          openHours: Math.round((now - new Date(item.session.startTime).getTime()) / 36e5 * 10) / 10,
          sessionKey: result.bindings.find((binding) => binding.vault === config.vault && binding.taskPath === item.task.id)?.sessionKey ?? null,
        }));
      }
      output({ ok: true, result });
    } else {
      output({ ok: true, command, responsavel: config.defaultResponsavel });
    }
  } catch (error) {
    // O codigo continua sendo o primeiro segmento, mas o resto da mensagem e a
    // unica pista do que precisa ser corrigido: trocar tudo por uma frase fixa
    // fazia "File not found" e "unknown_field" desaparecerem no caminho.
    const raw = String(error?.message ?? "operation_failed");
    const separator = raw.indexOf(":");
    const code = separator > 0 ? raw.slice(0, separator) : raw;
    const detail = separator > 0 ? raw.slice(separator + 1).trim() : "";
    output({
      ok: false,
      error: code,
      message: detail || "TaskNotes operation failed without changing another session",
    });
    process.exitCode = 2;
  }
}
