import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { closeOpenEntry, parseDuration } from "../src/time-entries.mjs";
import { mtn } from "./mtn-path.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const run = promisify(execFile);
const closedEntry = { startTime: "2026-10-12T10:00:00.000Z", endTime: "2026-10-12T11:00:00.000Z" };
const openEntry = { startTime: "2026-10-12T17:57:02.000Z" };
const now = new Date("2026-10-20T00:00:00.000Z");

test("close-timer closes the only open entry at a past instant", () => {
  const byEnd = closeOpenEntry([closedEntry, openEntry], { end: "2026-10-12T20:57:02.000Z", now });
  assert.equal(byEnd.updated.endTime, "2026-10-12T20:57:02.000Z");
  assert.deepEqual(byEnd.entries[0], closedEntry);
  assert.equal(closeOpenEntry([openEntry], { duration: "3h", now }).updated.endTime, "2026-10-12T20:57:02.000Z");
  assert.equal(parseDuration("1h30m"), 90 * 60000);
});

test("close-timer refuses what would lie about the history", () => {
  const refuse = (list, change, code) => assert.throws(() => closeOpenEntry(list, { now, ...change }), new RegExp(code));
  refuse([closedEntry], { end: "2026-10-12T20:00:00.000Z" }, "no_open_time_entry");
  refuse([{ startTime: "2026-10-12T10:00:00.000Z" }, { startTime: "2026-10-12T12:00:00.000Z" }], { duration: "1h" }, "multiple_open_time_entries");
  refuse([openEntry], { end: "2026-10-12T17:00:00.000Z" }, "end_not_after_start");
  refuse([openEntry], { end: "2026-10-21T00:00:00.000Z" }, "end_in_future");
  refuse([openEntry], {}, "end_or_duration_required");
  refuse([openEntry], { end: "2026-10-12T20:00:00.000Z", duration: "1h" }, "end_or_duration_required");
  refuse([openEntry], { duration: "tres horas" }, "invalid_duration");
  refuse([{ startTime: "2026-10-12T10:00:00.000Z", endTime: "2026-10-12T19:00:00.000Z" }, openEntry], { end: "2026-10-12T20:00:00.000Z" }, "time_entry_overlap");
});

test("close-timer writes the entry in a real collection, checks the owner and releases the binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-close-timer-"));
  const vault = join(dir, "vault");
  const config = join(dir, "config.json");
  const stateDir = join(dir, "state");
  try {
    assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
    await mkdir(join(vault, "06-tarefas"));
    const note = join(vault, "06-tarefas", "Alvo.md");
    await writeFile(note, [
      "---", "title: Alvo", "status: em-andamento", "tags:", "  - task", "timeEntries:",
      `  - startTime: '${openEntry.startTime}'`, "---", "Corpo.", "",
    ].join("\n"));
    await writeFile(config, JSON.stringify({
      workspace: "ux-design", vault: "ATELIE", vaultPath: vault, defaultResponsavel: "arthur",
      defaultBackend: "headless", headless: { mtnPath: mtn }, stateDir,
    }));
    await mkdir(stateDir);
    const binding = { sessionKey: "claude:morta", vault: "ATELIE", taskPath: "06-tarefas/Alvo.md", backend: "headless", timerIdentity: { startTime: openEntry.startTime } };
    await writeFile(join(stateDir, "state.json"), JSON.stringify({
      bindings: { "claude:morta": binding }, leases: { "ATELIE:06-tarefas/Alvo.md": "claude:morta" }, divergences: [],
    }));
    const cmd = (...args) => run(process.execPath, [cli, ...args, "--config", config])
      .then(({ stdout }) => JSON.parse(stdout))
      .catch((error) => JSON.parse(error.stdout));

    assert.equal((await cmd("close-timer", "06-tarefas/Alvo.md", "--duration", "3h")).error, "task_bound_to_session");
    assert.equal((await cmd("close-timer", "06-tarefas/Alvo.md", "--duration", "3h", "--agent", "claude", "--session", "outra")).error, "task_bound_to_session");
    assert.equal((await cmd("close-timer", "06-tarefas/Alvo.md", "--force-owner")).error, "end_or_duration_required");
    assert.doesNotMatch(await readFile(note, "utf8"), /endTime/);

    const closed = await cmd("close-timer", "06-tarefas/Alvo.md", "--duration", "3h", "--status", "pausa", "--agent", "claude", "--session", "morta");
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.result.updated.endTime, "2026-10-12T20:57:02.000Z");
    assert.equal(closed.result.released, "claude:morta");
    const written = await readFile(note, "utf8");
    assert.match(written, /endTime: '?2026-10-12T20:57:02.000Z/);
    assert.match(written, /status: pausa/);
    assert.match(written, /Corpo\./);

    const after = await cmd("diagnose", "--timers");
    assert.deepEqual(after.result.openTimers, []);
    assert.deepEqual(after.result.bindings, []);
    assert.deepEqual(after.result.leases, []);
    assert.equal((await cmd("close-timer", "06-tarefas/Alvo.md", "--duration", "1h")).error, "no_open_time_entry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
