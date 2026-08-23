import { bindSession, confirmSession, getBinding, releaseSession } from "./state.mjs";

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
    const timerIdentity = await api.startTimer(taskPath);
    if (!await api.verifyTimer(taskPath, timerIdentity)) throw new Error("timer_not_verified");
    await confirmSession(state, sessionKey, timerIdentity);
    return { ...binding, timerIdentity };
  } catch (error) {
    await releaseSession(state, sessionKey);
    throw error;
  }
}

export async function stopWork({ state, api, sessionKey, status }) {
  const binding = await getBinding(state, sessionKey);
  if (!binding) return { ok: true, stopped: false };
  await api.setStatus(binding.taskPath, status);
  if (binding.timerIdentity && await api.verifyTimer(binding.taskPath, binding.timerIdentity)) await api.stopTimer(binding.taskPath);
  await releaseSession(state, sessionKey);
  return { ok: true, stopped: true };
}

export async function sessionEnd({ state, api, sessionKey }) {
  const binding = await getBinding(state, sessionKey);
  if (!binding) return { ok: true, stopped: false };
  if (binding.timerIdentity && await api.verifyTimer(binding.taskPath, binding.timerIdentity)) await api.stopTimer(binding.taskPath);
  await releaseSession(state, sessionKey);
  return { ok: true, stopped: true };
}
