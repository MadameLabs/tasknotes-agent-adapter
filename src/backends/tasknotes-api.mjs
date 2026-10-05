import { DEFAULT_VOCABULARY, closedStatuses } from "../vocabulary.mjs";

const wikilink = (value) => value.startsWith("[[") ? value : `[[${value}]]`;

export function createTaskNotesApiBackend({ baseUrl, authToken, vocabulary = DEFAULT_VOCABULARY }) {
  const closed = closedStatuses(vocabulary);
  // Tarefa nasce em `backlog`: trabalho aceito, ainda nao priorizado. O `to-do`
  // e uma decisao de priorizacao, e quem a toma e a pessoa, nao o adaptador.
  // O mesmo papel esta em mtn.mjs, para os dois backends nascerem igual.
  const initialStatus = vocabulary.statuses.backlog;
  const { fields } = vocabulary;
  const base = baseUrl.replace(/\/$/, "");
  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json", ...options.headers },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) throw new Error(`tasknotes_api_error:${response.status}`);
    return payload.data ?? {};
  }
  const taskUrl = (path) => `/api/tasks/${encodeURIComponent(path)}`;
  async function getActiveTimers() { return (await request("/api/time/active")).activeSessions ?? []; }
  return {
    async listOpen() {
      const tasks = []; let offset = 0;
      for (;;) {
        const data = await request(`/api/tasks?limit=200&offset=${offset}`);
        tasks.push(...(data.tasks ?? []).filter((task) => !task.archived && !closed.has(task.status)));
        if (!data.pagination?.hasMore) return tasks;
        offset += 200;
      }
    },
    createTask: async (input) => {
      const body = { title: input.title, status: input.status ?? initialStatus };
      if (input.projeto) body.projects = [wikilink(input.projeto)];
      const created = await request("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      const path = created.id ?? created.path;
      if (input.responsavel || input.marcas?.length) {
        const patch = {};
        if (input.responsavel) patch[fields.responsavel] = [wikilink(input.responsavel)];
        if (input.marcas?.length) patch[fields.marca] = input.marcas.map(wikilink);
        await request(taskUrl(path), { method: "PUT", body: JSON.stringify(patch) });
        // O POST responde antes do PUT, e nesse retrato Responsavel ainda
        // carrega o defaultValue do user field do plugin. Devolver o retrato
        // fazia o CLI anunciar "Responsavel: Madame_Labs" numa tarefa cujo
        // disco dizia Arthur_Cardoso -- parecia marca e responsavel trocados.
        // Se a releitura falhar, o retrato antigo ainda e melhor que erro:
        // a tarefa ja existe no disco, e so o retorno fica pobre.
        const settled = await request(taskUrl(path)).catch(() => null);
        if (settled) return { ...settled, path };
      }
      return { ...created, path };
    },
    // A API do plugin so enxerga nota que ja e tarefa -- /api/tasks/<path>
    // responde 404 antes da tag `task` existir no arquivo --, entao promover
    // por aqui e impossivel por desenho, nao por falta de implementacao. Quem
    // promove e o headless, e o CLI ja o escolhe sozinho no comando promote.
    promoteTask: () => { throw new Error("promotion_requires_file_write"); },
    getTask: (path) => request(taskUrl(path)),
    setProjects: (path, projects) => request(taskUrl(path), { method: "PUT", body: JSON.stringify({ projects: projects.map(wikilink) }) }),
    getActiveTimers,
    setStatus: (path, status) => request(taskUrl(path), { method: "PUT", body: JSON.stringify({ status }) }),
    async startTimer(path) {
      await request(`${taskUrl(path)}/time/start`, { method: "POST", body: JSON.stringify({ description: "Work session" }) });
      const session = (await getActiveTimers()).find((item) => (item.task?.id ?? item.task?.path) === path);
      const startTime = session?.session?.startTime;
      if (!startTime) throw new Error("timer_not_verified");
      return { taskPath: path, startTime };
    },
    stopTimer: (path) => request(`${taskUrl(path)}/time/stop`, { method: "POST" }),
    async verifyTimer(path, identity) {
      return (await getActiveTimers()).some((item) =>
        (item.task?.id ?? item.task?.path) === path && item.session?.startTime === identity?.startTime,
      );
    },
  };
}
