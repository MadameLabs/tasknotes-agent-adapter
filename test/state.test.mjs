import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindSession, diagnoseState, openState, recoverLease, releaseSession } from "../src/state.mjs";

async function withState(run) {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-state-"));
  try { await run(await openState(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}

const binding = (sessionKey, taskPath) => ({
  sessionKey, vault: "ENGENHARIA", taskPath, backend: "desktop", timerIdentity: null,
  createdAt: "2026-08-19T00:00:00.000Z", confirmedAt: null,
});

test("allows separate tasks but rejects a competing lease", async () => {
  await withState(async (state) => {
    await bindSession(state, binding("codex:a", "06-tarefas/a.md"));
    await bindSession(state, binding("codex:b", "06-tarefas/b.md"));
    await assert.rejects(bindSession(state, binding("claude:c", "06-tarefas/a.md")), /task_leased/);
    assert.equal((await diagnoseState(state)).bindings.length, 2);
  });
});

test("release only removes its own binding and lease", async () => {
  await withState(async (state) => {
    await bindSession(state, binding("codex:a", "06-tarefas/a.md"));
    await releaseSession(state, "codex:a");
    assert.deepEqual(await diagnoseState(state), { bindings: [], leases: [], divergences: [] });
  });
});

test("fails closed on truncated state and requires the expected owner to recover", async () => {
  await withState(async (state) => {
    await writeFile(state.path, "{");
    await assert.rejects(openState(state.dir), /state_corrupt/);
    await writeFile(state.path, JSON.stringify({ bindings: {}, leases: { "ENGENHARIA:06-tarefas/a.md": "codex:a" }, divergences: [] }));
    const recovered = await openState(state.dir);
    await assert.rejects(recoverLease(recovered, "ENGENHARIA:06-tarefas/a.md", "claude:b"), /lease_owner_mismatch/);
    await recoverLease(recovered, "ENGENHARIA:06-tarefas/a.md", "codex:a");
    assert.equal((await diagnoseState(recovered)).leases.length, 0);
  });
});

test("writes complete JSON through an atomic rename", async () => {
  await withState(async (state) => {
    await bindSession(state, binding("codex:a", "06-tarefas/a.md"));
    const stored = JSON.parse(await readFile(state.path, "utf8"));
    assert.equal(stored.bindings["codex:a"].taskPath, "06-tarefas/a.md");
  });
});
