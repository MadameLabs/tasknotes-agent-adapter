import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { lastActivity, retimeEntries } from "../src/time-entries.mjs";
import { mtn } from "./mtn-path.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const run = promisify(execFile);
const entries = [
  { startTime: "2026-10-12T10:00:00.000Z", endTime: "2026-10-12T11:00:00.000Z" },
  { startTime: "2026-10-12T17:57:02.436Z", endTime: "2026-10-13T10:42:50.699Z" },
];

test("retime moves the end of the entry named by its start time", () => {
  const result = retimeEntries(entries, { startTime: "2026-10-12T17:57:02.436Z", newEnd: "2026-10-12T18:07:08.457Z" });
  assert.equal(result.entries[1].endTime, "2026-10-12T18:07:08.457Z");
  assert.equal(result.previous.endTime, "2026-10-13T10:42:50.699Z");
  assert.deepEqual(result.entries[0], entries[0]);
});

test("retime refuses what would lie about the history", () => {
  const attempt = (change) => assert.throws(() => retimeEntries(entries, change));
  attempt({ startTime: "2026-10-12T09:00:00.000Z", newEnd: "2026-10-12T09:30:00.000Z" }); // entrada inexistente
  attempt({ startTime: "2026-10-12T17:57:02.436Z", newEnd: "2026-10-12T17:00:00.000Z" }); // fim antes do inicio
  attempt({ startTime: "2026-10-12T17:57:02.436Z", newStart: "2026-10-12T10:30:00.000Z" }); // sobreposicao
  attempt({ startTime: "2026-10-12T17:57:02.436Z", newEnd: "2999-01-01T00:00:00.000Z" }); // futuro
  attempt({ startTime: "2026-10-12T17:57:02.436Z" }); // nada a mudar
  assert.throws(() => retimeEntries([{ startTime: "2026-10-12T10:00:00.000Z" }], { startTime: "2026-10-12T10:00:00.000Z", newEnd: "2026-10-12T11:00:00.000Z" }), /time_entry_still_open/);
});

test("last activity ignores records written without anyone working", async () => {
  const home = await mkdtemp(join(tmpdir(), "tasknotes-agent-home-"));
  try {
    await mkdir(join(home, ".claude", "projects", "-proj"), { recursive: true });
    await writeFile(join(home, ".claude", "projects", "-proj", "abc.jsonl"), [
      { type: "user", timestamp: "2026-10-12T17:00:00.000Z" },
      { type: "assistant", timestamp: "2026-10-12T18:07:08.457Z" },
      { type: "system", subtype: "away_summary", timestamp: "2026-10-12T18:10:13.558Z" },
    ].map((line) => JSON.stringify(line)).join("\n"));
    await mkdir(join(home, ".codex", "sessions", "2026", "10", "07"), { recursive: true });
    await writeFile(join(home, ".codex", "sessions", "2026", "10", "07", "rollout-x-def.jsonl"), [
      { type: "response_item", timestamp: "2026-10-08T00:30:00.000Z", payload: { type: "message" } },
      { type: "event_msg", timestamp: "2026-10-08T00:31:00.000Z", payload: { type: "task_complete" } },
      { type: "event_msg", timestamp: "2026-10-09T00:08:27.980Z", payload: { type: "thread_settings_applied" } },
    ].map((line) => JSON.stringify(line)).join("\n"));

    assert.equal((await lastActivity({ agent: "claude", sessionId: "abc", home })).lastActivity, "2026-10-12T18:07:08.457Z");
    assert.equal((await lastActivity({ agent: "codex", sessionId: "def", home })).lastActivity, "2026-10-08T00:31:00.000Z");
    await assert.rejects(lastActivity({ agent: "claude", sessionId: "nenhuma", home }), /transcript_not_found/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fix-time rewrites one closed entry in a real collection and keeps the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-fix-time-"));
  const vault = join(dir, "vault");
  const config = join(dir, "config.json");
  try {
    assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
    await mkdir(join(vault, "06-tarefas"));
    const note = join(vault, "06-tarefas", "Alvo.md");
    await writeFile(note, [
      "---", "title: Alvo", "status: pausa", "tags:", "  - task", "timeEntries:",
      ...entries.flatMap((entry) => [`  - startTime: '${entry.startTime}'`, `    endTime: '${entry.endTime}'`]),
      "---", "Corpo.", "",
    ].join("\n"));
    await writeFile(config, JSON.stringify({
      workspace: "ux-design", vault: "ATELIE", vaultPath: vault, defaultResponsavel: "arthur",
      defaultBackend: "headless", headless: { mtnPath: mtn }, stateDir: join(dir, "state"),
    }));
    const cmd = (...args) => run(process.execPath, [cli, ...args, "--config", config])
      .then(({ stdout }) => JSON.parse(stdout))
      .catch((error) => JSON.parse(error.stdout));

    assert.equal((await cmd("fix-time", "06-tarefas/Alvo.md", "--entry", entries[1].startTime, "--end", "2026-10-12T18:07:08.457Z")).error, "missing_reason");
    const fixed = await cmd("fix-time", "06-tarefas/Alvo.md", "--entry", entries[1].startTime, "--end", "2026-10-12T18:07:08.457Z", "--reason", "sessão morreu");
    assert.equal(fixed.ok, true, JSON.stringify(fixed));
    assert.equal(fixed.result.previous.endTime, entries[1].endTime);

    const written = await readFile(note, "utf8");
    assert.match(written, /endTime: '?2026-10-12T18:07:08.457Z/);
    assert.doesNotMatch(written, /2026-10-13T10:42:50/);
    assert.match(written, /endTime: '?2026-10-12T11:00:00.000Z/);
    assert.match(written, /Corpo\./);

    const timers = await cmd("diagnose", "--timers");
    assert.deepEqual(timers.result.openTimers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
