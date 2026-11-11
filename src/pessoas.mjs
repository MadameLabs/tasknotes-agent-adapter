import { ANTIGOS, RESPONSAVEIS } from "./config.mjs";

// Responsavel e qualquer nota `type: pessoa` (BIBLIOTECA/11-pessoas/), nao so
// a lista de apelidos. Os apelidos continuam como atalho; nome de marca que ja
// fez papel de responsavel continua recusado, como no resolveResponsavel.
const semLink = (value) => value.trim().replace(/^\[\[|\]\]$/g, "");

export function isApelido(value) {
  return typeof value === "string" && RESPONSAVEIS.has(semLink(value).toLowerCase());
}

export function resolvePessoa(value, pessoas, { permitirGrupo = true } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error("responsavel_desconhecido:");
  const raw = semLink(value);
  if (ANTIGOS.has(raw)) {
    const apelido = ANTIGOS.get(raw);
    throw new Error(`responsavel_antigo: use ${apelido} (${RESPONSAVEIS.get(apelido).join(", ")})`);
  }
  const grupo = RESPONSAVEIS.get(raw.toLowerCase());
  if (grupo) {
    if (grupo.length > 1 && !permitirGrupo) throw new Error(`responsavel_grupo:${raw}`);
    return [...grupo];
  }
  if (pessoas.includes(raw)) return [raw];
  throw new Error(`responsavel_desconhecido:${raw}`);
}
