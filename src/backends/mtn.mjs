import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_VOCABULARY, closedStatuses } from "../vocabulary.mjs";

const run = promisify(execFile);
const wikilink = (value) => value.startsWith("[[") ? value : `[[${value}]]`;

// O mtn nao expoe timer nem tarefa em JSON: `list --json` e a unica saida
// estruturada, e nela uma entrada de tempo sem endTime e um timer correndo.
const openEntry = (task) => (task.timeEntries ?? []).find((entry) => !entry.endTime);

export function createMtnBackend({ mtnPath, vaultPath, mtnArgs = [], vocabulary = DEFAULT_VOCABULARY }) {
  const closed = closedStatuses(vocabulary);
  // Tarefa nasce em `backlog`: trabalho aceito, ainda nao priorizado. O mesmo
  // papel esta em tasknotes-api.mjs, para os dois backends nascerem igual.
  const initialStatus = vocabulary.statuses.backlog;
  const { fields } = vocabulary;
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
  // Sem filtro, o `mtn list` esconde `concluido` e `cancelado`. Para abrir a
  // lista de trabalho isso e o certo; para achar tarefa e cronometro, nao: o
  // `stop` grava o status antes de parar o cronometro, e a tarefa sumia da
  // janela bem no meio -- o adaptador respondia `timer_already_closed` e a
  // entrada de tempo ficava aberta. Um `--where` explicito desliga esse filtro
  // padrao (e o de arquivadas) e mantem so o filtro de "e tarefa".
  const listAllTasks = async () => JSON.parse((await invoke(["list", "--json", "--limit", "100000", "--where", "true"])).replace(/^﻿/, ""));
  const findTask = async (path) => (await listAllTasks()).find((task) => task.path === path) ?? null;

  // Uma escrita so: tag, status inicial e as tres listas com os nomes do
  // vault. O `mtn promote` do fork grava Responsavel, Marca, Projeto e `to-do`
  // literais, e por isso deixou de servir quando o ENGENHARIA passou a gravar
  // `assignees` e `projects`. O `update` promove nota comum pela tag desde que
  // `type` nao esteja em `explicit_type_keys` -- os dois vaults usam `types`.
  const promote = (path, { responsavel, marca, projeto }) => invoke([
    "update", path,
    "--add-tag", "task",
    "--status", initialStatus,
    "--set-new-list", `${fields.responsavel}=${responsavel}`,
    "--set-new-list", `${fields.marca}=${marca}`,
    "--set-new-list", `${fields.projeto}=${projeto}`,
  ]);

  async function getActiveTimers() {
    return (await listAllTasks()).flatMap((task) => {
      const entry = openEntry(task);
      return entry ? [{ task: { id: task.path }, session: { startTime: entry.startTime } }] : [];
    });
  }

  return {
    listOpen: async () => (await listTasks()).filter((task) => !task.archived && !closed.has(task.status)),
    getTask: findTask,
    getActiveTimers,
    // O plugin grava `completedDate` sozinho quando a tarefa fecha; o `mtn
    // update --status` nao, e o contrato tasknotes.task recusa `done` sem data
    // -- foram 62 notas assim no ENGENHARIA. O nome vem do mapeamento da
    // colecao (`dataConclusao` na BIBLIOTECA). Reabrir nao limpa a data: o mtn
    // nao remove campo, e o plugin corrige ao tocar na nota.
    setStatus: (path, status) => invoke([
      "update", path, "--status", status,
      ...(closed.has(status) ? ["--set-new", `completedDate=${new Date().toLocaleDateString("sv-SE")}`] : []),
    ]),
    async startTimer(path) {
      await invoke(["timer", "start", path]);
      // Identidade lida de volta do vault, nunca do relogio local: e ela que
      // autoriza a parada depois.
      const startTime = openEntry(await findTask(path) ?? {})?.startTime;
      if (!startTime) throw new Error("timer_not_verified");
      return { taskPath: path, startTime };
    },
    stopTimer: (path) => invoke(["timer", "stop", path]),
    promoteTask: promote,
    // O `mtn create` so aceita texto livre e nao grava responsavel, marca nem
    // projeto: a nota nasce e passa pelo mesmo promote de uma nota existente.
    // O caminho vem da linha "→ <caminho>" que o create imprime, porque o parser
    // de linguagem natural do mtn pode tirar pedacos do titulo (datas, #tags).
    async createTask({ title, responsavel, marcas, projeto }) {
      const printed = (await invoke(["create", title])).replace(/\[[0-9;]*m/g, "");
      const path = printed.split(/[\r\n]+/).map((line) => line.trim()).find((line) => line.startsWith("→"))?.replace(/^→\s*/, "");
      if (!path) throw new Error("mtn_failed:create_path_not_printed");
      await promote(path, { responsavel: wikilink(responsavel), marca: wikilink(marcas[0]), projeto: wikilink(projeto) });
      const task = await findTask(path);
      if (!task) throw new Error("task_not_verified");
      return task;
    },
    verifyTimer: async (path, identity) =>
      (await getActiveTimers()).some((item) => item.task.id === path && item.session.startTime === identity?.startTime),
    // `--set-new-list` monta a lista do zero na primeira atribuicao e acumula
    // nas seguintes: troca a lista inteira, como o PUT do backend desktop. O
    // nome do campo vem do vocabulario: `Projeto` na BIBLIOTECA, `projects` no
    // ENGENHARIA.
    setProjects: (path, projetos) => invoke([
      "update", path,
      ...projetos.flatMap((projeto) => ["--set-new-list", `${fields.projeto}=${wikilink(projeto)}`]),
    ]),
  };
}
