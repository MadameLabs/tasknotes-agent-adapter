// Resumo de projeto a partir das tarefas, e a fila de revisao. Funcoes puras:
// o backend entrega projetos e tarefas, e o CLI decide o que mostrar. A
// contagem de tarefas e informacao; nada aqui muda status de projeto.

const WIKILINK = /^\[\[[^\]]+\]\]$/;
const day = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

export function projectName(link) {
  const inner = String(link ?? "").trim().replace(/^\[\[|\]\]$/g, "").split("|")[0];
  return inner.split("/").pop().replace(/\.md$/, "");
}

function lastActivityOf(task) {
  const dates = [...(task.timeEntries ?? []).map((entry) => day(entry?.startTime)), day(task.completedDate), day(task.dateCreated)];
  return dates.filter(Boolean).sort().at(-1) ?? null;
}

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

export function summarizeProjects(projects, tasks, { vocabulary }) {
  const roleByValue = new Map(Object.entries(vocabulary.projectStatuses).map(([role, value]) => [value, role]));
  const closedTask = new Set([vocabulary.statuses.concluido, vocabulary.statuses.cancelado]);
  const known = new Set(projects.map((project) => project.name));
  const byProject = new Map();
  const orphans = new Map();
  for (const task of tasks) {
    for (const name of new Set(asList(task.projects).map(projectName).filter(Boolean))) {
      if (!known.has(name)) {
        orphans.set(name, [...(orphans.get(name) ?? []), task.path]);
        continue;
      }
      byProject.set(name, [...(byProject.get(name) ?? []), task]);
    }
  }
  const items = projects.map(({ path, name, frontmatter: fm }) => {
    const linked = byProject.get(name) ?? [];
    const open = linked.filter((task) => !closedTask.has(task.status));
    return {
      path,
      name,
      brand: fm.brand ?? null,
      status: roleByValue.get(fm.status) ?? null,
      owner: typeof fm.owner === "string" && WIKILINK.test(fm.owner) ? fm.owner : null,
      outcome: fm.outcome ?? null,
      outcomeDate: day(fm.outcomeDate),
      resumeOn: day(fm.resumeOn),
      openTasks: open.length,
      totalTasks: linked.length,
      lastActivity: linked.map(lastActivityOf).filter(Boolean).sort().at(-1) ?? null,
      openTaskPaths: open.map((task) => task.path),
    };
  });
  const orphanLinks = [...orphans].map(([name, paths]) => ({ name, tasks: paths })).sort((a, b) => a.name.localeCompare(b.name));
  return { items, orphanLinks };
}

const REASONS = ["retomada_vencida", "sem_responsavel", "status_desconhecido", "parado", "aguardando_aprovacao"];

function minusDays(today, days) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function reasonFor(item, { today, limite }) {
  if (item.status === "concluido" || item.status === "cancelado") return null;
  if (item.status === "pausado" && item.resumeOn && item.resumeOn <= today) return "retomada_vencida";
  if (!item.owner) return "sem_responsavel";
  if (!item.status) return "status_desconhecido";
  if (item.status === "ativo" && (!item.lastActivity || item.lastActivity < limite)) return "parado";
  if (item.status === "aprovacao") return "aguardando_aprovacao";
  return null;
}

export function reviewQueue(items, { today, paradoHa = 30 }) {
  const limite = minusDays(today, paradoHa);
  return items
    .map((item) => ({ ...item, reason: reasonFor(item, { today, limite }) }))
    .filter((item) => item.reason)
    .sort((a, b) => REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason) || a.name.localeCompare(b.name));
}
