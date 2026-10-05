# CLAUDE.md — tasknotes-agent-adapter

## O que é

Adaptador que dá a agentes de linha de comando uma forma segura de abrir, cronometrar e encerrar tarefas do TaskNotes num vault do Obsidian. Não reimplementa o TaskNotes: faz só o que é específico de agente — gate de sessão, vínculo sessão↔tarefa, lease e identidade do cronômetro.

Este repositório nasceu de `madamelabs-code/agent-adapter` por `git subtree split`, para poder ser instalado em máquinas que não têm o hub. O histórico anterior à extração é o do hub, e por isso os primeiros commits têm mensagens de sincronização de vault.

## Regras que não se negociam

- **`stop` exige `--status`.** Um desfecho padrão mentiria sobre o que aconteceu com a tarefa. Os sete status são `backlog`, `to-do`, `em-andamento`, `aprovacao`, `pausa`, `concluido` e `cancelado`. O `backlog` foi declarado em 2026-09-08 para dar realidade ao par de workflows `promover-backlog-ao-agendar` e `retornar-to-do-ao-backlog-ao-desagendar`, que operava sobre um status inexistente.
- **Os sete status são papéis, não valores.** O bloco `vocabulary` do config traduz cada papel para o valor gravado naquele vault (`aprovacao` → `review` no ENGENHARIA desde 2026-10); o mesmo vale para os campos `responsavel`, `marca` e `projeto`. Nunca escrever valor ou nome de campo literal no código: usar `src/vocabulary.mjs`.
- **Em caso de dúvida ou indisponibilidade, o cronômetro fica vivo.** Parar o timer errado é falha mais grave do que deixar timer pendente.
- **Toda operação destrutiva é endereçada pelo caminho exato da tarefa.** Nunca existe fallback para "o primeiro timer ativo".
- **`recover` exige o dono esperado.** Liberar lease é explícito e nunca automático.
- **Nada de Google Tasks.** Existe teste que falha se o entrypoint ganhar essa dependência.

## Backends

`desktop` fala com a API do plugin TaskNotes; `headless` executa o `mtn`. Duas escolhas são automáticas e não obedecem a `--backend`:

- `promote` usa sempre o headless, compondo um único `mtn update` (tag, status inicial e as três listas com os nomes do vocabulário) — o `mtn promote` do fork grava os nomes portugueses literais. A API do plugin responde 404 para nota que ainda não tem a tag `task`, e não existe endpoint de arquivo — promover é escrita de frontmatter num arquivo que ainda não é tarefa.
- `stop` e `hook-end` começam pelo backend gravado no vínculo pelo `start` e caem para o headless quando ele não responde. A identidade do cronômetro é o `startTime` lido do vault, e o `mtn` lê o mesmo arquivo que a API do plugin: verificar por outro backend não afrouxa nada.
- **Encerrar sessão não falha por indisponibilidade.** Obsidian fechado é condição esperada. Quando nenhum backend responde, o `hook-end` registra o cronômetro em `divergences`, solta vínculo e lease e sai com 0 — segurar a tarefa em nome de uma sessão morta era pior que o barulho. O `stop` explícito continua falhando alto, porque nele o status é um pedido que não foi atendido.

O `mtn` é dependência deste pacote, fixada por SHA, e resolvido por módulo em `src/mtn-path.mjs`. `headless.mtnPath` no config continua valendo e vence quando presente, para apontar um clone em desenvolvimento.

## Antes de concluir que o `mtn` não tem um comando

Confira `git log --oneline fork/main` no clone antes de acreditar em `unknown command`. Já aconteceu de um clone parado numa branch antiga fazer o `promote` parecer inexistente e levar à reversão de um commit correto do adaptador. `src/`, `dist/` e `--help` respondem todos a partir da branch em que o clone está.

## Testes

```bash
npm test
TASKNOTES_WORKSPACE=/caminho/do/workspace npm test   # inclui os testes de wrapper de hook
MTN_PATH=/caminho/do/dist/cli.js npm test            # contra um mtn em desenvolvimento
```

Os testes que dependem de arquivos do workspace consumidor — wrapper do Claude, `hooks.json` do Codex — pulam quando o workspace não é informado, em vez de falhar.

Ao mexer no adaptador, rodar a suíte inteira antes de concluir. Teste unitário que congela a chamada errada passa enquanto o de integração falha: foi assim que uma promoção quebrada sobreviveu uma semana.
