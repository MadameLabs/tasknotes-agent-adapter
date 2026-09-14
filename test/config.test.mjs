import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, resolveResponsavel } from "../src/config.mjs";

const validConfig = {
  workspace: "madamelabs-code",
  vault: "ENGENHARIA",
  vaultPath: "C:/madamelabs-code/ENGENHARIA",
  defaultResponsavel: "arthur",
  desktop: { baseUrl: "http://127.0.0.1:8081", authToken: "local-token" },
  headless: { mtnPath: "mtn" },
};

async function withConfig(config, run) {
  const dir = await mkdtemp(join(tmpdir(), "tasknotes-agent-config-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config));
  try {
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loads a valid configuration and derives a state directory", async () => {
  await withConfig(validConfig, async (path) => {
    const config = await loadConfig(path);
    assert.equal(config.workspace, validConfig.workspace);
    assert.equal(config.defaultResponsavel, "Arthur_Cardoso");
    const suffix = process.platform === "win32"
      ? "MadameLabs/TaskNotesAgent"
      : "madamelabs-tasknotes";
    assert.ok(config.stateDir.replaceAll("\\", "/").endsWith(suffix));
  });
});

test("honours an explicit stateDir so tests never write to the real state", async () => {
  await withConfig({ ...validConfig, stateDir: "C:/tmp/estado-de-teste" }, async (path) =>
    assert.equal((await loadConfig(path)).stateDir, "C:/tmp/estado-de-teste"),
  );
});

test("rejects a configuration without vaultPath", async () => {
  const { vaultPath, ...invalid } = validConfig;
  await withConfig(invalid, (path) => assert.rejects(loadConfig(path), /missing_vaultPath/));
});

test("accepts the canonical note name as default responsavel", async () => {
  await withConfig({ ...validConfig, defaultResponsavel: "Arthur_Cardoso" }, async (path) =>
    assert.equal((await loadConfig(path)).defaultResponsavel, "Arthur_Cardoso"),
  );
});

test("accepts the Miss. Labs aliases", async () => {
  assert.equal(resolveResponsavel("misslabs"), "Miss. Labs");
  assert.equal(resolveResponsavel("[[Miss. Labs]]"), "Miss. Labs");
});

test("rejects an unsupported default responsavel", async () => {
  await withConfig({ ...validConfig, defaultResponsavel: "unknown" }, (path) =>
    assert.rejects(loadConfig(path), /invalid_defaultResponsavel/),
  );
});

test("rejects an unsupported default backend", async () => {
  await withConfig({ ...validConfig, defaultBackend: "automatic" }, (path) =>
    assert.rejects(loadConfig(path), /invalid_defaultBackend/),
  );
});
