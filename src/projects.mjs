import { PROJECT_STATUS_ROLES } from "./vocabulary.mjs";

export { PROJECT_STATUS_ROLES };

// Regra de transicao de projeto (andar 2 do mdbase-agentops): o status so muda
// com responsavel; sair de `ativo` exige desfecho, e pausar exige data de
// retomada futura. Voltar a `ativo` devolve `null` nos tres campos, o que
// apaga o campo do frontmatter -- o historico fica no Git da base.
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function dataValida(value) {
  if (!DATA.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function projectTransition({ role, desfecho, retomarEm, owner, today, vocabulary }) {
  if (!PROJECT_STATUS_ROLES.includes(role)) throw new Error(`invalid_project_status:${role}`);
  if (!owner) throw new Error("owner_obrigatorio");
  const status = vocabulary.projectStatuses[role];
  if (retomarEm !== undefined && role !== "pausado") throw new Error("retomada_so_em_pausa");
  if (role === "ativo") return { status, outcome: null, outcomeDate: null, resumeOn: null };
  const outcome = typeof desfecho === "string" ? desfecho.trim() : "";
  if (!outcome) throw new Error("desfecho_obrigatorio");
  let resumeOn = null;
  if (role === "pausado") {
    if (retomarEm === undefined) throw new Error("retomada_obrigatoria");
    if (!dataValida(retomarEm)) throw new Error("retomada_invalida");
    if (retomarEm <= today) throw new Error("retomada_no_passado");
    resumeOn = retomarEm;
  }
  return { status, outcome, outcomeDate: today, resumeOn };
}
