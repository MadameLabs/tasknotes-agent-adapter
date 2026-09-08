import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Alguns testes exercitam a integracao com o workspace que consome o
// adaptador: o wrapper de hook do Claude, o hooks.json do Codex. Esses
// arquivos nao pertencem a este repositorio, entao o caminho vem do ambiente
// -- TASKNOTES_WORKSPACE=C:/madamelabs-code -- e, sem ele, o teste e pulado em
// vez de falhar. O default cobre o caso de o repo estar dentro do workspace.
const root = process.env.TASKNOTES_WORKSPACE
  ?? fileURLToPath(new URL("../../../", import.meta.url));

export function workspaceFile(relative) {
  const path = resolve(root, relative);
  return existsSync(path) ? path : null;
}
