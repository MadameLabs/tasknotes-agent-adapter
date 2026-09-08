// O mtn dos testes de integracao e o mesmo que o adaptador usa em producao: a
// dependencia fixada do pacote. MTN_PATH continua sobrescrevendo, para rodar a
// suite contra um clone em desenvolvimento.
import { bundledMtnPath } from "../src/mtn-path.mjs";

export const mtn = process.env.MTN_PATH ?? bundledMtnPath();
