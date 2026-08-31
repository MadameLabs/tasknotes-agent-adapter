import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const closed = new Set(["concluido", "cancelado"]);
const wikilink = (value) => value.startsWith("[[") ? value : `[[${value}]]`;

// O mtn nao expoe timer nem tarefa em JSON: `list --json` e a unica saida
// estruturada, e nela uma entrada de tempo sem endTime e um timer correndo.
const openEntry = (task) => (task.timeEntries ?? []).find((entry) => !entry.endTime);

export function createMtnBackend({ mtnPath, vaultPath, mtnArgs = [] }) {
  // Fixar o mtn por revisao significa apontar para o dist/cli.js do clone, que
  // o execFile nao sabe executar sozinho: entao chamamos o node deste processo.
  const isScript = /\.[cm]?js$/i.test(mtnPath);
  const command = isScript ? process.execPath : mtnPath;
  const prefix = isScript ? [mtnPath, ...mtnArgs] : mtnArgs;
  async function invoke(args) {
    try {
      const { stdout } = await run(command, [...prefix, ...args, "--path", vaultPath], { windowsHide: true });
      return stdout;
    } catch (error) {
      // O mtn imprime a causa como "✗ unknown_field:Responsavel" e sai com 1.
      // Reduzir tudo a "mtn_failed:1" jogava fora justamente essa linha, que e
      // a unica que diz o que precisa ser corrigido.
      const printed = [error.stdout, error.stderr].filter(Boolean).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
      const lines = printed.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
      const reason = (lines.find((line) => line.startsWith("✗")) ?? lines[0] ?? "").replace(/^✗\s*/, "");
      throw new Error(`mtn_failed:${reason || error.code || "unknown"}`);
    }
  }
  // O CLI pode emitir BOM quando o console do Windows esta em UTF-8.
  const listTasks = async () => JSON.parse((await invoke(["list", "--json"])).replace(/^﻿/, ""));
  const findTask = async (path) => (await listTasks()).find((task) => task.path === path) ?? null;

  async function getActiveTimers() {
    return (await listTasks()).flatMap((task) => {
      const entry = openEntry(task);
      return entry ? [{ task: { id: task.path }, session: { startTime: entry.startTime } }] : [];
    });
  }

  return {
    listOpen: async () => (await listTasks()).filter((task) => !task.archived && !closed.has(task.status)),
    getTask: findTask,
    getActiveTimers,
    setStatus: (path, status) => invoke(["update", path, "--status", status]),
    async startTimer(path) {
      await invoke(["timer", "start", path]);
      // Identidade lida de volta do vault, nunca do relogio local: e ela que
      // autoriza a parada depois.
      const startTime = openEntry(await findTask(path) ?? {})?.startTime;
      if (!startTime) throw new Error("timer_not_verified");
      return { taskPath: path, startTime };
    },
    stopTimer: (path) => invoke(["timer", "stop", path]),
    // `update` aceita os campos de lista e preserva o `type` original da nota.
    promoteTask: (path, { responsavel, marca, projeto }) => invoke([
      "update", path,
      "--add-tag", "task",
      "--set-new-list", `Responsavel=${wikilink(responsavel)}`,
      "--set-new-list", `Marca=${wikilink(marca)}`,
      "--set-new-list", `Projeto=${wikilink(projeto)}`,
    ]),
    async createTask(input) {
      const before = new Set((await listTasks()).map((task) => task.path));
      await invoke(["create", input.title]);
      const created = (await listTasks()).find((task) => !before.has(task.path) && task.title === input.title);
      if (!created) throw new Error("created_task_not_found");
      await invoke([
        "update", created.path,
        "--add-tag", "task",
        "--set-new-list", `Responsavel=${wikilink(input.responsavel)}`,
        "--set-new-list", `Marca=${wikilink(input.marcas?.[0] ?? "Madame_Labs")}`,
        "--set-new-list", `Projeto=${wikilink(input.projeto)}`,
      ]);
      return (await findTask(created.path)) ?? created;
    },
    verifyTimer: async (path, identity) =>
      (await getActiveTimers()).some((item) => item.task.id === path && item.session.startTime === identity?.startTime),
    setProjects: () => { throw new Error("unsafe_backend_missing"); },
  };
}
