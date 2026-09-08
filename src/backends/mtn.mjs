import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const closed = new Set(["concluido", "cancelado"]);

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
  //
  // O --limit e obrigatorio: `mtn list` devolve 50 por padrao, e essa lista nao
  // alimenta so o `open` -- e por ela que findTask, getActiveTimers e
  // verifyTimer enxergam o vault. Sem limite, a tarefa numero 51 fica invisivel
  // ao adaptador: o cronometro dela nao e verificado, `stop` nao para nada e
  // `start` morre em timer_not_verified. Os dois vaults ja passavam de 50
  // quando isso foi descoberto.
  const listTasks = async () => JSON.parse((await invoke(["list", "--json", "--limit", "100000"])).replace(/^﻿/, ""));
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
    // O mtn tem `promote` (fork MadameLabs, commit 5fdabaf): ele grava a tag
    // `task`, o status inicial e as tres listas de uma vez, e e ele quem sabe
    // escrever lista sem derrubar a leitura da colecao. Ja se tentou trocar
    // isso por uma composicao de `update --set-new-list`, por causa de um
    // clone parado numa branch anterior ao comando: o sintoma foi
    // `mtn_failed:unknown command 'promote'`, que quer dizer clone velho, nao
    // comando inexistente. Conferir com `git log --oneline fork/main` antes de
    // concluir que o mtn nao tem o que o adaptador chama.
    promoteTask: (path, { responsavel, marca, projeto }) => invoke([
      "promote", path,
      "--responsavel", responsavel,
      "--marca", marca,
      "--projeto", projeto,
    ]),
    verifyTimer: async (path, identity) =>
      (await getActiveTimers()).some((item) => item.task.id === path && item.session.startTime === identity?.startTime),
    createTask: () => { throw new Error("unsafe_backend_missing"); },
    setProjects: () => { throw new Error("unsafe_backend_missing"); },
  };
}
