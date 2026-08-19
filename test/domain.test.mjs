import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWork, stopWork, sessionEnd } from "../src/domain.mjs";
import { openState } from "../src/state.mjs";

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
