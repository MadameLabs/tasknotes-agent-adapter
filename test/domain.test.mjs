import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverOrphanTimer, recoverWork, startWork, stopWork, sessionEnd } from "../src/domain.mjs";
import { diagnoseState, openState } from "../src/state.mjs";

// Os dois backends veem o mesmo vault -- o timer e o mesmo arquivo, leia-o o
// plugin ou o mtn --, e por isso compartilham `active` e `calls`. O que muda
// entre eles e a disponibilidade: `down` derruba so aquele caminho, que e
// exatamente o que o Obsidian fechado faz com o desktop.
function fakeBackend({ name, active, calls }) {
  const backend = { name, down: false, autoStart: false, seen: [] };
  const guard = () => { if (backend.down) throw new Error("fetch failed"); };
  const record = (entry) => { calls.push(entry); backend.seen.push(entry); };
  backend.api = {
    async getTask(path) { guard(); return { id: path, status: "to-do" }; },
    async setStatus(path, status) {
      guard();
      record(["status", path, status]);
      // "Auto-start time tracking" do TaskNotes: e a propria mudanca de status
      // que dispara o cronometro, sem ninguem pedir.
      if (backend.autoStart && status === "em-andamento" && !active.has(path)) active.set(path, { taskPath: path, startTime: "auto" });
    },
    async startTimer(path) {
      guard();
      if (active.has(path)) throw new Error("mtn_failed:Timer already running");
      const identity = { taskPath: path, startTime: "now" };
      active.set(path, identity);
      record(["start", path]);
      return identity;
    },
    async stopTimer(path) { guard(); active.delete(path); record(["stop", path]); },
    async verifyTimer(path, identity) { guard(); return active.get(path)?.startTime === identity?.startTime; },
    async getActiveTimers() { guard(); return [...active.entries()].map(([id, session]) => ({ task: { id }, session })); },
  };
  return backend;
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-domain-"));
  const active = new Map();
  const calls = [];
  const desktop = fakeBackend({ name: "desktop", active, calls });
  const headless = fakeBackend({ name: "headless", active, calls });
  const apis = [{ backend: "desktop", api: desktop.api }, { backend: "headless", api: headless.api }];
  try {
    await run({ state: await openState(dir), api: desktop.api, apis, desktop, headless, calls, active });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("starts, confirms and stops only its own timer", async () => {
  await fixture(async ({ state, api, apis, calls }) => {
    await startWork({ state, api, sessionKey: "codex:a", vault: "ENGENHARIA", taskPath: "a" });
    await stopWork({ state, apis, sessionKey: "codex:a", status: "pausa" });
    assert.deepEqual(calls, [["status", "a", "em-andamento"], ["start", "a"], ["status", "a", "pausa"], ["stop", "a"]]);
  });
});

test("never adopts an unowned active timer or changes status on session end", async () => {
  await fixture(async ({ state, api, apis, active, calls }) => {
    active.set("a", { taskPath: "a", startTime: "other" });
    await assert.rejects(startWork({ state, api, sessionKey: "codex:a", vault: "ENGENHARIA", taskPath: "a" }), /unowned_active_timer/);
    await sessionEnd({ state, apis, sessionKey: "codex:none" });
    assert.deepEqual(calls, []);
  });
});

test("rejects another session's lease without mutating the backend", async () => {
  await fixture(async ({ state, api, calls }) => {
    await startWork({ state, api, sessionKey: "codex:a", vault: "ENGENHARIA", taskPath: "a" });
    calls.length = 0;
    await assert.rejects(startWork({ state, api, sessionKey: "claude:b", vault: "ENGENHARIA", taskPath: "a" }), /task_leased/);
    assert.deepEqual(calls, []);
  });
});

test("recovers the owning session by stopping only its identified timer", async () => {
  await fixture(async ({ state, api, calls, active }) => {
    await startWork({ state, api, sessionKey: "codex:orfa", vault: "ENGENHARIA", taskPath: "a" });
    calls.length = 0;

    const recovered = await recoverWork({
      state,
      api,
      sessionKey: "codex:orfa",
      vault: "ENGENHARIA",
      taskPath: "a",
      stopTimer: true,
    });

    assert.deepEqual(recovered, { taskPath: "a", released: "codex:orfa", timerStopped: true });
    assert.equal(active.has("a"), false);
    assert.deepEqual(calls, [["stop", "a"]]);
    assert.deepEqual(await diagnoseState(state), { bindings: [], leases: [], divergences: [] });
  });
});

test("refuses recovery when the active timer identity differs from the binding", async () => {
  await fixture(async ({ state, api, calls, active }) => {
    await startWork({ state, api, sessionKey: "codex:orfa", vault: "ENGENHARIA", taskPath: "a" });
    active.set("a", { taskPath: "a", startTime: "other" });
    calls.length = 0;

    await assert.rejects(recoverWork({
      state,
      api,
      sessionKey: "codex:orfa",
      vault: "ENGENHARIA",
      taskPath: "a",
      stopTimer: true,
    }), /timer_identity_mismatch/);

    assert.deepEqual(calls, []);
    assert.equal((await diagnoseState(state)).leases.length, 1);
    assert.equal(active.get("a")?.startTime, "other");
  });
});

test("releases the owner without stopping when its timer has already ended", async () => {
  await fixture(async ({ state, api, calls, active }) => {
    await startWork({ state, api, sessionKey: "codex:orfa", vault: "ENGENHARIA", taskPath: "a" });
    active.clear();
    calls.length = 0;

    const recovered = await recoverWork({
      state,
      api,
      sessionKey: "codex:orfa",
      vault: "ENGENHARIA",
      taskPath: "a",
      stopTimer: true,
    });

    assert.deepEqual(recovered, { taskPath: "a", released: "codex:orfa", timerStopped: false });
    assert.deepEqual(calls, []);
    assert.deepEqual(await diagnoseState(state), { bindings: [], leases: [], divergences: [] });
  });
});

test("preserves the legacy recover behavior without the stop-timer option", async () => {
  await fixture(async ({ state, api, calls, active }) => {
    await startWork({ state, api, sessionKey: "codex:orfa", vault: "ENGENHARIA", taskPath: "a" });
    calls.length = 0;

    const recovered = await recoverWork({
      state,
      api,
      sessionKey: "codex:orfa",
      vault: "ENGENHARIA",
      taskPath: "a",
    });

    assert.deepEqual(recovered, { taskPath: "a", released: "codex:orfa", timerStopped: false });
    assert.equal(active.has("a"), true);
    assert.deepEqual(calls, []);
  });
});

test("stops an orphan timer only when its explicit start time matches", async () => {
  await fixture(async ({ api, calls, active }) => {
    active.set("a", { taskPath: "a", startTime: "2026-08-25T00:38:40.856Z" });

    const recovered = await recoverOrphanTimer({
      api,
      taskPath: "a",
      startTime: "2026-08-25T00:38:40.856Z",
    });

    assert.deepEqual(recovered, { taskPath: "a", startTime: "2026-08-25T00:38:40.856Z", timerStopped: true });
    assert.equal(active.has("a"), false);
    assert.deepEqual(calls, [["stop", "a"]]);
  });
});

test("refuses to stop an orphan timer when the explicit identity differs", async () => {
  await fixture(async ({ api, calls, active }) => {
    active.set("a", { taskPath: "a", startTime: "other" });

    await assert.rejects(recoverOrphanTimer({
      api,
      taskPath: "a",
      startTime: "2026-08-25T00:38:40.856Z",
    }), /orphan_timer_identity_mismatch/);

    assert.equal(active.get("a")?.startTime, "other");
    assert.deepEqual(calls, []);
  });
});

test("refuses to stop an orphan timer that is no longer active", async () => {
  await fixture(async ({ api, calls }) => {
    await assert.rejects(recoverOrphanTimer({
      api,
      taskPath: "a",
      startTime: "2026-08-25T00:38:40.856Z",
    }), /orphan_timer_not_active/);

    assert.deepEqual(calls, []);
  });
});

// O defeito reproduzido em 2026-09-08: sessao vinculada, Obsidian fechado, e o
// `verifyTimer` do desktop estourando antes de qualquer liberacao. O timer e o
// mesmo arquivo do vault, entao o headless verifica e para com a mesma
// honestidade -- o fallback nao passa por cima da duvida, ele desfaz a duvida.
test("session end stops through the headless backend when the bound one is down", async () => {
  await fixture(async ({ state, api, apis, desktop, headless, active }) => {
    await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a", backend: "desktop" });
    desktop.down = true;

    const result = await sessionEnd({ state, apis, sessionKey: "claude:a" });

    assert.equal(result.stopped, true);
    assert.equal(result.backend, "headless");
    assert.equal(active.has("a"), false);
    assert.deepEqual(headless.seen, [["stop", "a"]]);
    assert.deepEqual(await diagnoseState(state), { bindings: [], leases: [], divergences: [] });
  });
});

// Obsidian fechado e o mtn mudo e condicao esperada, nao erro: o encerramento
// solta vinculo e lease -- que era o dano silencioso -- e registra em
// divergences o cronometro que ficou aberto, em vez de sair com codigo 2.
test("session end releases the lease and records a divergence when no backend answers", async () => {
  await fixture(async ({ state, api, apis, desktop, headless, active }) => {
    await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a", backend: "desktop" });
    desktop.down = true;
    headless.down = true;

    const result = await sessionEnd({ state, apis, sessionKey: "claude:a" });

    assert.equal(result.stopped, false);
    assert.equal(active.has("a"), true);
    const { bindings, leases, divergences } = await diagnoseState(state);
    assert.deepEqual(bindings, []);
    assert.deepEqual(leases, []);
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0].reason, "no_backend_answered");
    assert.equal(divergences[0].taskPath, "a");
    assert.equal(divergences[0].sessionKey, "claude:a");
    assert.deepEqual(divergences[0].timerIdentity, { taskPath: "a", startTime: "now" });
  });
});

test("session end reports a foreign timer instead of stopping it", async () => {
  await fixture(async ({ state, api, apis, active, calls }) => {
    await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a", backend: "desktop" });
    active.set("a", { taskPath: "a", startTime: "other" });
    calls.length = 0;

    const result = await sessionEnd({ state, apis, sessionKey: "claude:a" });

    assert.equal(result.stopped, false);
    assert.deepEqual(calls, []);
    assert.equal(active.get("a")?.startTime, "other");
    const { bindings, divergences } = await diagnoseState(state);
    assert.deepEqual(bindings, []);
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0].reason, "timer_identity_mismatch");
  });
});

test("session end stays silent when the timer had already been closed", async () => {
  await fixture(async ({ state, api, apis, active, calls }) => {
    await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a", backend: "desktop" });
    active.clear();
    calls.length = 0;

    const result = await sessionEnd({ state, apis, sessionKey: "claude:a" });

    assert.equal(result.stopped, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(await diagnoseState(state), { bindings: [], leases: [], divergences: [] });
  });
});

// O buraco nao era so do hook: o `stop` explicito tambem chamava um backend so.
test("explicit stop falls back to the headless backend for status and timer", async () => {
  await fixture(async ({ state, api, apis, desktop, headless, active }) => {
    await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a", backend: "desktop" });
    desktop.down = true;
    headless.seen.length = 0;

    const result = await stopWork({ state, apis, sessionKey: "claude:a", status: "aprovacao" });

    assert.equal(result.stopped, true);
    assert.deepEqual(headless.seen, [["status", "a", "aprovacao"], ["stop", "a"]]);
    assert.equal(active.has("a"), false);
    assert.deepEqual(await diagnoseState(state), { bindings: [], leases: [], divergences: [] });
  });
});

// Diferente do hook, o `stop` e pedido explicito de mudar o status: quando
// nenhum backend responde o status nao mudou, entao falhar alto e preservar o
// vinculo e o unico desfecho honesto -- a pessoa repete o comando depois.
test("explicit stop keeps binding and lease when no backend answers", async () => {
  await fixture(async ({ state, api, apis, desktop, headless, active }) => {
    await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a", backend: "desktop" });
    desktop.down = true;
    headless.down = true;

    await assert.rejects(stopWork({ state, apis, sessionKey: "claude:a", status: "concluido" }), /no_backend_answered/);

    const { bindings, leases } = await diagnoseState(state);
    assert.equal(bindings.length, 1);
    assert.equal(leases.length, 1);
    assert.equal(active.has("a"), true);
  });
});

// O `start` disputava com o proprio efeito colateral: `setStatus` disparava o
// auto-start do plugin e o `startTimer` seguinte morria com "Timer already
// running". O vinculo era desfeito e o cronometro ficava correndo sem dono --
// aconteceu duas vezes ao abrir a sessao de 2026-09-08.
test("adopts the timer the plugin auto-started from its own status change", async () => {
  await fixture(async ({ state, api, desktop, active, calls }) => {
    desktop.autoStart = true;

    const binding = await startWork({ state, api, sessionKey: "claude:a", vault: "ENGENHARIA", taskPath: "a" });

    assert.deepEqual(binding.timerIdentity, { taskPath: "a", startTime: "auto" });
    assert.deepEqual(calls, [["status", "a", "em-andamento"]]);
    assert.equal(active.get("a")?.startTime, "auto");
    const { bindings } = await diagnoseState(state);
    assert.equal(bindings[0].timerIdentity.startTime, "auto");
    assert.ok(bindings[0].confirmedAt);
  });
});
