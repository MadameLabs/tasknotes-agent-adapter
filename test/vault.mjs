import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mtn } from "./mtn-path.mjs";

// Vault real criado pelo `mtn init`, com notas escritas a partir de um mapa
// caminho -> frontmatter (objeto plano, valores ja como YAML de uma linha).
export async function makeVault(notes = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-vault-"));
  const vault = join(dir, "vault");
  assert.equal(spawnSync(process.execPath, [mtn, "init", vault], { encoding: "utf8" }).status, 0);
  for (const [path, fields] of Object.entries(notes)) await writeNote(vault, path, fields);
  return { dir, vault };
}

export async function writeNote(vault, path, fields, body = "Corpo.") {
  const file = join(vault, path);
  await mkdir(dirname(file), { recursive: true });
  const lines = Object.entries(fields).flatMap(([key, value]) => Array.isArray(value)
    ? [`${key}:`, ...value.map((item) => `  - ${item}`)]
    : [`${key}: ${value}`]);
  await writeFile(file, ["---", ...lines, "---", body, ""].join("\n"));
  return file;
}
