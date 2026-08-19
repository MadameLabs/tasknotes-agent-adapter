import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMtnBackend } from "../src/backends/mtn.mjs";

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
