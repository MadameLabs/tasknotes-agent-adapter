import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_STATUS_ROLES, projectTransition } from "../src/projects.mjs";
import { resolveVocabulary } from "../src/vocabulary.mjs";

const vocabulary = resolveVocabulary(undefined);
const today = "2026-11-11";
const owner = "[[Arthur Cardoso]]";
const go = (input) => projectTransition({ owner, today, vocabulary, ...input });

test("os papeis de projeto sao os cinco do design", () => {
  assert.deepEqual(PROJECT_STATUS_ROLES, ["ativo", "pausado", "aprovacao", "concluido", "cancelado"]);
});

test("concluir grava desfecho e data de hoje", () => {
  assert.deepEqual(go({ role: "concluido", desfecho: "entregue" }),
    { status: "concluido", outcome: "entregue", outcomeDate: "2026-11-11", resumeOn: null });
});

test("pausar grava o motivo e a data de retomada", () => {
  assert.deepEqual(go({ role: "pausado", desfecho: "cliente sumiu", retomarEm: "2026-12-01" }),
    { status: "pausado", outcome: "cliente sumiu", outcomeDate: "2026-11-11", resumeOn: "2026-12-01" });
});

test("voltar a ativo apaga desfecho, data e retomada", () => {
  assert.deepEqual(go({ role: "ativo" }), { status: "ativo", outcome: null, outcomeDate: null, resumeOn: null });
});

test("fechar sem desfecho e recusado", () => {
  assert.throws(() => go({ role: "concluido" }), /^Error: desfecho_obrigatorio$/);
  assert.throws(() => go({ role: "cancelado", desfecho: "   " }), /^Error: desfecho_obrigatorio$/);
});

test("pausa exige data de retomada valida e futura", () => {
  assert.throws(() => go({ role: "pausado", desfecho: "x" }), /^Error: retomada_obrigatoria$/);
  assert.throws(() => go({ role: "pausado", desfecho: "x", retomarEm: "11/12/2026" }), /^Error: retomada_invalida$/);
  assert.throws(() => go({ role: "pausado", desfecho: "x", retomarEm: "2026-02-30" }), /^Error: retomada_invalida$/);
  assert.throws(() => go({ role: "pausado", desfecho: "x", retomarEm: "2026-11-11" }), /^Error: retomada_no_passado$/);
});

test("data de retomada so cabe em pausa", () => {
  assert.throws(() => go({ role: "concluido", desfecho: "x", retomarEm: "2026-12-01" }), /^Error: retomada_so_em_pausa$/);
});

test("sem responsavel nenhuma transicao passa", () => {
  assert.throws(() => go({ role: "ativo", owner: null }), /^Error: owner_obrigatorio$/);
});

test("papel desconhecido e recusado pelo nome", () => {
  assert.throws(() => go({ role: "feito", desfecho: "x" }), /^Error: invalid_project_status:feito$/);
});

test("o valor gravado vem do vocabulario do vault", () => {
  const custom = resolveVocabulary({ projectStatuses: { concluido: "done" } });
  assert.equal(projectTransition({ role: "concluido", desfecho: "x", owner, today, vocabulary: custom }).status, "done");
});

test("owner legado em texto puro ou lista nao conta como responsavel", () => {
  assert.throws(() => go({ role: "concluido", desfecho: "x", owner: "Arthur" }), /^Error: owner_obrigatorio$/);
  assert.throws(() => go({ role: "cancelado", desfecho: "x", owner: ["[[Arthur Cardoso]]"] }), /^Error: owner_obrigatorio$/);
});
