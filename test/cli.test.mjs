import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mtn } from "./mtn-path.mjs";
import { workspaceFile } from "./workspace.mjs";

const cli = new URL("../src/cli.mjs", import.meta.url);
const sessionStartWrapper = workspaceFile("scripts/tasknotes-session-start.sh");
const codexHooks = workspaceFile(".codex/hooks.json");
const run = promisify(execFile);

function runWithInput(command, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// Uma porta que ninguem escuta: o servidor sobe so para reservar o numero e cai
// antes de o teste usa-lo, que e como se parece o Obsidian fechado.
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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
    assert.match(output.hookSpecificOutput.additionalContext, /tasknotes-agent open --backend headless/);
    assert.match(output.hookSpecificOutput.additionalContext, /tasknotes-agent create .*--marca MARCA --projeto PROJETO --backend headless/);
    assert.match(output.hookSpecificOutput.additionalContext, /tasknotes-agent promote/);
    assert.match(output.hookSpecificOutput.additionalContext, /tasknotes-agent start .*--backend headless/);
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
    // spawnSync trava a event loop deste processo, que e quem hospeda o
    // servidor do fixture: o `start` do filho ficaria esperando uma conexao
    // que ninguem aceita. Comando que fala com a API vai por execFile async.
    await run(process.execPath, [
      fileURLToPath(cli), "start", "06-tarefas/CRM.md",
      "--agent", "codex", "--session", "bound", "--config", config,
    ], { env });

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
    assert.match(output.hookSpecificOutput.additionalContext, /agente decide o status/i);
    assert.match(output.hookSpecificOutput.additionalContext, /ambiguidade/i);
    assert.match(output.hookSpecificOutput.additionalContext, /aprovacao.*concluido.*cancelado.*pausa/i);
  });
});

test("SessionStart vinculado exige decisão contextual e status explícito", async () => {
  await fixture(async ({ config, dir }) => {
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md",
      "--agent", "codex", "--session", "vinculada", "--config", config]);
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "vinculada", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /agente decide o status/i);
    assert.match(context, /ambiguidade/i);
    assert.match(context, /--status STATUS/);
    assert.match(context, /aprovacao.*concluido.*cancelado.*pausa/i);
  });
});

test("headless SessionStart mantém os comandos explicitamente headless", async () => {
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
    assert.match(context, /open --backend headless/);
    assert.match(context, /create .*--backend headless/);
    assert.match(context, /start "CAMINHO_EXATO" .*--backend headless/);
    assert.match(context, /agente decide o status/i);
  });
});

// O gate nomeia o workspace da sessao. Ele ja esteve escrito no codigo como
// "madamelabs-code", e a segunda vault -- a OFICINA -- passou a receber um
// gate que nomeava o hub errado.
test("the gate names the workspace from the config, not a hardcoded one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-workspace-"));
  try {
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({
      workspace: "OFICINA_Madame-Labs",
      vault: "BIBLIOTECA",
      vaultPath: dir,
      defaultResponsavel: "arthur",
      desktop: { baseUrl: "http://127.0.0.1:1", authToken: "token" },
      stateDir: join(dir, "state"),
    }));
    const { stdout } = await runWithInput(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "claude", "--config", config], {},
      JSON.stringify({ session_id: "workspace", cwd: dir }));
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Gate TaskNotes obrigatório no OFICINA_Madame-Labs\./);
    assert.doesNotMatch(context, /obrigatório no madamelabs-code/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// O teste abaixo roda so fora do Windows e so o primeiro hook do grupo, e foi
// por essa fresta que a barra invertida do activate-ponytail sobreviveu. Este
// aqui roda em todo lugar e olha todos: sh come a barra invertida, entao um
// comando de hooks.json que a contenha chega ao shell destrocado.
test("no Codex hook command carries a backslash for sh to eat", { skip: !codexHooks }, async () => {
  const hooks = JSON.parse(await readFile(codexHooks, "utf8"));
  for (const grupo of Object.values(hooks.hooks).flat()) {
    for (const { command } of grupo.hooks) {
      assert.ok(!command.includes("\\"), `barra invertida sobrevive ao sh em: ${command}`);
    }
  }
});

test("Codex SessionStart hook runs from a new workspace path", { skip: process.platform === "win32" || !codexHooks }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-portable-hook-"));
  try {
    await run("git", ["init", "-q"], { cwd: dir });
    await mkdir(join(dir, "scripts"));
    await mkdir(join(dir, ".codex"));
    await mkdir(join(dir, "subdir"));
    await mkdir(join(dir, "bin"));
    await symlink(process.execPath, join(dir, "bin", "node"));
    await symlink(fileURLToPath(cli), join(dir, "bin", "tasknotes-agent"));
    await writeFile(join(dir, "scripts", "tasknotes-session-start.sh"), await readFile(sessionStartWrapper));
    await writeFile(join(dir, ".codex", "hooks.json"), await readFile(codexHooks));
    await writeFile(join(dir, "config.agent.local.json"), JSON.stringify({
      workspace: "madamelabs-code",
      vault: "ENGENHARIA",
      vaultPath: join(dir, "ENGENHARIA"),
      defaultResponsavel: "arthur",
      desktop: { baseUrl: "http://127.0.0.1:1", authToken: "token" },
      headless: { mtnPath: "mtn" },
      stateDir: join(dir, "state"),
    }));
    const hooks = JSON.parse(await readFile(join(dir, ".codex", "hooks.json"), "utf8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    const result = spawnSync("sh", ["-c", command], {
      cwd: join(dir, "subdir"),
      encoding: "utf8",
      input: JSON.stringify({ session_id: "portable", cwd: join(dir, "subdir") }),
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses config defaultBackend when the command omits --backend", async () => {
  await fixture(async ({ config, dir }) => {
    const localConfig = JSON.parse(await readFile(config, "utf8"));
    const failingMtn = join(dir, "failing-mtn.mjs");
    await writeFile(failingMtn, "process.exit(17);\n");
    await writeFile(config, JSON.stringify({ ...localConfig, defaultBackend: "headless", headless: { mtnPath: failingMtn } }));
    const result = await run(process.execPath, [fileURLToPath(cli), "open", "--config", config])
      .then(({ stdout }) => ({ status: 0, output: JSON.parse(stdout) }))
      .catch((error) => ({ status: error.code, output: JSON.parse(error.stdout) }));
    assert.equal(result.status, 2);
    assert.equal(result.output.error, "mtn_failed");
  });
});

test("Claude SessionEnd keeps the host event name and stops injecting the gate", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-end", "--agent", "claude", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "abc", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionEnd");
    // Nao ha mais sessao para instruir: o gate no SessionEnd era heranca de
    // compartilhar caminho de codigo com o hook-start.
    assert.equal(output.hookSpecificOutput.additionalContext, undefined);
  });
});

test("Codex SessionEnd reports its configured event and leaves an unbound timer untouched", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-end", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "codex-unbound", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionEnd");
    assert.equal(output.result.stopped, false);
  });
});

test("Codex hook-end preserves the legacy Stop event", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-end", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "codex-legacy", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(output.result.stopped, false);
  });
});

test("Codex hook-end rejects an unknown host event", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-end", "--agent", "codex", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ hook_event_name: "Unexpected", session_id: "codex-invalid", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error, "invalid_hook_event");
  });
});

// O defeito de 2026-09-08: sessao vinculada e Obsidian fechado faziam o hook
// sair com 2, e vinculo e lease ficavam para tras segurando a tarefa.
test("Claude SessionEnd survives every backend being unreachable", async () => {
  await fixture(async ({ config, dir }) => {
    const env = { ...process.env, LOCALAPPDATA: dir };
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md",
      "--agent", "claude", "--session", "morta", "--config", config], { env });

    const live = JSON.parse(await readFile(config, "utf8"));
    const failingMtn = join(dir, "failing-mtn.mjs");
    await writeFile(failingMtn, "process.exit(17);");
    await writeFile(config, JSON.stringify({
      ...live,
      desktop: { ...live.desktop, baseUrl: `http://127.0.0.1:${await closedPort()}` },
      headless: { mtnPath: failingMtn },
    }));

    const result = await runWithInput(process.execPath, [
      fileURLToPath(cli), "hook-end", "--agent", "claude", "--config", config,
    ], { env }, JSON.stringify({ session_id: "morta", cwd: "C:/madamelabs-code" }));

    assert.equal(result.code, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.stopped, false);
    assert.equal(output.result.reason, "no_backend_answered");

    await writeFile(config, JSON.stringify(live));
    const state = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "diagnose", "--config", config], { env })).stdout).result;
    assert.deepEqual(state.bindings, []);
    assert.deepEqual(state.leases, []);
    assert.equal(state.divergences.length, 1);
    assert.equal(state.divergences[0].taskPath, "01-planejamento/plano.md");
    assert.equal(state.divergences[0].reason, "no_backend_answered");
  });
});

test("opencode SessionStart injects the Node-only task gate", async () => {
  await fixture(async ({ config, dir }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "hook-start", "--agent", "opencode", "--config", config], {
      encoding: "utf8",
      env: { ...process.env, LOCALAPPDATA: dir },
      input: JSON.stringify({ session_id: "op1", cwd: "C:/madamelabs-code" }),
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /gate TaskNotes/i);
    assert.match(output.hookSpecificOutput.additionalContext, /opencode/);
  });
});

test("opencode SessionEnd stops a bound timer through the bound backend", async () => {
  await fixture(async ({ config, dir, calls, timers }) => {
    const env = { ...process.env, LOCALAPPDATA: dir };
    await run(process.execPath, [fileURLToPath(cli), "start", "01-planejamento/plano.md",
      "--agent", "opencode", "--session", "op1", "--config", config], { env });

    const result = await runWithInput(process.execPath, [
      fileURLToPath(cli), "hook-end", "--agent", "opencode", "--config", config,
    ], { env }, JSON.stringify({ session_id: "op1", cwd: "C:/madamelabs-code" }));
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionEnd");
    assert.equal(calls.some((call) => call.url.endsWith("/time/stop")), true);
    assert.deepEqual(timers, []);
  });
});

// Por sh, e nao por powershell: o harness executa todo hook por sh, no Windows
// tambem. Era o .ps1 que este teste exercitava, e nenhum harness o chamava --
// o wrapper de verdade ficava sem cobertura.
test("Claude wrapper forwards the raw hook payload to the Node adapter", { skip: !sessionStartWrapper }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-wrapper-"));
  try {
    const result = spawnSync("sh", ["-c", '"$0"', sessionStartWrapper], {
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

test("headless create refuses missing project before changing the vault", async () => {
  await fixture(async ({ config, calls }) => {
    const result = await run(process.execPath, [
      fileURLToPath(cli), "create", "Nova", "--responsavel", "arthur", "--marca", "Madame_Labs", "--backend", "headless", "--config", config,
    ])
      .then(({ stdout }) => ({ status: 0, output: JSON.parse(stdout) }))
      .catch((error) => ({ status: error.code, output: JSON.parse(error.stdout) }));
    assert.equal(result.status, 2);
    assert.equal(result.output.error, "missing_create_metadata");
    assert.equal(calls.some((call) => call.method === "POST"), false);
  });
});

// Sem --backend: o promote precisa funcionar no caminho padrao, que e o
// desktop. A API do plugin nao alcanca nota que ainda nao e tarefa, entao o
// comando escolhe o headless sozinho; exigir a flag era o defeito.
test("promote turns an existing planning note into a task without asking for a backend", async () => {
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
      "--config", config])).stdout);

    assert.deepEqual(promoted, { ok: true, result: { taskPath: "01-planejamento/Brainstorm.md" } });
    const note = await (await import("node:fs/promises")).readFile(join(vault, "01-planejamento", "Brainstorm.md"), "utf8");
    assert.match(note, /- task/);
    assert.match(note, /Responsavel:\s+- '?\[\[Arthur_Cardoso\]\]/);
    assert.match(note, /Marca:\s+- '?\[\[Madame_Labs\]\]/);
    assert.match(note, /Projeto:\s+- '?\[\[tasknotes-dual-vault-e-adaptador\]\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// O ENGENHARIA grava `assignees`, `marca`, `projects` e status em ingles desde
// 2026-10. A nota de planejamento tem `type` proprio, e e tarefa pela tag.
test("promote writes the vault vocabulary into a real collection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-promote-vocab-"));
  const vault = join(dir, "vault");
  const config = join(dir, "config.json");
  try {
    assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
    await mkdir(join(vault, "01-planejamento"));
    await writeFile(join(vault, "01-planejamento", "Plano.md"), "---\ntype: plano\ntitle: Plano\n---\nCorpo.\n");
    await writeFile(config, JSON.stringify({
      workspace: "madamelabs-code",
      vault: "ENGENHARIA",
      vaultPath: vault,
      defaultResponsavel: "arthur",
      defaultBackend: "headless",
      headless: { mtnPath: mtn },
      stateDir: join(dir, "state"),
      vocabulary: {
        statuses: { "to-do": "open", "em-andamento": "in-progress", aprovacao: "review", pausa: "paused", concluido: "done", cancelado: "cancelled" },
        fields: { responsavel: "assignees", marca: "marca", projeto: "projects" },
      },
    }));

    const promoted = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "promote", "01-planejamento/Plano.md",
      "--responsavel", "arthur", "--marca", "Madame_Labs", "--projeto", "projeto-x", "--config", config])).stdout);
    assert.equal(promoted.ok, true, JSON.stringify(promoted));

    const note = await (await import("node:fs/promises")).readFile(join(vault, "01-planejamento", "Plano.md"), "utf8");
    assert.match(note, /type: plano/);
    assert.match(note, /- task/);
    assert.match(note, /status: backlog/);
    assert.match(note, /assignees:\s+- '?\[\[Arthur_Cardoso\]\]/);
    assert.match(note, /marca:\s+- '?\[\[Madame_Labs\]\]/);
    assert.match(note, /projects:\s+- '?\[\[projeto-x\]\]/);
    assert.doesNotMatch(note, /Responsavel|Marca:|Projeto:/);
    assert.match(note, /Corpo\./);

    const opened = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "open", "--config", config])).stdout);
    assert.ok(opened.tasks.some((task) => task.path === "01-planejamento/Plano.md"), JSON.stringify(opened));

    // Fechar pelo headless grava a data de conclusao, pelo nome do vault.
    const closed = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "set-status", "01-planejamento/Plano.md",
      "--status", "concluido", "--config", config])).stdout);
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const done = await (await import("node:fs/promises")).readFile(join(vault, "01-planejamento", "Plano.md"), "utf8");
    assert.match(done, /status: done/);
    assert.match(done, new RegExp(`completedDate: '?${new Date().toLocaleDateString("sv-SE")}`));

    // Tarefa registrada depois do fato: a data passada substitui a do dia.
    const backdated = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "set-status", "01-planejamento/Plano.md",
      "--status", "concluido", "--completed-date", "2026-01-15", "--config", config])).stdout);
    assert.equal(backdated.ok, true, JSON.stringify(backdated));
    assert.equal(backdated.result.completedDate, "2026-01-15");
    const redated = await (await import("node:fs/promises")).readFile(join(vault, "01-planejamento", "Plano.md"), "utf8");
    assert.match(redated, /completedDate: '?2026-01-15/);
    assert.doesNotMatch(redated, new RegExp(`completedDate: '?${new Date().toLocaleDateString("sv-SE")}`));
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

// Com o Obsidian fechado o link-project morria em unsafe_backend_missing. O
// headless troca a lista Projeto inteira, como o PUT do desktop, e a tarefa
// continua visivel ao mtn depois -- lista mal escrita derruba a leitura.
test("link-project headless replaces the Projeto list on a real vault, with no desktop block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-link-headless-"));
  const vault = join(dir, "vault");
  const config = join(dir, "config.json");
  try {
    assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
    await mkdir(join(vault, "06-tarefas"), { recursive: true });
    await writeFile(join(vault, "06-tarefas", "Alvo.md"), "---\ntitle: Alvo\n---\n");
    await writeFile(config, JSON.stringify({
      workspace: "madamelabs-code",
      vault: "ENGENHARIA",
      vaultPath: vault,
      defaultResponsavel: "arthur",
      defaultBackend: "headless",
      headless: { mtnPath: mtn },
      stateDir: join(dir, "state"),
    }));
    await run(process.execPath, [fileURLToPath(cli), "promote", "06-tarefas/Alvo.md",
      "--responsavel", "arthur", "--marca", "Madame_Labs", "--projeto", "labs-sv", "--config", config]);

    const linked = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "link-project", "06-tarefas/Alvo.md",
      "--projeto", "labs", "--projeto", "[[outro-projeto]]", "--backend", "headless", "--config", config])).stdout);

    assert.equal(linked.ok, true);
    const note = await (await import("node:fs/promises")).readFile(join(vault, "06-tarefas", "Alvo.md"), "utf8");
    assert.match(note, /Projeto:\s+- '?\[\[labs\]\]'?\s+- '?\[\[outro-projeto\]\]/);
    assert.doesNotMatch(note, /labs-sv/);
    const listed = JSON.parse((await run(process.execPath, [fileURLToPath(cli), "open", "--config", config])).stdout);
    assert.ok(listed.tasks.some((task) => task.path === "06-tarefas/Alvo.md"), JSON.stringify(listed));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desktop backend fails clearly when the config has no desktop block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-no-desktop-"));
  const config = join(dir, "config.json");
  try {
    await writeFile(config, JSON.stringify({
      workspace: "madamelabs-code", vault: "ENGENHARIA", vaultPath: join(dir, "vault"),
      defaultResponsavel: "arthur", defaultBackend: "headless", stateDir: join(dir, "state"),
    }));
    const result = spawnSync(process.execPath, [fileURLToPath(cli), "open", "--backend", "desktop", "--config", config], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error, "missing_desktop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Data de conclusao so faz sentido em tarefa fechada e numa data real, que ja
// passou. Recusar antes de tocar no vault, para nao gravar data inventada.
test("set-status refuses a completion date on an open status, a malformed date and a future date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-completed-date-"));
  try {
    const marker = join(dir, "called");
    const fake = join(dir, "fake-mtn.mjs");
    await writeFile(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      workspace: "teste", vault: "V", vaultPath: dir, defaultResponsavel: "Arthur_Cardoso",
      desktop: { baseUrl: "http://127.0.0.1:1", authToken: "x" },
      headless: { mtnPath: fake },
    }));
    const tomorrow = new Date(Date.now() + 2 * 86400000).toLocaleDateString("sv-SE");
    for (const [status, date, error] of [
      ["pausa", "2026-01-15", "completed_date_requires_closed_status"],
      ["concluido", "15/01/2026", "invalid_completed_date"],
      ["concluido", "2026-02-30", "invalid_completed_date"],
      ["cancelado", tomorrow, "invalid_completed_date"],
    ]) {
      const result = spawnSync(process.execPath, [
        fileURLToPath(cli), "set-status", "alvo.md", "--status", status, "--completed-date", date,
        "--backend", "headless", "--config", configPath,
      ], { encoding: "utf8" });
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false, `${status} ${date}`);
      assert.equal(payload.error, error, `${status} ${date}`);
    }
    assert.equal(existsSync(marker), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Sem comando de dependencia, o bloqueio entre etapas de um plano so se marcava
// no Obsidian, a mao. O block grava no formato do plugin e preserva o que o
// plugin ja gravou com outro reltype.
test("block and unblock edit the dependency list on a real vault", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-block-"));
  const vault = join(dir, "vault");
  const config = join(dir, "config.json");
  const cliRun = async (...args) => JSON.parse((await run(process.execPath, [fileURLToPath(cli), ...args, "--config", config])).stdout);
  const cliFail = (...args) => JSON.parse(spawnSync(process.execPath, [fileURLToPath(cli), ...args, "--config", config], { encoding: "utf8" }).stdout);
  const read = () => readFile(join(vault, "06-tarefas", "Etapa 4.md"), "utf8");
  try {
    assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
    await mkdir(join(vault, "06-tarefas"), { recursive: true });
    await writeFile(join(vault, "06-tarefas", "Etapa 4.md"),
      "---\ntitle: Etapa 4\nblockedBy:\n  - uid: '[[Revisao]]'\n    reltype: STARTTOSTART\n    gap: P1D\n---\nCorpo.\n");
    for (const name of ["Etapa 3", "Revisao"]) await writeFile(join(vault, "06-tarefas", `${name}.md`), `---\ntitle: ${name}\n---\n`);
    await writeFile(config, JSON.stringify({
      workspace: "madamelabs-code", vault: "ENGENHARIA", vaultPath: vault, defaultResponsavel: "arthur",
      defaultBackend: "headless", headless: { mtnPath: mtn }, stateDir: join(dir, "state"),
    }));
    for (const name of ["Etapa 4", "Etapa 3", "Revisao"]) {
      await cliRun("promote", `06-tarefas/${name}.md`, "--responsavel", "arthur", "--marca", "Madame_Labs", "--projeto", "plano");
    }

    const blocked = await cliRun("block", "06-tarefas/Etapa 4.md", "--by", "06-tarefas/Etapa 3.md");
    assert.equal(blocked.ok, true, JSON.stringify(blocked));
    assert.deepEqual(blocked.result.blockedBy, [
      { uid: "[[Revisao]]", reltype: "STARTTOSTART", gap: "P1D" },
      { uid: "[[Etapa 3]]", reltype: "FINISHTOSTART" },
    ]);
    let note = await read();
    assert.match(note, /uid: '?\[\[Etapa 3\]\]'?\s+reltype: FINISHTOSTART/);
    assert.match(note, /gap: P1D/);
    assert.match(note, /Corpo\./);

    const again = await cliRun("block", "06-tarefas/Etapa 4.md", "--by", "06-tarefas/Etapa 3.md");
    assert.equal(again.result.blockedBy.length, 2);

    const freed = await cliRun("unblock", "06-tarefas/Etapa 4.md", "--by", "06-tarefas/Etapa 3.md");
    assert.deepEqual(freed.result.blockedBy, [{ uid: "[[Revisao]]", reltype: "STARTTOSTART", gap: "P1D" }]);
    note = await read();
    assert.doesNotMatch(note, /Etapa 3/);

    assert.equal(cliFail("block", "06-tarefas/Etapa 4.md", "--by", "06-tarefas/Nada.md").error, "blocker_not_found");
    assert.equal(cliFail("block", "06-tarefas/Etapa 4.md", "--by", "06-tarefas/Etapa 4.md").error, "task_cannot_block_itself");
    assert.equal(cliFail("block", "06-tarefas/Etapa 4.md").error, "missing_task_or_blocker");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
