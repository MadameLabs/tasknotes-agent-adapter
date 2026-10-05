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

// Maquina sem Obsidian (o labs, no Fedora) nao tem API do plugin para apontar:
// exigir desktop.authToken ali obrigava a inventar um token de mentira.
test("headless default does not require a desktop block", async () => {
  const { desktop, ...headlessOnly } = validConfig;
  await withConfig({ ...headlessOnly, defaultBackend: "headless" }, async (path) =>
    assert.equal((await loadConfig(path)).desktop, undefined),
  );
});

test("desktop default still requires the desktop block", async () => {
  const { desktop, ...headlessOnly } = validConfig;
  await withConfig(headlessOnly, (path) => assert.rejects(loadConfig(path), /missing_desktop/));
  await withConfig({ ...validConfig, defaultBackend: "headless", desktop: { baseUrl: "x" } }, (path) =>
    assert.rejects(loadConfig(path), /missing_authToken/));
});

// O vocabulario do vault: sem bloco, vale o portugues que os dois vaults usavam
// ate 2026-10, para a OFICINA seguir intacta enquanto o ENGENHARIA migra.
test("vocabulary defaults to the Portuguese names both vaults used", async () => {
  await withConfig(validConfig, async (path) => {
    const { vocabulary } = await loadConfig(path);
    assert.equal(vocabulary.statuses.aprovacao, "aprovacao");
    assert.equal(vocabulary.statuses["em-andamento"], "em-andamento");
    assert.deepEqual(vocabulary.fields, { responsavel: "Responsavel", marca: "Marca", projeto: "Projeto" });
  });
});

test("vocabulary maps roles to the names written in the vault", async () => {
  const vocabulary = {
    statuses: { "to-do": "open", "em-andamento": "in-progress", aprovacao: "review", pausa: "paused", concluido: "done", cancelado: "cancelled" },
    fields: { responsavel: "assignees", marca: "marca", projeto: "projects" },
  };
  await withConfig({ ...validConfig, vocabulary }, async (path) => {
    const loaded = (await loadConfig(path)).vocabulary;
    assert.equal(loaded.statuses.backlog, "backlog");
    assert.equal(loaded.statuses.aprovacao, "review");
    assert.equal(loaded.fields.responsavel, "assignees");
  });
});

test("vocabulary rejects unknown roles and two roles sharing one value", async () => {
  for (const vocabulary of [
    { statuses: { revisao: "review" } },
    { statuses: { concluido: "done", cancelado: "done" } },
    { fields: { responsavel: "" } },
  ]) {
    await withConfig({ ...validConfig, vocabulary }, async (path) => {
      await assert.rejects(loadConfig(path), /invalid_vocabulary/);
    });
  }
});
