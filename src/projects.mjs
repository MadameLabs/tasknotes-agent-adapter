import { PROJECT_STATUS_ROLES } from "./vocabulary.mjs";

export { PROJECT_STATUS_ROLES };

// Regra de transicao de projeto (andar 2 do mdbase-agentops): o status so muda
// com responsavel; `aprovacao`, `pausa`, `concluido` e `cancelado` exigem
// desfecho, e `pausa` exige data de retomada futura. `backlog`, `to-do` e
// `em-andamento` sao trabalho aberto: devolvem `null` nos tres campos, o que
// apaga o campo do frontmatter -- o historico fica no Git da base.
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function dataValida(value) {
  if (!DATA.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Responsavel valido e um wikilink so, como string: `owner: Arthur` (texto) e
// `owner: ["[[A]]"]` (lista) sao legado e contam como sem responsavel, aqui e
// no resumo -- uma regra so para o que grava e para o que mostra.
const WIKILINK = /^\[\[[^\]]+\]\]$/;
export const normalizeOwner = (value) => (typeof value === "string" && WIKILINK.test(value.trim()) ? value.trim() : null);

const ABERTOS = new Set(["backlog", "to-do", "em-andamento"]);

export function projectTransition({ role, desfecho, retomarEm, owner, today, vocabulary }) {
  if (!PROJECT_STATUS_ROLES.includes(role)) throw new Error(`invalid_project_status:${role}`);
  if (!normalizeOwner(owner)) throw new Error("owner_obrigatorio");
  const status = vocabulary.projectStatuses[role];
  if (retomarEm !== undefined && role !== "pausa") throw new Error("retomada_so_em_pausa");
  if (ABERTOS.has(role)) return { status, outcome: null, outcomeDate: null, resumeOn: null };
  const outcome = typeof desfecho === "string" ? desfecho.trim() : "";
  if (!outcome) throw new Error("desfecho_obrigatorio");
  let resumeOn = null;
  if (role === "pausa") {
    if (retomarEm === undefined) throw new Error("retomada_obrigatoria");
    if (!dataValida(retomarEm)) throw new Error("retomada_invalida");
    if (retomarEm <= today) throw new Error("retomada_no_passado");
    resumeOn = retomarEm;
  }
  return { status, outcome, outcomeDate: today, resumeOn };
}

// Proximo marco: texto de uma linha e data opcional, que pode estar no passado
// (marco atrasado). Nao exige responsavel: e anotacao de planejamento.
export function milestoneFields({ marco, data, limpar = false }) {
  if (limpar) return { nextMilestone: null, nextMilestoneDate: null };
  const nextMilestone = typeof marco === "string" ? marco.trim() : "";
  if (!nextMilestone) throw new Error("marco_obrigatorio");
  if (data !== undefined && !dataValida(data)) throw new Error("data_invalida");
  return { nextMilestone, nextMilestoneDate: data ?? null };
}
