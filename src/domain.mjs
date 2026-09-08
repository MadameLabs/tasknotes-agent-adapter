import { bindSession, confirmSession, getBinding, recordDivergence, recoverLease, releaseSession } from "./state.mjs";

export async function startWork({ state, api, sessionKey, vault, taskPath, backend = "desktop" }) {
  const existing = await getBinding(state, sessionKey);
  if (existing?.taskPath === taskPath) return existing;
  if (existing) throw new Error("session_already_bound");
  const task = await api.getTask(taskPath);
  if (!task || ["concluido", "cancelado"].includes(task.status)) throw new Error("task_not_open");
  const binding = { sessionKey, vault, taskPath, backend, timerIdentity: null, createdAt: new Date().toISOString(), confirmedAt: null };
  await bindSession(state, binding);
  try {
    if ((await api.getActiveTimers()).some((item) => (item.task?.id ?? item.task?.path) === taskPath)) throw new Error("unowned_active_timer");
    await api.setStatus(taskPath, "em-andamento");
    // O TaskNotes pode ter "Auto-start time tracking" ligado, e ai e a propria
    // mudanca de status que dispara o cronometro. O `startTimer` seguinte morria
    // com "Timer already running", o vinculo era desfeito e o timer ficava
    // correndo sem dono. Nao havia cronometro nenhum antes do setStatus -- isso
    // acabou de ser verificado --, entao o que aparece agora e efeito do nosso
    // proprio pedido: adotar e reconhecer a identidade, nao tomar a de outrem.
    const autoStarted = (await api.getActiveTimers()).find((item) => (item.task?.id ?? item.task?.path) === taskPath);
    const timerIdentity = autoStarted
      ? { taskPath, startTime: autoStarted.session?.startTime }
      : await api.startTimer(taskPath);
    if (!await api.verifyTimer(taskPath, timerIdentity)) throw new Error("timer_not_verified");
    await confirmSession(state, sessionKey, timerIdentity);
    return { ...binding, timerIdentity };
  } catch (error) {
    await releaseSession(state, sessionKey);
    throw error;
  }
}

// A identidade do cronometro e o startTime lido do vault, e o vault e o mesmo
// arquivo para os dois backends: o plugin le pela API, o mtn le do disco. Por
// isso encerrar por um backend diferente do que iniciou nao afrouxa a
// verificacao -- e o que permite ao headless atender quando o Obsidian esta
// fechado. Os candidatos vem em ordem de preferencia, comecando pelo backend
// gravado no vinculo.
async function stopBoundTimer(candidates, binding) {
  const attempts = [];
  for (const { backend, api } of candidates) {
    try {
      if (await api.verifyTimer(binding.taskPath, binding.timerIdentity)) {
        await api.stopTimer(binding.taskPath);
        return { stopped: true, backend };
      }
      // Backend respondeu e nao reconheceu a identidade: ou o cronometro ja
      // fechou -- caso limpo -- ou quem esta correndo e outro. Na duvida o
      // timer fica vivo, mas a duvida vira registro.
      const foreign = (await api.getActiveTimers()).some((item) => (item.task?.id ?? item.task?.path) === binding.taskPath);
      return { stopped: false, backend, reason: foreign ? "timer_identity_mismatch" : "timer_already_closed" };
    } catch (error) {
      attempts.push(`${backend}:${error.message}`);
    }
  }
  return { stopped: false, reason: "no_backend_answered", attempts };
}

async function firstResponding(candidates, operation) {
  const attempts = [];
  for (const candidate of candidates) {
    try {
      await operation(candidate.api);
      return candidate;
    } catch (error) {
      attempts.push(`${candidate.backend}:${error.message}`);
    }
  }
  throw new Error(`no_backend_answered:${attempts.join(" ")}`);
}

const divergence = ({ sessionKey, binding, attempt }) => ({
  kind: "timer_not_stopped",
  at: new Date().toISOString(),
  sessionKey,
  vault: binding.vault,
  taskPath: binding.taskPath,
  timerIdentity: binding.timerIdentity ?? null,
  reason: attempt.reason,
  attempts: attempt.attempts ?? [],
});

const worthRecording = (attempt) => attempt.reason === "no_backend_answered" || attempt.reason === "timer_identity_mismatch";

export async function stopWork({ state, apis, sessionKey, status }) {
  const binding = await getBinding(state, sessionKey);
  if (!binding) return { ok: true, stopped: false };
  // Diferente do hook, `stop` e pedido explicito de mudar o status: se nenhum
  // backend responde, o status nao mudou e falhar alto preservando o vinculo e
  // o unico desfecho honesto.
  const responding = await firstResponding(apis, (api) => api.setStatus(binding.taskPath, status));
  const attempt = binding.timerIdentity
    ? await stopBoundTimer([responding, ...apis.filter((candidate) => candidate !== responding)], binding)
    : { stopped: false, reason: "timer_never_confirmed" };
  if (worthRecording(attempt)) await recordDivergence(state, divergence({ sessionKey, binding, attempt }));
  await releaseSession(state, sessionKey);
  return { ok: true, stopped: attempt.stopped, backend: attempt.backend ?? null, reason: attempt.reason ?? null };
}

export async function recoverWork({ state, api, sessionKey, vault, taskPath, stopTimer = false }) {
  const binding = await getBinding(state, sessionKey);
  if (!binding || binding.vault !== vault || binding.taskPath !== taskPath) throw new Error("recovery_binding_not_found");

  let timerStopped = false;
  if (stopTimer) {
    const activeTimer = (await api.getActiveTimers()).find((item) => (item.task?.id ?? item.task?.path) === taskPath);
    if (activeTimer) {
      if (!binding.timerIdentity || !await api.verifyTimer(taskPath, binding.timerIdentity)) throw new Error("timer_identity_mismatch");
      await api.stopTimer(taskPath);
      timerStopped = true;
    }
  }

  await recoverLease(state, `${vault}:${taskPath}`, sessionKey);
  return { taskPath, released: sessionKey, timerStopped };
}

export async function recoverOrphanTimer({ api, taskPath, startTime }) {
  const activeTimer = (await api.getActiveTimers()).find((item) => (item.task?.id ?? item.task?.path) === taskPath);
  if (!activeTimer) throw new Error("orphan_timer_not_active");
  if (activeTimer.session?.startTime !== startTime) throw new Error("orphan_timer_identity_mismatch");
  await api.stopTimer(taskPath);
  return { taskPath, startTime, timerStopped: true };
}

// Obsidian fechado e condicao esperada, nao erro. O encerramento nunca estoura:
// tenta parar o cronometro pelos backends disponiveis, registra em divergences o
// que nao conseguiu fazer e solta vinculo e lease de qualquer forma -- segurar a
// tarefa em nome de uma sessao morta era o dano silencioso do defeito.
export async function sessionEnd({ state, apis, sessionKey }) {
  const binding = await getBinding(state, sessionKey);
  if (!binding) return { ok: true, stopped: false };
  const attempt = binding.timerIdentity
    ? await stopBoundTimer(apis, binding)
    : { stopped: false, reason: "timer_never_confirmed" };
  if (worthRecording(attempt)) await recordDivergence(state, divergence({ sessionKey, binding, attempt }));
  await releaseSession(state, sessionKey);
  return { ok: true, stopped: attempt.stopped, backend: attempt.backend ?? null, reason: attempt.reason ?? null };
}
