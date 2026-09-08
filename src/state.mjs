import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STATE_FILE = "state.json";
const LOCK_FILE = "state.lock";
const emptyState = () => ({ bindings: {}, leases: {}, divergences: [] });
const taskKeyFor = ({ vault, taskPath }) => `${vault}:${taskPath}`;

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw new Error("state_corrupt", { cause: error });
  }
}

async function writeState(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function withLock(state, operation) {
  let lock;
  for (;;) {
    try {
      lock = await open(state.lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const data = await readState(state.path);
    const result = await operation(data);
    await writeState(state.path, data);
    return result;
  } finally {
    await lock.close();
    await rm(state.lockPath, { force: true });
  }
}

export async function openState(dir) {
  await mkdir(dir, { recursive: true });
  const state = { dir, path: join(dir, STATE_FILE), lockPath: join(dir, LOCK_FILE) };
  await readState(state.path);
  return state;
}

export async function bindSession(state, binding) {
  const taskKey = taskKeyFor(binding);
  return withLock(state, (data) => {
    const owner = data.leases[taskKey];
    if (owner && owner !== binding.sessionKey) throw new Error("task_leased");
    data.bindings[binding.sessionKey] = binding;
    data.leases[taskKey] = binding.sessionKey;
  });
}

export async function releaseSession(state, sessionKey) {
  return withLock(state, (data) => {
    const binding = data.bindings[sessionKey];
    if (!binding) return;
    const taskKey = taskKeyFor(binding);
    delete data.bindings[sessionKey];
    if (data.leases[taskKey] === sessionKey) delete data.leases[taskKey];
  });
}

export async function getBinding(state, sessionKey) {
  const data = await readState(state.path);
  return data.bindings[sessionKey] ?? null;
}

export async function confirmSession(state, sessionKey, timerIdentity) {
  return withLock(state, (data) => {
    if (!data.bindings[sessionKey]) throw new Error("binding_not_found");
    data.bindings[sessionKey] = { ...data.bindings[sessionKey], timerIdentity, confirmedAt: new Date().toISOString() };
  });
}

export async function recoverLease(state, taskKey, expectedSessionKey) {
  return withLock(state, (data) => {
    if (data.leases[taskKey] !== expectedSessionKey) throw new Error("lease_owner_mismatch");
    delete data.leases[taskKey];
    delete data.bindings[expectedSessionKey];
  });
}

// Divergencia e o que o adaptador sabe que nao conseguiu fazer: cronometro que
// ficou aberto porque nenhum backend respondeu, ou que pertence a outra
// identidade. O campo existia desde o inicio e nunca era escrito -- entao o
// encerramento com o Obsidian fechado nao deixava rastro nenhum.
export async function recordDivergence(state, divergence) {
  return withLock(state, (data) => {
    data.divergences = [...(data.divergences ?? []), divergence];
  });
}

export async function diagnoseState(state) {
  const data = await readState(state.path);
  return {
    bindings: Object.values(data.bindings),
    leases: Object.entries(data.leases).map(([taskKey, sessionKey]) => ({ taskKey, sessionKey })),
    divergences: data.divergences ?? [],
  };
}
