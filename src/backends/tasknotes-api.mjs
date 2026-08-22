const closed = new Set(["concluido", "cancelado"]);
const wikilink = (value) => value.startsWith("[[") ? value : `[[${value}]]`;

export function createTaskNotesApiBackend({ baseUrl, authToken }) {
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
      const body = { title: input.title, status: input.status ?? "to-do" };
      if (input.projeto) body.projects = [wikilink(input.projeto)];
      const created = await request("/api/tasks", { method: "POST", body: JSON.stringify(body) });
      const path = created.id ?? created.path;
      if (input.responsavel || input.marcas?.length) {
        const patch = {};
        if (input.responsavel) patch.Responsavel = [input.responsavel];
        if (input.marcas?.length) patch.Marca = input.marcas.map(wikilink);
        await request(taskUrl(path), { method: "PUT", body: JSON.stringify(patch) });
      }
      return { ...created, path };
    },
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
