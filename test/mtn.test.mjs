import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createMtnBackend } from "../src/backends/mtn.mjs";
import { mtn } from "./mtn-path.mjs";

const run = promisify(execFile);

test("passes an exact path as an execFile argument", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-"));
  const output = join(dir, "args.json");
  const script = join(dir, "fake.mjs");
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)));`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault com espaço" });
    const before = process.env.OUT; process.env.OUT = output;
    await backend.stopTimer("06-tarefas/[A] caminho exato.md");
    process.env.OUT = before;
    assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(output, "utf8")), ["timer", "stop", "06-tarefas/[A] caminho exato.md", "--path", "C:/vault com espaço"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// `mtn list` devolve 50 por padrao, e essa lista e a unica janela do backend
// headless para o vault: e nela que o adaptador procura a tarefa e o cronometro
// em andamento. Sem limite explicito, a tarefa 51 some -- e os dois vaults ja
// passavam de 50 quando isso foi descoberto.
test("listing asks for every task instead of the default first page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-limit-"));
  const output = join(dir, "args.json");
  const script = join(dir, "fake.mjs");
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2))); console.log('[]');`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault" });
    const before = process.env.OUT; process.env.OUT = output;
    await backend.listOpen();
    process.env.OUT = before;
    const args = JSON.parse(await (await import("node:fs/promises")).readFile(output, "utf8"));
    const limite = args[args.indexOf("--limit") + 1];
    assert.ok(args.includes("--limit"), `sem --limit: ${args.join(" ")}`);
    assert.ok(Number(limite) >= 10000, `limite baixo demais: ${limite}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("promotes one exact note with the approved TaskNotes metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-promote-"));
  const output = join(dir, "args.json");
  const script = join(dir, "fake.mjs");
  // O falso registra uma linha por invocacao, para provar que e uma so.
  await writeFile(script, `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault" });
    const before = process.env.OUT; process.env.OUT = output;
    await backend.promoteTask("01-planejamento/Brainstorm.md", {
      responsavel: "[[Arthur_Cardoso]]",
      marca: "[[Madame_Labs]]",
      projeto: "[[tasknotes-dual-vault-e-adaptador]]",
    });
    process.env.OUT = before;
    const calls = (await (await import("node:fs/promises")).readFile(output, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    // Uma escrita so, nascendo em backlog, com os nomes padrao do vocabulario.
    assert.deepEqual(calls, [[
      "update", "01-planejamento/Brainstorm.md",
      "--add-tag", "task",
      "--status", "backlog",
      "--set-new-list", "Responsavel=[[Arthur_Cardoso]]",
      "--set-new-list", "Marca=[[Madame_Labs]]",
      "--set-new-list", "Projeto=[[tasknotes-dual-vault-e-adaptador]]",
      "--path", "C:/vault",
    ]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sets status through the mtn mapped status option", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-status-"));
  const output = join(dir, "args.json");
  const script = join(dir, "fake.mjs");
  await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)));`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault" });
    const before = process.env.OUT; process.env.OUT = output;
    await backend.setStatus("01-planejamento/Brainstorm.md", "em-andamento");
    process.env.OUT = before;
    assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(output, "utf8")), [
      "update", "01-planejamento/Brainstorm.md", "--status", "em-andamento", "--path", "C:/vault",
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("mtn_failed carries the reason the CLI printed", async () => {
  // Antes o adaptador reduzia tudo a "mtn_failed:1": a linha que dizia
  // unknown_field era descartada junto com o resto da saida.
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-reason-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log('[31m✗ unknown_field:Responsavel[39m'); process.exit(1);`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault" });
    await assert.rejects(
      () => backend.setStatus("06-tarefas/Alvo.md", "pausa"),
      (error) => {
        assert.match(error.message, /^mtn_failed:/);
        assert.match(error.message, /unknown_field:Responsavel/);
        return true;
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Parar com `concluido` ou `cancelado` grava o status antes de parar o
// cronometro. O `mtn list` sem filtro esconde exatamente esses dois status, entao
// o cronometro sumia da janela do adaptador no meio do `stop`: a resposta era
// `timer_already_closed` e a entrada de tempo ficava aberta para sempre.
test("sees the running timer of a task already marked done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-done-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `
    const args = process.argv.slice(2);
    const done = [{ path: "06-tarefas/Alvo.md", status: "concluido", timeEntries: [{ startTime: "2026-09-16T10:00:00.000Z" }] }];
    console.log(JSON.stringify(args.includes("--where") ? done : []));
  `);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault" });
    assert.equal(await backend.verifyTimer("06-tarefas/Alvo.md", { startTime: "2026-09-16T10:00:00.000Z" }), true);
    assert.equal((await backend.getTask("06-tarefas/Alvo.md"))?.status, "concluido");
    // O `open` continua sendo so o que esta aberto.
    assert.deepEqual(await backend.listOpen(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("creates a task headless: mtn create, promote with metadata, initial status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-create-"));
  const output = join(dir, "calls.jsonl");
  const script = join(dir, "fake.mjs");
  await writeFile(script, `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(process.env.OUT, JSON.stringify(args) + '\\n');
    if (args[0] === 'create') { console.log('✓ Task created'); console.log('  → 06-tarefas/Revisar hooks.md'); }
    if (args[0] === 'list') console.log(JSON.stringify([{ path: '06-tarefas/Revisar hooks.md', status: 'backlog', title: 'Revisar hooks' }]));
  `);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault" });
    const before = process.env.OUT; process.env.OUT = output;
    const task = await backend.createTask({ title: "Revisar hooks", responsavel: "Arthur_Cardoso", marcas: ["Madame_Labs"], projeto: "tasknotes-dual-vault-e-adaptador" });
    process.env.OUT = before;
    const calls = (await readFile(output, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ["create", "Revisar hooks", "--path", "C:/vault"]);
    assert.deepEqual(calls[1], [
      "update", "06-tarefas/Revisar hooks.md",
      "--add-tag", "task", "--status", "backlog",
      // Wikilink como no backend desktop: sem colchetes o vault grava texto solto.
      "--set-new-list", "Responsavel=[[Arthur_Cardoso]]", "--set-new-list", "Marca=[[Madame_Labs]]", "--set-new-list", "Projeto=[[tasknotes-dual-vault-e-adaptador]]",
      "--path", "C:/vault",
    ]);
    assert.equal(task.path, "06-tarefas/Revisar hooks.md");
    assert.equal(task.status, "backlog");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const ENGLISH = {
  statuses: { backlog: "backlog", "to-do": "open", "em-andamento": "in-progress", aprovacao: "review", pausa: "paused", concluido: "done", cancelado: "cancelled" },
  fields: { responsavel: "assignees", marca: "marca", projeto: "projects" },
};

// O `mtn promote` do fork grava Responsavel, Marca, Projeto e `to-do` literais.
// Um vault com outro vocabulario precisa da promocao composta pelo `update`,
// que ja promove nota comum pela tag, com os nomes vindos do config.
test("promotes with the vault vocabulary through one mtn update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-vocab-"));
  const output = join(dir, "calls.jsonl");
  const script = join(dir, "fake.mjs");
  await writeFile(script, `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault", vocabulary: ENGLISH });
    const before = process.env.OUT; process.env.OUT = output;
    await backend.promoteTask("01-planejamento/Plano.md", { responsavel: "[[Arthur_Cardoso]]", marca: "[[Madame_Labs]]", projeto: "[[projeto-x]]" });
    await backend.setProjects("01-planejamento/Plano.md", ["projeto-y"]);
    process.env.OUT = before;
    const calls = (await readFile(output, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], [
      "update", "01-planejamento/Plano.md",
      "--add-tag", "task",
      "--status", "backlog",
      "--set-new-list", "assignees=[[Arthur_Cardoso]]",
      "--set-new-list", "marca=[[Madame_Labs]]",
      "--set-new-list", "projects=[[projeto-x]]",
      "--path", "C:/vault",
    ]);
    assert.deepEqual(calls[1], ["update", "01-planejamento/Plano.md", "--set-new-list", "projects=[[projeto-y]]", "--path", "C:/vault"]);
    assert.equal(calls.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("open tasks hide the vault's own closed statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mtn-adapter-vocab-open-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `console.log(JSON.stringify([{ path: "a.md", status: "done" }, { path: "b.md", status: "cancelled" }, { path: "c.md", status: "review" }]));`);
  try {
    const backend = createMtnBackend({ mtnPath: process.execPath, mtnArgs: [script], vaultPath: "C:/vault", vocabulary: ENGLISH });
    assert.deepEqual((await backend.listOpen()).map((task) => task.path), ["c.md"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
