# tasknotes-agent-adapter

Adaptador que dá a agentes de linha de comando — Claude Code, Codex, opencode, oh-my-pi (`omp`) — uma forma segura de abrir, cronometrar e encerrar tarefas do [TaskNotes](https://tasknotes.dev) num vault do Obsidian.

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

Um arquivo por vault, local e fora do controle de versão, a partir de `config.agent.example.json`. O que muda entre vaults é o caminho, a porta, o token e o vocabulário — nunca o código.

O bloco opcional `vocabulary` diz como cada papel se escreve no arquivo daquele vault. O agente sempre fala em papéis — `--status aprovacao`, `--responsavel` —, e o adaptador grava o valor do vault. Sem o bloco, vale o português (`aprovacao`, `Responsavel`, `Marca`, `Projeto`). Papel ausente no bloco herda o padrão; papel desconhecido ou dois papéis com o mesmo valor recusam o config com `invalid_vocabulary`.

```json
"vocabulary": {
  "statuses": { "to-do": "open", "em-andamento": "in-progress", "aprovacao": "review", "pausa": "paused", "concluido": "done", "cancelado": "cancelled" },
  "fields": { "responsavel": "assignees", "marca": "marca", "projeto": "projects" }
}
```

`--status` aceita o papel ou o valor do próprio vault.

## Comandos

```
open                     lista tarefas abertas
create "TÍTULO"          cria tarefa (só no backend desktop)
promote "CAMINHO.md"     transforma nota existente em tarefa
link-project "CAMINHO.md" vincula tarefa a projeto
set-status "CAMINHO.md"  corrige status sem tocar no cronômetro; --completed-date AAAA-MM-DD para fechar com data passada
start "CAMINHO.md"       vincula a sessão e inicia o cronômetro
stop                     encerra; --status é obrigatório
diagnose [--timers]      mostra vínculos, leases e divergências; --timers lista os cronômetros abertos e há quantas horas
recover "CAMINHO.md"     libera vínculo de sessão morta
suggest-end              última atividade real no transcript de uma sessão (só lê)
fix-time "CAMINHO.md"    corrige início ou fim de uma entrada de tempo já fechada
block "CAMINHO.md" --by "OUTRA.md"    marca que a tarefa depende de outra; repetir --by para mais de uma
unblock "CAMINHO.md" --by "OUTRA.md"  tira a dependência
hook-start / hook-end    entrypoints dos hooks de sessão
```

`stop` exige `--status` de propósito: um desfecho padrão mentiria sobre o que aconteceu com a tarefa.

### Cronômetro que ficou aberto

Quando uma sessão morre sem encerrar, o cronômetro continua correndo até alguém pará-lo, e a entrada de tempo ganha horas que ninguém trabalhou. O conserto tem três passos:

```bash
tasknotes-agent stop --agent claude --session <sessão dona> --status pausa --config …   # fecha pela sessão dona
tasknotes-agent suggest-end --agent claude --session <sessão dona> [--after <início da entrada>] --config …
tasknotes-agent fix-time "06-tarefas/Tarefa.md" --entry <startTime da entrada> --end <ISO> --reason "…" --config …
```

O `suggest-end` só lê: devolve o transcript e o horário da última mensagem ou chamada de ferramenta da sessão (Claude em `~/.claude/projects`, Codex em `~/.codex/sessions`). Resumo de ausência, troca de configuração e custo não contam como atividade. Se a sessão continuou em outra tarefa depois, a última atividade não é o fim desta tarefa: confira antes de usar.

O `fix-time` endereça a entrada pelo `startTime` gravado, nunca pela posição. Ele usa sempre o headless, porque a API do plugin não edita entrada de tempo, e recusa entrada ainda aberta (`time_entry_still_open`), entrada ainda presa a uma sessão viva (`time_entry_bound_to_session`), fim antes do início, horário no futuro e sobreposição com outra entrada da tarefa. `--reason` é obrigatório. A resposta traz a entrada anterior e a nova, para ficar registrada no corpo da tarefa.

### Dependências

`block` e `unblock` gravam a lista de dependências do TaskNotes (`blockedBy`, com o nome do campo vindo do mapeamento do vault) no formato do plugin: `uid` como wikilink pelo nome da nota e `reltype: FINISHTOSTART`. Usam sempre o headless. `block` recusa tarefa que bloqueia a si mesma (`task_cannot_block_itself`) e bloqueador que não existe (`blocker_not_found`); repetir um bloqueio não duplica. Dependências gravadas pelo plugin, com outro `reltype` ou `gap`, ficam como estão.

O mapeamento do mdbase (`_types/task.md`, em `implements[].fields`) precisa dar ao `blockedBy` o mesmo nome que o plugin usa no `data.json`. Se divergirem, o bloqueio é gravado num campo que o Obsidian não lê.

## Testes

```bash
npm test
```

A suíte sobe um servidor HTTP falso para o backend desktop e usa o `mtn` de verdade para o headless.
