import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createTaskNotesApiBackend } from "../src/backends/tasknotes-api.mjs";

async function withServer(run) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== "Bearer token") return reply(401, { success: false, error: "unauthorized" });
    if (req.url === "/api/tasks?limit=200&offset=0") return reply(200, { success: true, data: { tasks: [{ id: "a", status: "to-do" }], pagination: { hasMore: true } } });
    if (req.url === "/api/tasks?limit=200&offset=200") return reply(200, { success: true, data: { tasks: [{ id: "b", status: "cancelado" }], pagination: { hasMore: false } } });
    if (req.url === "/api/tasks/a") return reply(200, { success: true, data: { id: "a", status: "to-do" } });
    if (req.url === "/api/tasks" && req.method === "POST") return reply(200, { success: true, data: { id: "new task.md", Responsavel: ["Madame_Labs"] } });
    if (req.url === "/api/tasks/new%20task.md" && req.method === "PUT") return reply(200, { success: true, data: {} });
    if (req.url === "/api/tasks/new%20task.md" && req.method === "GET") return reply(200, { success: true, data: { id: "new task.md", Responsavel: ["[[Arthur_Cardoso]]"], Marca: ["[[Madame_Labs]]"] } });
    if (req.url === "/api/tasks/a/time/start") return reply(200, { success: true, data: {} });
    if (req.url === "/api/time/active") return reply(200, { success: true, data: { activeSessions: [{ task: { id: "a" }, session: { startTime: "2026-08-19T00:00:00Z" } }] } });
    if (req.url === "/api/tasks/a/time/stop") return reply(200, { success: true, data: {} });
    reply(404, { success: false, error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try { await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, calls }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("paginates open tasks and creates fields through the documented two-step write", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    const api = createTaskNotesApiBackend({ baseUrl, authToken: "token" });
    assert.deepEqual((await api.listOpen()).map((task) => task.id), ["a"]);
    await api.createTask({ title: "Nova", responsavel: "Arthur_Cardoso", marcas: ["Madame_Labs"], projeto: "Projeto" });
    assert.deepEqual(calls.find((call) => call.method === "POST").body.projects, ["[[Projeto]]"]);
    assert.deepEqual(calls.find((call) => call.method === "PUT").body, { Responsavel: ["[[Arthur_Cardoso]]"], Marca: ["[[Madame_Labs]]"] });
  });
});

// O POST responde antes do PUT que grava Responsavel e Marca, e o campo ainda
// carrega o defaultValue do user field do plugin -- devolver aquele retrato
// fazia o CLI anunciar "Responsavel: Madame_Labs", como se marca e responsavel
// tivessem trocado de lugar, com o disco correto o tempo todo.
test("createTask reports the task read back after the update, not the POST snapshot", async () => {
  await withServer(async ({ baseUrl }) => {
    const api = createTaskNotesApiBackend({ baseUrl, authToken: "token" });
    const task = await api.createTask({ title: "Nova", responsavel: "Arthur_Cardoso", marcas: ["Madame_Labs"], projeto: "Projeto" });
    assert.deepEqual(task.Responsavel, ["[[Arthur_Cardoso]]"]);
    assert.deepEqual(task.Marca, ["[[Madame_Labs]]"]);
    assert.equal(task.path, "new task.md");
  });
});

test("verifies the timer identity from active sessions", async () => {
  await withServer(async ({ baseUrl }) => {
    const api = createTaskNotesApiBackend({ baseUrl, authToken: "token" });
    assert.deepEqual(await api.startTimer("a"), { taskPath: "a", startTime: "2026-08-19T00:00:00Z" });
    assert.equal(await api.verifyTimer("a", { taskPath: "a", startTime: "2026-08-19T00:00:00Z" }), true);
    await api.stopTimer("a");
  });
});

test("sets projects through the documented task update endpoint", async () => {
  await withServer(async ({ baseUrl, calls }) => {
    const api = createTaskNotesApiBackend({ baseUrl, authToken: "token" });
    await api.setProjects("a", ["Projeto", "[[Outro]]"]);
    const put = calls.find((call) => call.method === "PUT" && call.url === "/api/tasks/a");
    assert.deepEqual(put.body, { projects: ["[[Projeto]]", "[[Outro]]"] });
  });
});
