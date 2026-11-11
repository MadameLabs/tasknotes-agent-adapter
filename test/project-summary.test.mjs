import assert from "node:assert/strict";
import test from "node:test";
import { filterQueueByOwner, projectName, reviewQueue, summarizeProjects } from "../src/project-summary.mjs";
import { resolveVocabulary } from "../src/vocabulary.mjs";

const vocabulary = resolveVocabulary(undefined);
const project = (name, frontmatter = {}) => ({ path: `02-marcas/a/Projetos/${name}.md`, name,
  frontmatter: { type: "projeto", brand: "[[A]]", status: "em-andamento", owner: "[[Arthur Cardoso]]", ...frontmatter } });
const task = (fields) => ({ path: `06-tarefas/Tasks/${Math.random()}.md`, status: "to-do", ...fields });
const summarize = (projects, tasks) => summarizeProjects(projects, tasks, { vocabulary });
const item = (projects, tasks, name = projects[0].name) => summarize(projects, tasks).items.find((entry) => entry.name === name);

test("projectName tira colchetes, alias, pasta e extensao", () => {
  assert.equal(projectName("[[02-marcas/x/Projetos/p|P]]"), "p");
  assert.equal(projectName("[[p.md]]"), "p");
  assert.equal(projectName("p"), "p");
});

test("atividade vem do cronometro, nunca do dateModified", () => {
  const p = [project("p")];
  assert.equal(item(p, [task({ projects: ["[[p]]"], timeEntries: [{ startTime: "2026-11-09T12:00:00Z" }], dateModified: "2026-11-10T00:00:00Z" })]).lastActivity, "2026-11-09");
  assert.equal(item(p, [task({ projects: ["[[p]]"], dateModified: "2026-11-10T00:00:00Z" })]).lastActivity, null);
  assert.equal(item(p, [task({ projects: ["[[p]]"], completedDate: "2026-10-01", dateCreated: "2026-09-01T10:00:00-03:00" })]).lastActivity, "2026-10-01");
});

test("tarefa fechada conta no total e nao nas abertas", () => {
  const summary = item([project("p")], [task({ projects: ["[[p]]"], status: "concluido" }), task({ projects: ["[[p|P]]"] })]);
  assert.equal(summary.totalTasks, 2);
  assert.equal(summary.openTasks, 1);
  assert.equal(summary.openTaskPaths.length, 1);
});

test("link para projeto inexistente vira orfao com o caminho da tarefa", () => {
  const orphan = task({ path: "06-tarefas/Tasks/o.md", projects: ["[[sumiu]]"] });
  assert.deepEqual(summarize([project("p")], [orphan]).orphanLinks, [{ name: "sumiu", tasks: ["06-tarefas/Tasks/o.md"] }]);
});

test("status fora do vocabulario e owner que nao e wikilink saem nulos", () => {
  const items = summarize([project("s", { status: "em andamento" }), project("t", { owner: "Arthur" }), project("u", { owner: ["[[A]]"] }), project("v", { status: undefined, owner: undefined })], []).items;
  assert.equal(items.find((entry) => entry.name === "s").status, null);
  assert.equal(items.find((entry) => entry.name === "t").owner, null);
  assert.equal(items.find((entry) => entry.name === "u").owner, null);
  assert.equal(items.find((entry) => entry.name === "v").status, null);
});

test("fila: retomada vencida primeiro, depois sem responsavel, status desconhecido, parado e aprovacao", () => {
  const items = summarize([
    project("aprov", { status: "aprovacao", outcome: "x" }),
    project("parado"),
    project("recente"),
    project("estranho", { status: "em andamento" }),
    project("orfao", { owner: "Arthur" }),
    project("retomar", { status: "pausa", outcome: "x", resumeOn: "2026-11-11" }),
    project("pausa-futura", { status: "pausa", outcome: "x", resumeOn: "2026-12-01" }),
  ], [
    task({ projects: ["[[parado]]"], timeEntries: [{ startTime: "2026-10-01T12:00:00Z" }] }),
    task({ projects: ["[[recente]]"], timeEntries: [{ startTime: "2026-10-20T12:00:00Z" }] }),
  ]).items;
  const queue = reviewQueue(items, { today: "2026-11-11", paradoHa: 30 });
  assert.deepEqual(queue.map((entry) => [entry.name, entry.reason]), [
    ["retomar", "retomada_vencida"],
    ["orfao", "sem_responsavel"],
    ["estranho", "status_desconhecido"],
    ["parado", "parado"],
    ["aprov", "aguardando_aprovacao"],
  ]);
});

test("projeto fechado nao entra na fila, nem sem responsavel", () => {
  const items = summarize([project("fim", { status: "concluido", outcome: "x", owner: undefined })], []).items;
  assert.deepEqual(reviewQueue(items, { today: "2026-11-11" }), []);
});

test("pausado sem data de retomada entra na fila como pausa_sem_retomada", () => {
  const items = summarize([project("leg", { status: "pausa", outcome: "x" })], []).items;
  assert.deepEqual(reviewQueue(items, { today: "2026-11-11" }).map((entry) => entry.reason), ["pausa_sem_retomada"]);
});

test("filtro por pessoa mantem todo projeto sem responsavel, qualquer que seja o motivo", () => {
  const items = summarize([
    project("venceu", { status: "pausa", outcome: "x", resumeOn: "2026-11-01", owner: undefined }),
    project("da-mayara", { owner: "[[Mayara Almeida]]" }),
    project("meu"),
  ], []).items;
  const queue = filterQueueByOwner(reviewQueue(items, { today: "2026-11-11" }), "[[Arthur Cardoso]]");
  assert.deepEqual(queue.map((entry) => entry.name).sort(), ["meu", "venceu"]);
});

test("fechado ou pausado sem desfecho vem antes de tudo na fila, mesmo fechado", () => {
  const items = summarize([
    project("venceu", { status: "pausa", outcome: "x", resumeOn: "2026-11-01" }),
    project("arrastado", { status: "concluido" }),
    project("certo", { status: "concluido", outcome: "entregue" }),
  ], []).items;
  assert.deepEqual(reviewQueue(items, { today: "2026-11-11" }).map((entry) => [entry.name, entry.reason]),
    [["arrastado", "desfecho_ausente"], ["venceu", "retomada_vencida"]]);
});

test("o resumo traz o proximo marco", () => {
  const summary = item([project("p", { nextMilestone: "lançar", nextMilestoneDate: "2026-12-01" })], []);
  assert.equal(summary.nextMilestone, "lançar");
  assert.equal(summary.nextMilestoneDate, "2026-12-01");
});

test("parado vale para em-andamento; backlog parado nao entra na fila", () => {
  const items = summarize([project("fila"), project("espera", { status: "backlog" })], []).items;
  assert.deepEqual(reviewQueue(items, { today: "2026-11-11" }).map((entry) => entry.name), ["fila"]);
});
