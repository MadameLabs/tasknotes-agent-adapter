import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = new URL("../src/cli.mjs", import.meta.url).pathname;

const COMPLETO = "tags:\n  - task\nbrand:\n  - '[[Madame_Labs]]'\nprojects:\n  - '[[gate-de-planos]]'\n";
const nota = (extra = "") => `---\ntype: plano\n${extra}---\n\n# corpo\n`;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

async function ambiente({ comToml = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "gate-planos-"));
  const base = path.join(dir, "BIB");
  const pasta = path.join(base, "13-engenharia", "01-planejamento");
  await mkdir(pasta, { recursive: true });
  git(base, "init", "-q");
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  await writeFile(path.join(base, "README.md"), "x");
  git(base, "add", "README.md");
  git(base, "commit", "-q", "-m", "init");
  const toml = path.join(dir, comToml ? "base.toml" : "ausente.toml");
  if (comToml) await writeFile(toml, `base = "${base}"\npadrao = "13-engenharia/01-planejamento"\n`);
  const estado = path.join(dir, "estado");
  const env = { ...process.env, MADAMELABS_BASE_TOML: toml, XDG_STATE_HOME: estado, HOME: path.join(dir, "home") };
  return { dir, base, pasta, env, estado, pendentesJsonl: path.join(estado, "madamelabs-tasknotes", "gate-planos", "pendentes.jsonl") };
}

function rodar(args, { env, entrada, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "gate-planos", ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (codigo) => resolve({ codigo, stdout, stderr }));
    child.stdin.end(entrada === undefined ? "" : typeof entrada === "string" ? entrada : JSON.stringify(entrada));
  });
}

const ANTES = "2000-01-01T00:00:00Z";

test("escrita em docs/superpowers/plans é negada no formato do Claude", async () => {
  const { dir, pasta, env } = await ambiente();
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  const alvo = path.join(repo, "docs", "superpowers", "plans", "a.md");
  const r = await rodar(["escrita", "--agent", "claude"], { env, entrada: { tool_input: { file_path: alvo }, cwd: repo } });
  assert.equal(r.codigo, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /docs\/superpowers\/\*\*/);
  assert.ok(j.hookSpecificOutput.permissionDecisionReason.includes(pasta));
});

test("escrita na pasta de planos passa calada", async () => {
  const { pasta, env } = await ambiente();
  const r = await rodar(["escrita", "--agent", "claude"], { env, entrada: { tool_input: { file_path: path.join(pasta, "a.md") }, cwd: pasta } });
  assert.deepEqual([r.codigo, r.stdout, r.stderr], [0, "", ""]);
});

test("escrita relativa é resolvida contra o cwd do evento", async () => {
  const { dir, env } = await ambiente();
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  const r = await rodar(["escrita", "--agent", "claude"], { env, entrada: { tool_input: { file_path: "plans/a.md" }, cwd: repo } });
  assert.match(r.stdout, /deny/);
});

test("escrita em docs/guia.md de repositório passa calada", async () => {
  const { dir, env } = await ambiente();
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  const r = await rodar(["escrita", "--agent", "claude"], { env, entrada: { tool_input: { file_path: path.join(repo, "docs", "guia.md") }, cwd: repo } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
});

test("hermes escrita usa action block", async () => {
  const { dir, env } = await ambiente();
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  const r = await rodar(["escrita", "--agent", "hermes"], { env, entrada: { tool_input: { path: path.join(repo, "specs", "a.md") }, cwd: repo } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.action, "block");
  assert.equal(typeof j.message, "string");
});

test("omp usa bloquear/motivo", async () => {
  const { dir, env } = await ambiente();
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  const e = await rodar(["escrita", "--agent", "omp"], { env, entrada: { tool_input: { file_path: path.join(repo, "specs", "a.md") }, cwd: repo } });
  assert.equal(JSON.parse(e.stdout).bloquear, true);
  assert.equal(typeof JSON.parse(e.stdout).motivo, "string");
  const amb = await ambiente();
  await writeFile(path.join(amb.pasta, "p.md"), nota());
  const s = await rodar(["saida", "--agent", "omp", "--desde", ANTES], { env: amb.env, entrada: { session_id: "s1" } });
  assert.equal(JSON.parse(s.stdout).bloquear, true);
});

test("saida bloqueia com plano novo sem tag e mostra o comando de promote", async () => {
  const { dir, pasta, env } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota());
  await writeFile(path.join(dir, "config.agent.local.json"), "{}");
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env, entrada: { session_id: "s1", cwd: dir } });
  assert.equal(r.codigo, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.decision, "block");
  assert.ok(j.reason.includes('tasknotes-agent promote "13-engenharia/01-planejamento/novo.md" --responsavel arthur --marca <MARCA> --projeto <PROJETO> --config '));
  assert.ok(j.reason.includes(path.join(dir, "config.agent.local.json")));
});

test("saida usa o texto literal quando não acha config.agent.local.json", async () => {
  const { pasta, env } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota());
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env, entrada: { session_id: "s1", cwd: path.join(tmpdir(), "nao-existe-xyz") } });
  assert.ok(JSON.parse(r.stdout).reason.includes("<config.agent.local.json do workspace>"));
});

test("saida passa depois do promote (tag, projects, brand)", async () => {
  const { pasta, env } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota(COMPLETO));
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env, entrada: { session_id: "s1" } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
});

test("saida ignora plano que veio de commit (não está no git status)", async () => {
  const { base, pasta, env } = await ambiente();
  await writeFile(path.join(pasta, "pull.md"), nota());
  git(base, "add", "-A");
  git(base, "commit", "-q", "-m", "chegou por pull");
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env, entrada: { session_id: "s1" } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
});

test("saida ignora plano com mtime anterior ao início da sessão", async () => {
  const { pasta, env } = await ambiente();
  const f = path.join(pasta, "velho.md");
  await writeFile(f, nota());
  const antigo = new Date("2020-01-01T00:00:00Z");
  await utimes(f, antigo, antigo);
  const r = await rodar(["saida", "--agent", "claude", "--desde", "2021-01-01T00:00:00Z"], { env, entrada: { session_id: "s1" } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
});

test("saida usa o timestamp da primeira linha do transcript e acha caminhos com acento e espaço", async () => {
  const { dir, pasta, env } = await ambiente();
  await writeFile(path.join(pasta, "plano açaí novo.md"), nota());
  const transcript = path.join(dir, "t.jsonl");
  await writeFile(transcript, `${JSON.stringify({ timestamp: ANTES })}\n{"x":1}\n`);
  const r = await rodar(["saida", "--agent", "claude"], { env, entrada: { session_id: "s1", transcript_path: transcript } });
  assert.match(JSON.parse(r.stdout).reason, /plano açaí novo\.md/);
});

test("saida sem início de sessão passa calada", async () => {
  const { pasta, env } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota());
  const r = await rodar(["saida", "--agent", "claude"], { env, entrada: { session_id: "s1" } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
});

test("segunda saida com o mesmo conjunto passa e grava pendentes.jsonl", async () => {
  const { pasta, env, pendentesJsonl } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota());
  const args = ["saida", "--agent", "claude", "--desde", ANTES];
  const primeira = await rodar(args, { env, entrada: { session_id: "s1" } });
  assert.equal(JSON.parse(primeira.stdout).decision, "block");
  const segunda = await rodar(args, { env, entrada: { session_id: "s1" } });
  assert.deepEqual([segunda.codigo, segunda.stdout], [0, ""]);
  const linha = JSON.parse((await readFile(pendentesJsonl, "utf8")).trim());
  assert.equal(linha.sessao, "s1");
  assert.equal(linha.caminho, path.join(pasta, "novo.md"));
  assert.deepEqual(linha.faltando, ["task", "projects", "brand"]);
  assert.ok(linha.quando);
});

test("saida com stop_hook_active deixa parar e grava pendentes.jsonl", async () => {
  const { pasta, env, pendentesJsonl } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota());
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env, entrada: { session_id: "s2", stop_hook_active: true } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
  assert.ok(existsSync(pendentesJsonl));
});

test("sem base.toml todos os modos saem calados com exit 0", async () => {
  const { pasta, env } = await ambiente({ comToml: false });
  await writeFile(path.join(pasta, "novo.md"), nota());
  for (const args of [["escrita", "--agent", "claude"], ["saida", "--agent", "claude", "--desde", ANTES], ["pendentes"]]) {
    const r = await rodar(args, { env, entrada: { session_id: "s", tool_input: { file_path: "/x/plans/a.md" }, cwd: "/x" } });
    assert.deepEqual([r.codigo, r.stdout, r.stderr], [0, "", ""], args.join(" "));
  }
});

test("entrada inesperada passa calada com exit 0", async () => {
  const { env } = await ambiente();
  for (const entrada of ["não é json", "[1,2]", "null", ""]) {
    for (const modo of ["escrita", "saida"]) {
      const r = await rodar([modo, "--agent", "claude"], { env, entrada });
      assert.deepEqual([r.codigo, r.stdout], [0, ""], `${modo} ${entrada}`);
    }
  }
});

test("pendentes sai 1 com plano fora do padrão e 0 sem", async () => {
  const { pasta, env } = await ambiente();
  const vazio = await rodar(["pendentes"], { env });
  assert.deepEqual([vazio.codigo, vazio.stdout], [0, ""]);
  await writeFile(path.join(pasta, "x.md"), nota("tags:\n  - task\n"));
  const r = await rodar(["pendentes"], { env });
  assert.equal(r.codigo, 1);
  assert.equal(r.stdout, "13-engenharia/01-planejamento/x.md\tprojects,brand\n");
});

test("gate-planos não exige --config", async () => {
  const { env } = await ambiente();
  const r = await rodar(["pendentes"], { env });
  assert.ok(!r.stdout.includes("missing_config"));
  assert.equal(r.codigo, 0);
});

test("saida acha o início num transcript real, com linhas sem timestamp antes", async () => {
  const { dir, pasta, env } = await ambiente();
  const inicio = new Date(Date.now() - 60_000).toISOString();
  const transcript = path.join(dir, "real.jsonl");
  await writeFile(transcript, [{ type: "mode" }, { type: "file-history-snapshot" }, { type: "user", timestamp: inicio }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  await writeFile(path.join(pasta, "novo.md"), nota());
  const r = await rodar(["saida", "--agent", "claude"], { env, entrada: { session_id: "s1", transcript_path: transcript } });
  assert.equal(JSON.parse(r.stdout).decision, "block");
});

test("saida bloqueia com a base alcançada por symlink", async () => {
  const { dir, base, pasta, env } = await ambiente();
  const link = path.join(dir, "link-bib");
  await symlink(base, link);
  await writeFile(path.join(dir, "base-link.toml"), `base = "${link}"\npadrao = "13-engenharia/01-planejamento"\n`);
  await writeFile(path.join(pasta, "novo.md"), nota());
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env: { ...env, MADAMELABS_BASE_TOML: path.join(dir, "base-link.toml") }, entrada: { session_id: "s1" } });
  assert.equal(JSON.parse(r.stdout).decision, "block");
});

test("três saidas com o mesmo conjunto: bloqueia, libera e grava, libera sem regravar", async () => {
  const { pasta, env, pendentesJsonl } = await ambiente();
  await writeFile(path.join(pasta, "novo.md"), nota());
  const args = ["saida", "--agent", "claude", "--desde", ANTES];
  const entrada = { session_id: "s3" };
  assert.equal(JSON.parse((await rodar(args, { env, entrada })).stdout).decision, "block");
  assert.equal((await rodar(args, { env, entrada })).stdout, "");
  const linhas = (await readFile(pendentesJsonl, "utf8")).trim().split("\n").length;
  const terceira = await rodar(args, { env, entrada });
  assert.deepEqual([terceira.codigo, terceira.stdout], [0, ""]);
  assert.equal((await readFile(pendentesJsonl, "utf8")).trim().split("\n").length, linhas);
});

test("saida com base que não é repositório Git passa calada", async () => {
  const { dir, env } = await ambiente();
  const base = path.join(dir, "sem-git");
  await mkdir(path.join(base, "p"), { recursive: true });
  await writeFile(path.join(base, "p", "novo.md"), nota());
  await writeFile(path.join(dir, "sg.toml"), `base = "${base}"\npadrao = "p"\n`);
  const r = await rodar(["saida", "--agent", "claude", "--desde", ANTES], { env: { ...env, MADAMELABS_BASE_TOML: path.join(dir, "sg.toml") }, entrada: { session_id: "s" } });
  assert.deepEqual([r.codigo, r.stdout], [0, ""]);
});
