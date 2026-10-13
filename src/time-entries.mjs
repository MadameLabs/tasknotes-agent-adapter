import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Corrigir uma entrada de tempo e escrita retroativa no historico do vault, e
// por isso ela segue as mesmas regras do resto do adaptador: a entrada e
// endereçada pela identidade (o startTime gravado), nunca por posicao ou por
// "a ultima"; entrada aberta nao se corrige, se para com `stop`; e a correcao
// nao pode criar tempo sobreposto dentro da mesma tarefa.
const instant = (value, code) => {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) throw new Error(code);
  return date;
};

export function retimeEntries(entries, { startTime, newStart, newEnd }) {
  if (!startTime) throw new Error("missing_entry_start_time");
  if (newStart === undefined && newEnd === undefined) throw new Error("missing_new_time");
  const list = Array.isArray(entries) ? entries : [];
  const index = list.findIndex((entry) => entry.startTime === startTime);
  if (index < 0) throw new Error("time_entry_not_found");
  const previous = list[index];
  if (!previous.endTime) throw new Error("time_entry_still_open");
  const updated = {
    ...previous,
    ...(newStart !== undefined ? { startTime: instant(newStart, "invalid_new_start").toISOString() } : {}),
    ...(newEnd !== undefined ? { endTime: instant(newEnd, "invalid_new_end").toISOString() } : {}),
  };
  const start = new Date(updated.startTime);
  const end = new Date(updated.endTime);
  if (end <= start) throw new Error("end_not_after_start");
  if (end > new Date()) throw new Error("end_in_future");
  const overlaps = list.some((entry, other) => other !== index
    && new Date(entry.startTime) < end
    && (entry.endTime ? new Date(entry.endTime) : new Date()) > start);
  if (overlaps) throw new Error("time_entry_overlap");
  // Duracao gravada pelo plugin deixaria de bater com o intervalo novo.
  delete updated.duration;
  return { entries: list.map((entry, other) => other === index ? updated : entry), previous, updated };
}

// Onde cada agente guarda o transcript da sessao. O que conta como atividade e
// mensagem ou chamada de ferramenta: resumo de ausencia, troca de configuracao
// ao retomar e custo da sessao sao gravados sem ninguem trabalhar, e foi um
// deles que fez uma sessao do Codex parecer viva um dia depois.
const TRANSCRIPTS = {
  claude: { root: (home) => join(home, ".claude", "projects"), depth: 1 },
  codex: { root: (home) => join(home, ".codex", "sessions"), depth: 3 },
};

function isActivity(agent, record) {
  if (agent === "claude") return (record.type === "user" || record.type === "assistant") && !record.isMeta;
  if (record.type === "response_item") return true;
  return record.type === "event_msg" && ["user_message", "agent_message", "task_complete"].includes(record.payload?.type);
}

async function findTranscript(dir, sessionId, depth) {
  let names;
  try { names = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  const file = names.find((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId));
  if (file) return join(dir, file.name);
  if (depth === 0) return null;
  for (const entry of names.filter((item) => item.isDirectory())) {
    const found = await findTranscript(join(dir, entry.name), sessionId, depth - 1);
    if (found) return found;
  }
  return null;
}

export async function lastActivity({ agent, sessionId, after, home = homedir() }) {
  const source = TRANSCRIPTS[agent];
  if (!source) throw new Error("unsupported_agent");
  const transcript = await findTranscript(source.root(home), sessionId, source.depth);
  if (!transcript) throw new Error("transcript_not_found");
  const floor = after ? instant(after, "invalid_after") : null;
  let last = null;
  for (const line of (await readFile(transcript, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record.timestamp || !isActivity(agent, record)) continue;
    const at = new Date(record.timestamp);
    if (Number.isNaN(at.getTime()) || (floor && at < floor)) continue;
    if (!last || at > last) last = at;
  }
  if (!last) throw new Error("no_activity_found");
  return { transcript, lastActivity: last.toISOString() };
}
