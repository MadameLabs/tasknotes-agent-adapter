import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverOrphanTimer, recoverWork, startWork, stopWork, sessionEnd } from "../src/domain.mjs";
import { diagnoseState, openState } from "../src/state.mjs";

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-domain-"));
  const active = new Map();
  const calls = [];
  const api = {
    async getTask(path) { return { id: path, status: "to-do" }; },
    async setStatus(path, status) { calls.push(["status", path, status]); },
    async startTimer(path) { const identity = { taskPath: path, startTime: "now" }; active.set(path, identity); calls.push(["start", path]); return identity; },
    async stopTimer(path) { active.delete(path); calls.push(["stop", path]); },
    async verifyTimer(path, identity) { return active.get(path)?.startTime === identity?.startTime; },
    async getActiveTimers() { return [...active.entries()].map(([id, session]) => ({ task: { id }, session })); },
  };
  try { await run({ state: await openState(dir), api, calls, active }); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("starts, confirms and stops only its own timer", async () => {
  await fixture(async ({ state, api, calls }) => {
    await startWork({ state, api, sessionKey: "codex:a", vault: "ENGENHARIA", taskPath: "a" });
    await stopWork({ state, api, sessionKey: "codex:a", status: "pausa" });
    assert.deepEqual(calls, [["status", "a", "em-andamento"], ["start", "a"], ["status", "a", "pausa"], ["stop", "a"]]);
  });
});

test("never adopts an unowned active timer or changes status on session end", async () => {
  await fixture(async ({ state, api, active, calls }) => {
    active.set("a", { taskPath: "a", startTime: "other" });
    await assert.rejects(startWork({ state, api, sessionKey: "codex:a", vault: "ENGENHARIA", taskPath: "a" }), /unowned_active_timer/);
    await sessionEnd({ state, api, sessionKey: "codex:none" });
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
