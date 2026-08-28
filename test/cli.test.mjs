import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = new URL("../src/cli.mjs", import.meta.url);
const mtn = process.env.MTN_PATH ?? fileURLToPath(new URL("../../repos/mdbase-tasknotes/dist/cli.js", import.meta.url));
const sessionStartWrapper = fileURLToPath(new URL("../../scripts/tasknotes-session-start.ps1", import.meta.url));
const codexHooks = fileURLToPath(new URL("../../.codex/hooks.json", import.meta.url));
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
  try { await callback({ config, dir, calls, timers }); }
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
    assert.match(output.hookSpecificOutput.additionalContext, /cli\.mjs promote/);
    assert.match(output.hookSpecificOutput.additionalContext, /--backend headless/);
    assert.match(output.hookSpecificOutput.additionalContext, /dispensar/i);
    assert.match(output.hookSpecificOutput.additionalContext, /a cada mensagem/i);
    assert.match(output.hookSpecificOutput.additionalContext, /artefato durável/i);
    assert.match(output.hookSpecificOutput.additionalContext, /detectar.*materializar.*promover.*iniciar.*concluir.*avançar/i);
    assert.match(output.hookSpecificOutput.additionalContext, /Plan Mode.*não.*tarefa|não.*tarefa.*Plan Mode/i);
    assert.match(output.hookSpecificOutput.additionalContext, /fase terminada.*concluido/i);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Antes de trabalhar.*pergunte em qual tarefa atuar/i);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /aprova[cç][aã]o.*desfecho normal/i);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /timer_cli|bridge\.timer_cli/);
  });
});

test("SessionStart tells a bound session how to advance to the next artifact", async () => {
  await fixture(async ({ config, dir }) => {
    const env = { ...process.env, LOCALAPPDATA: dir };
    const started = spawnSync(process.execPath, [
      fileURLToPath(cli), "start", "06-tarefas/CRM.md",
      "--agent", "codex", "--session", "bound", "--config", config,
    ], { encoding: "utf8", env });
    assert.equal(started.status, 0, started.stdout + started.stderr);

    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env,
      input: JSON.stringify({ session_id: "bound", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /sessão vinculada/i);
    assert.match(context, /nova fase/i);
    assert.match(context, /stop .*--status concluido/i);
    assert.match(context, /próximo artefato/i);
  });
});

test("Codex SessionStart identifies its required hook event", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "abc", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /gate TaskNotes/i);
  });
});

test("headless SessionStart injects commands for the headless backend", async () => {
  await fixture(async ({ config, dir }) => {
    const localConfig = JSON.parse(await readFile(config, "utf8"));
    await writeFile(config, JSON.stringify({ ...localConfig, defaultBackend: "headless" }));
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "headless", cwd: "/workspace" }),
    });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /execute node .* open --backend headless/);
    assert.match(context, /open --backend headless/);
    assert.match(context, /start "CAMINHO_EXATO" .*--backend headless/);
    assert.match(context, /cria[cç][aã]o direta.*n[aã]o.*suportada/i);
  });
});

test("Codex SessionStart hook runs from a new workspace path", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-portable-hook-"));
  try {
    await mkdir(join(dir, "bin"));
    await symlink(process.execPath, join(dir, "bin", "node"));
    await symlink(fileURLToPath(new URL("..", cli)), join(dir, "agent-adapter"));
    await writeFile(join(dir, "config.agent.local.json"), JSON.stringify({
      workspace: "madamelabs-code",
      vault: "ENGENHARIA",
      vaultPath: join(dir, "ENGENHARIA"),
      defaultResponsavel: "arthur",
      desktop: { baseUrl: "http://127.0.0.1:1", authToken: "token" },
      headless: { mtnPath: "mtn" },
      stateDir: join(dir, "state"),
    }));
    const hooks = JSON.parse(await readFile(codexHooks, "utf8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    const result = spawnSync("sh", ["-c", command], {
      cwd: dir,
      encoding: "utf8",
      input: JSON.stringify({ session_id: "portable", cwd: dir }),
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("promote turns an existing planning note into a headless task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-promote-"));
  const vault = join(dir, "vault");
  const config = join(dir, "config.json");
  try {
    assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
    await mkdir(join(vault, "01-planejamento"));
    await writeFile(join(vault, "01-planejamento", "Brainstorm.md"), "---\ntitle: Brainstorm\n---\n");
    await writeFile(config, JSON.stringify({
      workspace: "madamelabs-code",
      vault: "ENGENHARIA",
      vaultPath: vault,
      defaultResponsavel: "arthur",
      desktop: { baseUrl: "http://127.0.0.1:1", authToken: "token" },
      headless: { mtnPath: mtn },
      stateDir: join(dir, "state"),
    }));

    const promoted = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "promote", "01-planejamento/Brainstorm.md",
      "--responsavel", "arthur", "--marca", "Madame_Labs", "--projeto", "tasknotes-dual-vault-e-adaptador",
      "--backend", "headless", "--config", config])).stdout);

    assert.deepEqual(promoted, { ok: true, result: { taskPath: "01-planejamento/Brainstorm.md" } });
    const note = await (await import("node:fs/promises")).readFile(join(vault, "01-planejamento", "Brainstorm.md"), "utf8");
    assert.match(note, /- task/);
    assert.match(note, /Responsavel:/);
    assert.match(note, /Marca:/);
    assert.match(note, /Projeto:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("recover --stop-timer stops the owned timer without changing task status", async () => {
  await fixture(async ({ config, calls }) => {
    const args = ["--agent", "codex", "--session", "orfa", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);
    calls.length = 0;

    const recovered = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "recover", "01-planejamento/plano.md", "--stop-timer", ...args,
    ])).stdout);

    assert.deepEqual(recovered.result, {
      taskPath: "01-planejamento/plano.md",
      released: "codex:orfa",
      timerStopped: true,
    });
    assert.equal(calls.filter((call) => call.url.endsWith("/time/stop")).length, 1);
    assert.equal(calls.some((call) => call.method === "PUT" && call.body?.status), false);
    const state = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "diagnose", "--config", config])).stdout);
    assert.deepEqual(state.result, { bindings: [], leases: [], divergences: [] });
  });
});

test("recover --stop-timer refuses when the session no longer has a binding", async () => {
  await fixture(async ({ config, calls }) => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(cli), "recover", "01-planejamento/plano.md", "--stop-timer",
      "--agent", "codex", "--session", "ausente", "--config", config,
    ], { encoding: "utf8" });

    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error, "recovery_binding_not_found");
    assert.equal(calls.some((call) => call.url.endsWith("/time/stop")), false);
  });
});

test("recover --stop-timer preserves state when the timer identity diverges", async () => {
  await fixture(async ({ config, calls, timers }) => {
    const args = ["--agent", "codex", "--session", "orfa", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);
    timers[0].session.startTime = "other";
    calls.length = 0;

    await assert.rejects(
      run(process.execPath, [fileURLToPath(cli), "recover", "01-planejamento/plano.md", "--stop-timer", ...args]),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).error, "timer_identity_mismatch");
        return true;
      },
    );
    assert.equal(calls.some((call) => call.url.endsWith("/time/stop")), false);
    const state = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "diagnose", "--config", config])).stdout);
    assert.equal(state.result.leases.length, 1);
  });
});

test("a new session starts the same task after a successful timer recovery", async () => {
  await fixture(async ({ config, calls }) => {
    const orphan = ["--agent", "codex", "--session", "orfa", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...orphan]);
    await run(process.execPath, [
      fileURLToPath(cli), "recover", "01-planejamento/plano.md", "--stop-timer", ...orphan,
    ]);
    calls.length = 0;

    const started = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "start", "01-planejamento/plano.md",
      "--agent", "codex", "--session", "nova", "--config", config,
    ])).stdout);

    assert.equal(started.result.sessionKey, "codex:nova");
    assert.equal(calls.filter((call) => call.url.endsWith("/time/start")).length, 1);
  });
});

test("recover-orphan stops a timer whose released binding no longer exists", async () => {
  await fixture(async ({ config, calls }) => {
    const args = ["--agent", "codex", "--session", "orfa", "--config", config];
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md", ...args]);
    await run(process.execPath, [fileURLToPath(cli), "recover", "01-planejamento/plano.md", ...args]);
    calls.length = 0;

    const recovered = JSON.parse((await run(process.execPath, [
      fileURLToPath(cli), "recover-orphan", "01-planejamento/plano.md",
      "--start-time", "2026-08-21T00:00:00.000Z", "--stop-timer", "--config", config,
    ])).stdout);

    assert.deepEqual(recovered.result, {
      taskPath: "01-planejamento/plano.md",
      startTime: "2026-08-21T00:00:00.000Z",
      timerStopped: true,
    });
    assert.equal(calls.filter((call) => call.url.endsWith("/time/stop")).length, 1);
    assert.equal(calls.some((call) => call.method === "PUT" && call.body?.status), false);
  });
});

test("recover-orphan requires both an explicit identity and stop confirmation", async () => {
  await fixture(async ({ config }) => {
    const missingIdentity = spawnSync(process.execPath, [
      fileURLToPath(cli), "recover-orphan", "01-planejamento/plano.md", "--stop-timer", "--config", config,
    ], { encoding: "utf8" });
    assert.equal(missingIdentity.status, 2);
    assert.equal(JSON.parse(missingIdentity.stdout).error, "missing_orphan_timer_identity");

    const missingConfirmation = spawnSync(process.execPath, [
      fileURLToPath(cli), "recover-orphan", "01-planejamento/plano.md",
      "--start-time", "2026-08-21T00:00:00.000Z", "--config", config,
    ], { encoding: "utf8" });
    assert.equal(missingConfirmation.status, 2);
    assert.equal(JSON.parse(missingConfirmation.stdout).error, "missing_stop_timer_confirmation");
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

test("a backend failure reports the reason instead of a fixed sentence", async () => {
  // O catch final cortava tudo depois do primeiro ":" e trocava a causa por
  // uma frase generica, entao "File not found" nunca chegava a quem chamou.
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-reason-"));
  try {
    const fake = join(dir, "fake-mtn.mjs");
    await writeFile(fake, `console.log('\u001b[31m✗ Failed to read task: File not found: alvo.md\u001b[39m'); process.exit(1);`);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      workspace: "teste", vault: "V", vaultPath: dir, defaultResponsavel: "Arthur_Cardoso",
      desktop: { baseUrl: "http://127.0.0.1:1", authToken: "x" },
      headless: { mtnPath: fake },
    }));

    const result = spawnSync(process.execPath, [
      fileURLToPath(cli), "set-status", "alvo.md", "--status", "pausa",
      "--backend", "headless", "--config", configPath,
    ], { encoding: "utf8" });

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "mtn_failed");
    assert.match(payload.message, /File not found: alvo\.md/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
