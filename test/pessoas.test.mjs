import assert from "node:assert/strict";
import test from "node:test";
import { isApelido, resolvePessoa } from "../src/pessoas.mjs";

const pessoas = ["Arthur Cardoso", "Mayara Almeida", "Lucilene"];

test("aceita qualquer pessoa da colecao pelo nome da nota", () => {
  assert.deepEqual(resolvePessoa("Lucilene", pessoas), ["Lucilene"]);
  assert.deepEqual(resolvePessoa("[[Lucilene]]", pessoas), ["Lucilene"]);
});

test("os apelidos continuam valendo como atalho", () => {
  assert.deepEqual(resolvePessoa("arthur", pessoas), ["Arthur Cardoso"]);
  assert.deepEqual(resolvePessoa("labs", pessoas), ["Arthur Cardoso", "Mayara Almeida"]);
  assert.equal(isApelido("Mayara"), true);
  assert.equal(isApelido("Lucilene"), false);
});

test("grupo e recusado onde so cabe uma pessoa", () => {
  assert.throws(() => resolvePessoa("labs", pessoas, { permitirGrupo: false }), /^Error: responsavel_grupo/);
});

test("nome sem nota de pessoa e recusado dizendo qual", () => {
  assert.throws(() => resolvePessoa("Fulano", pessoas), /^Error: responsavel_desconhecido:Fulano$/);
});

test("nome de marca antigo continua recusado com o apelido certo", () => {
  assert.throws(() => resolvePessoa("Madame_Labs", pessoas), /^Error: responsavel_antigo/);
});
