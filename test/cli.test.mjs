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
  const timers = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : undefined });
    const reply = (data) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ success: true, data })); };
    if (request.url === "/api/tasks?limit=200&offset=0") return reply({ tasks: [{ id: "06-tarefas/CRM.md", title: "CRM", status: "to-do" }], pagination: { hasMore: false } });
    if (request.url === "/api/tasks" && request.method === "POST") return reply({ id: "06-tarefas/Nova.md", title: "Nova" });
    if (request.url === "/api/time/active") return reply({ activeSessions: timers });
    if (request.url.endsWith("/time/start") && request.method === "POST") {
      timers.push({ task: { id: decodeURIComponent(request.url.slice("/api/tasks/".length, -"/time/start".length)) }, session: { startTime: "2026-08-21T00:00:00.000Z" } });
      return reply({});
    }
    if (request.url.endsWith("/time/stop") && request.method === "POST") { timers.length = 0; return reply({}); }
    if (request.url.startsWith("/api/tasks/") && request.method === "GET") return reply({ id: decodeURIComponent(request.url.slice("/api/tasks/".length)), status: "to-do" });
    if (request.url.startsWith("/api/tasks/") && request.method === "PUT") return reply({});
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
    stateDir: join(dir, "state"),
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
    assert.deepEqual(calls.find((call) => call.method === "PUT").body, { Responsavel: ["[[Arthur_Cardoso]]"], Marca: ["[[Madame_Labs]]"] });
  });
});

test("link-project attaches an existing task to one or more projects", async () => {
  await fixture(async ({ config, calls }) => {
    const linked = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "link-project", "01-planejamento/plano.md",
      "--projeto", "integracao-planejamento-agentes", "--projeto", "outro-projeto", "--config", config,
    ])).stdout);
    assert.equal(linked.ok, true);
    const put = calls.find((call) => call.method === "PUT" && call.url === "/api/tasks/01-planejamento%2Fplano.md");
    assert.deepEqual(put.body, { projects: ["[[integracao-planejamento-agentes]]", "[[outro-projeto]]"] });
  });
});

test("link-project refuses safely when the path or the project is missing", async () => {
  await fixture(async ({ config, calls }) => {
    const noProject = spawnSync(process.execPath, [fileURLToPath(cli), "link-project", "01-planejamento/plano.md", "--config", config], { encoding: "utf8" });
    assert.equal(noProject.status, 2);
    assert.equal(JSON.parse(noProject.stdout).ok, false);

    const noPath = spawnSync(process.execPath, [fileURLToPath(cli), "link-project", "--projeto", "algum", "--config", config], { encoding: "utf8" });
    assert.equal(noPath.status, 2);
    assert.equal(JSON.parse(noPath.stdout).ok, false);

    assert.equal(calls.some((call) => call.method === "PUT"), false);
  });
});

test("stop concludes the task only when an explicit status is given", async () => {
  await fixture(async ({ config, calls }) => {
    const args = ["--agent", "claude", "--session", "s1", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);
    const stopped = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "stop", "--status", "concluido", ...args,
    ])).stdout);
    assert.equal(stopped.result.stopped, true);

    const statuses = calls.filter((call) => call.method === "PUT" && call.body?.status).map((call) => call.body.status);
    assert.deepEqual(statuses, ["em-andamento", "concluido"]);
  });
});

test("stop without an explicit status refuses instead of inventing a desfecho", async () => {
  await fixture(async ({ config, calls }) => {
    const args = ["--agent", "claude", "--session", "s2", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);

    // O default antigo era pausa, que mentia sobre tarefa terminada. Agora a
    // recusa precisa preservar o timer, o vinculo e o status em-andamento.
    const refused = spawnSync(process.execPath, [fileURLToPath(cli), "stop", ...args], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.equal(JSON.parse(refused.stdout).error, "missing_or_invalid_status");

    const statuses = calls.filter((call) => call.method === "PUT" && call.body?.status).map((call) => call.body.status);
    assert.deepEqual(statuses, ["em-andamento"]);
    assert.equal(calls.some((call) => call.url.endsWith("/time/stop")), false);
  });
});

test("stop refuses an unsupported status without touching the timer", async () => {
  await fixture(async ({ config, calls }) => {
    const args = ["--agent", "claude", "--session", "s3", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);

    const refused = spawnSync(process.execPath, [fileURLToPath(cli), "stop", "--status", "arquivado", ...args], { encoding: "utf8" });
    assert.equal(refused.status, 2);
    assert.equal(JSON.parse(refused.stdout).error, "missing_or_invalid_status");
    assert.equal(calls.some((call) => call.url.endsWith("/time/stop")), false);
  });
});

test("recover releases only the lease whose owner is named explicitly", async () => {
  await fixture(async ({ config, calls }) => {
    const args = ["--agent", "claude", "--session", "orfa", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);

    // Dono errado nao libera nada: e a protecao contra roubar lease de outra sessao.
    const wrongOwner = spawnSync(process.execPath, [
      fileURLToPath(cli), "recover", "01-planejamento/plano.md", "--agent", "claude", "--session", "outra", "--config", config,
    ], { encoding: "utf8" });
    assert.equal(wrongOwner.status, 2);
    assert.equal(JSON.parse(wrongOwner.stdout).error, "lease_owner_mismatch");

    const stillThere = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "diagnose", "--config", config])).stdout);
    assert.equal(stillThere.result.leases.length, 1);

    const recovered = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "recover", "01-planejamento/plano.md", ...args,
    ])).stdout);
    assert.equal(recovered.ok, true);

    const empty = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "diagnose", "--config", config])).stdout);
    assert.deepEqual(empty.result.leases, []);
    assert.deepEqual(empty.result.bindings, []);

    // Recuperacao mexe so no estado local: nenhum timer pode ser parado por ela.
    assert.equal(calls.some((call) => call.url.endsWith("/time/stop")), false);
  });
});

test("recover refuses without an explicit task and session", async () => {
  await fixture(async ({ config }) => {
    for (const args of [
      ["recover", "--agent", "claude", "--session", "s", "--config", config],
      ["recover", "01-planejamento/plano.md", "--agent", "claude", "--config", config],
    ]) {
      const refused = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: "utf8" });
      assert.equal(refused.status, 2);
      assert.equal(JSON.parse(refused.stdout).error, "missing_session_or_task");
    }
  });
});

test("reset is not a real command and must not answer ok", async () => {
  await fixture(async ({ config }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "reset", "--config", config], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error, "unknown_command");
  });
});
