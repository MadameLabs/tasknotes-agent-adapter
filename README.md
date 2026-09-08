# tasknotes-agent-adapter

Adaptador que dá a agentes de linha de comando — Claude Code, Codex, opencode — uma forma segura de abrir, cronometrar e encerrar tarefas do [TaskNotes](https://tasknotes.dev) num vault do Obsidian.

Ele não reimplementa o TaskNotes. Faz só o que é específico de agente: o gate que obriga a sessão a nomear em que tarefa está trabalhando, o vínculo entre sessão de chat e tarefa, o lease que impede duas sessões de disputarem a mesma tarefa, e a identidade do cronômetro, que é o que autoriza pará-lo depois.

## Dois backends

| | `desktop` | `headless` |
| --- | --- | --- |
| Fala com | a API HTTP do plugin TaskNotes | o CLI `mtn` (`mdbase-tasknotes`) |
| Precisa do Obsidian aberto | sim | não |
| Sabe criar tarefa do zero | sim | não |
| Sabe promover nota que ainda não é tarefa | não | sim |

O padrão é `desktop`; `--backend headless` escolhe o outro, e `defaultBackend` no config muda o padrão. Duas exceções são automáticas: `promote` usa sempre o headless, porque a API do plugin responde 404 para nota que ainda não tem a tag `task`; e `stop` começa pelo backend gravado no vínculo pelo `start`, porque é dele a identidade do cronômetro. Quando esse backend não responde — Obsidian fechado —, o encerramento cai para o headless, que lê o mesmo arquivo do vault e verifica a mesma identidade. Se nenhum dos dois responder, o `hook-end` registra o cronômetro em `divergences`, solta vínculo e lease e sai com 0; o `stop` explícito falha alto, porque nele o status é um pedido que não foi atendido.

O `mtn` vem como dependência deste pacote, fixado por SHA. Não é preciso instalá-lo à parte nem apontar caminho para ele.

## Instalação

```bash
npm i -g github:MadameLabs/tasknotes-agent-adapter
tasknotes-agent diagnose --config /caminho/do/config.agent.local.json
```

## Configuração

Um arquivo por vault, local e fora do controle de versão, a partir de `config.agent.example.json`. O que muda entre vaults é o caminho, a porta e o token — nunca o código.

## Comandos

```
open                     lista tarefas abertas
create "TÍTULO"          cria tarefa (só no backend desktop)
promote "CAMINHO.md"     transforma nota existente em tarefa
link-project "CAMINHO.md" vincula tarefa a projeto
set-status "CAMINHO.md"  corrige status sem tocar no cronômetro
start "CAMINHO.md"       vincula a sessão e inicia o cronômetro
stop                     encerra; --status é obrigatório
diagnose                 mostra vínculos, leases e divergências
recover "CAMINHO.md"     libera vínculo de sessão morta
hook-start / hook-end    entrypoints dos hooks de sessão
```

`stop` exige `--status` de propósito: um desfecho padrão mentiria sobre o que aconteceu com a tarefa.

## Testes

```bash
npm test
```

A suíte sobe um servidor HTTP falso para o backend desktop e usa o `mtn` de verdade para o headless.
