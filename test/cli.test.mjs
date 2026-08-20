import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = new URL("../src/cli.mjs", import.meta.url);
const sessionStartWrapper = fileURLToPath(new URL("../../scripts/tasknotes-session-start.ps1", import.meta.url));
const run = promisify(execFile);

async function fixture(callback) {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-cli-"));
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : undefined });
    const reply = (data) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ success: true, data })); };
    if (request.url === "/api/tasks?limit=200&offset=0") return reply({ tasks: [{ id: "06-tarefas/CRM.md", title: "CRM", status: "to-do" }], pagination: { hasMore: false } });
    if (request.url === "/api/tasks" && request.method === "POST") return reply({ id: "06-tarefas/Nova.md", title: "Nova" });
    if (request.url === "/api/tasks/06-tarefas%2FNova.md" && request.method === "PUT") return reply({});
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({
    workspace: "madamelabs-code",
    vault: "ENGENHARIA",
    vaultPath: "C:/madamelabs-code/ENGENHARIA",
    defaultResponsavel: "arthur",
    desktop: { baseUrl: `http://127.0.0.1:${server.address().port}`, authToken: "token" },
    headless: { mtnPath: "mtn" },
  }));
  try { await callback({ config, dir, calls }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("reports operational refusal as JSON without leaking configuration", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), "start"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: "missing_config", message: "--config is required" });
  assert.equal(result.stderr, "");
});

test("SessionStart injects an actionable Node-only task gate", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "claude", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "abc", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /gate TaskNotes/i);
    assert.match(output.hookSpecificOutput.additionalContext, /cli\.mjs open/);
    assert.match(output.hookSpecificOutput.additionalContext, /dispensar/i);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /timer_cli|bridge\.timer_cli/);
  });
});

test("Claude SessionEnd keeps the host event name", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-end", "--agent", "claude", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "abc", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionEnd");
  });
});

test("Claude wrapper forwards the raw hook payload to the Node adapter", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-wrapper-"));
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-File", sessionStartWrapper], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir, TASKNOTES_AGENT: "claude" },
      input: JSON.stringify({ session_id: "wrapper-smoke", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open and create execute against the TaskNotes API", async () => {
  await fixture(async ({ config, calls }) => {
    const opened = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "open", "--config", config])).stdout);
    assert.equal(opened.tasks[0].path, "06-tarefas/CRM.md");

    const created = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "create", "Nova", "--responsavel", "arthur", "--marca", "Madame_Labs", "--projeto", "CRM", "--config", config,
    ])).stdout);
    assert.equal(created.task.path, "06-tarefas/Nova.md");
    assert.deepEqual(calls.find((call) => call.method === "POST").body.projects, ["[[CRM]]"]);
    assert.deepEqual(calls.find((call) => call.method === "PUT").body, { Responsavel: ["arthur"], Marca: ["[[Madame_Labs]]"] });
  });
});
