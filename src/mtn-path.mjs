import { fileURLToPath } from "node:url";

// O mtn viaja como dependencia deste pacote, fixada por SHA. Resolver por
// modulo em vez de caminho absoluto e o que faz `mtnPath` deixar de ser
// configuracao por maquina: o adaptador acha o CLI ao lado dele, esteja
// instalado global, num clone de desenvolvimento ou dentro de outro projeto.
// O pacote nao declara `exports`, entao o subcaminho resolve normalmente.
export function bundledMtnPath() {
  return fileURLToPath(import.meta.resolve("mdbase-tasknotes/dist/cli.js"));
}
