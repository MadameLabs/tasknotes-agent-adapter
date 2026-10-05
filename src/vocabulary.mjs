// Os papeis sao o que o agente diz -- `--status aprovacao`, `--responsavel` --
// e nao mudam de um vault para outro. O vocabulario de cada vault diz como cada
// papel se escreve no arquivo: o ENGENHARIA passou a gravar `review` e
// `assignees` em 2026-10, a BIBLIOTECA continua em portugues. Sem bloco no
// config vale o portugues, que era o unico vocabulario ate entao.
export const STATUS_ROLES = ["backlog", "to-do", "em-andamento", "aprovacao", "pausa", "concluido", "cancelado"];
const FIELD_ROLES = { responsavel: "Responsavel", marca: "Marca", projeto: "Projeto" };

export const DEFAULT_VOCABULARY = {
  statuses: Object.fromEntries(STATUS_ROLES.map((role) => [role, role])),
  fields: { ...FIELD_ROLES },
};

function merge(defaults, override, label) {
  if (override === undefined) return { ...defaults };
  if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error(`invalid_vocabulary:${label}`);
  for (const [role, value] of Object.entries(override)) {
    if (!(role in defaults)) throw new Error(`invalid_vocabulary:${label}.${role}`);
    if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_vocabulary:${label}.${role}`);
  }
  const merged = { ...defaults, ...override };
  // Dois papeis com o mesmo valor tornam o desfecho ambiguo: `concluido` e
  // `cancelado` gravando `done` apagariam a diferenca que o status existe
  // para registrar.
  const values = Object.values(merged);
  if (new Set(values).size !== values.length) throw new Error(`invalid_vocabulary:${label}_duplicated`);
  return merged;
}

export function resolveVocabulary(raw) {
  if (raw === undefined) return { statuses: { ...DEFAULT_VOCABULARY.statuses }, fields: { ...DEFAULT_VOCABULARY.fields } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_vocabulary");
  return {
    statuses: merge(DEFAULT_VOCABULARY.statuses, raw.statuses, "statuses"),
    fields: merge(DEFAULT_VOCABULARY.fields, raw.fields, "fields"),
  };
}

// Aceita o papel ou o proprio valor do vault: quem ja escreve `review` no
// ENGENHARIA nao precisa traduzir de volta para `aprovacao`.
export function statusValue(vocabulary, input) {
  if (typeof input !== "string") return null;
  if (Object.hasOwn(vocabulary.statuses, input)) return vocabulary.statuses[input];
  return Object.values(vocabulary.statuses).includes(input) ? input : null;
}

export const closedStatuses = (vocabulary) => new Set([vocabulary.statuses.concluido, vocabulary.statuses.cancelado]);
