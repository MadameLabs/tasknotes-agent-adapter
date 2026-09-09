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
  // O promote chama o mtn duas vezes -- promote e depois o status inicial --,
  // entao o falso registra uma linha por invocacao em vez de sobrescrever.
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
    assert.deepEqual(calls[0], [
      "promote", "01-planejamento/Brainstorm.md",
      "--responsavel", "[[Arthur_Cardoso]]",
      "--marca", "[[Madame_Labs]]",
      "--projeto", "[[tasknotes-dual-vault-e-adaptador]]",
      "--path", "C:/vault",
    ]);
    // Nasce em backlog: o mtn grava `to-do` fixo no promote e o adaptador corrige.
    assert.deepEqual(calls[1], ["update", "01-planejamento/Brainstorm.md", "--status", "backlog", "--path", "C:/vault"]);
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
