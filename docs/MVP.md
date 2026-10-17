# Team Chat para Claude Code — MVP

Documento de partida do projeto. Reúne o que foi decidido em 2026-10-17.

## 1. Objetivo

Permitir uma **sessão conjunta** entre pessoas que estão usando o Claude ao mesmo tempo, para acelerar o trabalho. O chat é o canal entre os Claudes de cada pessoa: passar contexto de uma sessão para outra sem copiar e colar, deixar o Claude conversar com o time e passar tarefas com contexto.

## 2. Princípios

1. **Nada da sessão sai sem prévia.** Todo contexto compartilhado e toda postagem do Claude passam pela confirmação da pessoa.
2. **Sem servidor próprio no MVP.** O backend é o GitHub, usado pelo `gh` da própria pessoa.
3. **Requisito de uso:** ter o `gh` instalado e autenticado (`gh auth status` ok, escopo `repo`).
4. **Identidade = perfil do GitHub** (login, nome, foto). Não há cadastro nem perfil guardado por nós.

## 3. O que é

Um **mod do Claude Code** (plugin de hooks) que abre um painel "Chat" com o comando `/chat`. Ele é escrito em TypeScript/TSX contra a API `claude-code`, desenha a interface com `$.ui.resolve(e)` (Box, Text, Button, Input) e guarda estado em `$.state` (sessão) e `$.store` (entre sessões).

Funciona onde o Claude Code roda comandos locais (terminal e app desktop). **Não funciona no app do celular**, onde não há `$.process` nem campo de texto.

## 4. Arquitetura: GitHub como backend

Todo acesso ao GitHub é feito via `$.process.run([gh, "api", ...])`. O mod nunca lê o token. O `gh` pode não estar no PATH da sessão: procurar em `gh`, `~/.local/bin/gh`, `/opt/homebrew/bin/gh` e `/usr/local/bin/gh`.

### 4.1 Mapeamento

| Conceito | No GitHub |
| --- | --- |
| Pessoa / perfil | Usuário do GitHub (`gh api user`) |
| Contato | Login do GitHub adicionado pela pessoa (lista local em `$.store`) |
| Grupo | Repositório privado `tc-<slug>`, com o tópico `claude-team-chat` |
| Conversa direta | Repositório privado `tc-dm-<loginA>-<loginB>` (logins em ordem alfabética), mesmo tópico |
| Membros | Colaboradores do repositório (em conta pessoal todos têm escrita) |
| Mensagens | Comentários da issue nº 1 (título `chat`, label `team-chat`) |
| Arquivos | Commits em `files/AAAA/MM/<id>-<nome>` no próprio repositório |
| Metadados do chat | `.team-chat/meta.json` → `{ "v": 1, "kind": "group" \| "dm", "name": "...", "createdBy": "<login>" }` |

### 4.2 Formato da mensagem

Cada comentário tem um texto legível no site do GitHub e, no fim, um marcador com os dados estruturados:

```
Texto legível da mensagem.

<!-- team-chat:v1 {"kind":"text"} -->
```

Os tipos de `kind`:

- `text`: mensagem comum. Links detectados no texto viram clicáveis.
- `file`: `{ "path": "files/...", "name", "size", "mime" }`.
- `context`: `{ "title", "summary", "source": "summary" | "last-answer" | "changes", "files": [{ "path", "added", "removed" }] }`.
- `task`: `{ "to": "<login>", "title", "details", "context": { ... } }`.
- `viaClaude: true`: em qualquer tipo, marca que a postagem foi feita pelo Claude da pessoa, com a aprovação dela.

Um comentário sem marcador é tratado como `text`, o que inclui comentários escritos direto no site do GitHub.

### 4.3 Busca de mensagens novas (polling)

- **Chat aberto:** a cada **20 s**.
- **Demais chats:** a cada **5 min**.
- Usar `GET /repos/{o}/{r}/issues/1/comments?since=<ISO>` com `If-None-Match` (ETag). Respostas 304 não contam no limite de pedidos.
- Agendar com `$.clock`. Não usar WebSocket: o mod não tem.
- Descobrir os chats com `GET /user/repos?affiliation=owner,collaborator` filtrado pelo tópico `claude-team-chat`, a cada 5 min.

### 4.4 Rotinas automáticas

- **Convites:** aceitar sozinho os convites (`/user/repository_invitations`) de repositórios com prefixo `tc-` e tópico `claude-team-chat`.
- **Notificações do GitHub:** ao entrar ou criar um chat, `PUT /repos/{o}/{r}/subscription { "ignored": true }`, para o GitHub não mandar e-mail a cada mensagem.
- **Não lidas:** guardar o último id de comentário lido por chat em `$.store`.

## 5. Escopo do MVP

### 5.1 Base

| Tela (no canvas) | Inclui | Aceite |
| --- | --- | --- |
| 1 · Cadastro → **Entrar com GitHub** | Checa `gh auth status`, mostra foto, nome e @ do GitHub, botão "Começar". Sem `gh` instalado ou sem login, mostra como resolver. | Abrir `/chat` pela primeira vez leva a essa tela. Depois de confirmar, não aparece mais. |
| 2 · Chat do grupo | Cabeçalho do app (você, Grupos, Contatos com não lidas), cabeçalho do chat (nome, nº de membros, Arquivos, Membros), mensagens agrupadas por autor e as suas à direita, lista colada no campo, campo fixo embaixo com Anexar, Compartilhar contexto e Passar tarefa. | Mensagem enviada aparece na hora e chega para os outros em até cerca de 20 s. |
| 3 · Arquivos e links | Abas Arquivos, Links e Contextos, montadas a partir das mensagens do chat. | Cada arquivo abre o download no navegador. Cada contexto pode ser trazido de novo para o Claude. |
| 4 · Membros | Lista de colaboradores com foto e @, botão Adicionar, "Sair do grupo". | Sair remove você como colaborador. Se for o dono, avisa e não deixa (MVP). |
| 5 · Adicionar ao grupo | Painel com busca nos contatos, seleção múltipla e quem já está no grupo desativado. | Adiciona como colaborador. O convite é aceito sozinho pelo mod da outra pessoa. |
| 6 · Grupos | Lista com última mensagem, horário, não lidas e membros. Campo "Novo grupo". | Criar gera o repo privado, o tópico, o `meta.json` e a issue `chat`, e abre o chat. |
| 7 · Contatos | Lista de contatos e "Adicionar" por @ do GitHub, conferido com `gh api users/<login>`. "Conversar" abre ou cria a conversa direta. | @ inexistente mostra erro. Conversa direta não é duplicada. |
| 8 · Conversa direta | Igual ao chat, com uma pessoa só e sem nomes nos balões. | Recebe cartões de tarefa. |
| 9 · Perfil | Só leitura: foto, nome, @ e link para o perfil no GitHub. | — |

**Anexos e links:**

- O MVP aceita **arquivos até 4 MB**, que é o limite de `$.fs.read`.
- Não existe seletor de arquivo: a pessoa digita ou cola o caminho no "Anexar".
- O download abre o arquivo no GitHub pelo navegador, porque `$.fs.write` só grava texto.

### 5.2 Sessão conjunta

| Tela | Inclui | Aceite |
| --- | --- | --- |
| A · Compartilhar contexto | Escolher entre resumo da sessão (via `$.model.complete` sobre `$.session.messages`), última resposta do Claude ou alterações (arquivos com +/−). A prévia é editável e dá para marcar quais arquivos vão. "Só vai o que está na prévia". | Quem recebe vê o cartão no chat. **Trazer pro meu Claude** coloca o contexto no prompt da pessoa (`$.prompt.fill`), sem enviar sozinho. |
| B · Claude no chat | Ferramentas para o modelo, registradas com `$.tool.register`: `team_chat_read` (últimas N mensagens de um chat) e `team_chat_post` (cria um rascunho). O rascunho aparece no painel com Postar, Editar e Descartar. Cada grupo tem um interruptor "Claude pode ler este grupo". A linha "Seu Claude leu…" aparece no chat. | Nada é postado sem clicar em Postar. Com o interruptor desligado, a leitura é negada. |
| C · Passar tarefa | Para quem, título, detalhes e o contexto que vai junto (resumo, alterações, branch). Vai pela conversa direta. | Quem recebe vê o cartão com **Começar no meu Claude** (`$.prompt.fill` com a tarefa e o contexto) e **Agora não**. |

## 6. Fora do MVP

- "Digitando", "visto" e status online, ausente ou offline (no lugar entra "ativo há X min", pela última mensagem).
- Convite com aceite manual, papel de admin, menu "⋯" dos membros, remover membros.
- Editar perfil e foto (vêm do GitHub).
- Editar ou apagar mensagens, reações, busca nas mensagens.
- Status ao vivo de "quem está fazendo o quê" e aviso de conflito de arquivo (é a primeira candidata para depois do MVP).
- App do celular.
- Servidor próprio. Pode ser reavaliado se o GitHub limitar: latência, muitos repositórios ou limite de pedidos.

## 7. Ajustes pendentes no design

Canvas: https://claude.ai/artifact/EJobVufCKs7JAvR63J6GmL

O canvas tem 12 telas e foi feito antes de decidirmos usar o GitHub. Ajustar:

1. Cadastro → "Entrar com GitHub", sem os campos nome e @.
2. Avatares → fotos do GitHub.
3. Bolinhas de status online e offline → "ativo há X min".
4. Contatos → "Adicionar pelo @ do GitHub".
5. Perfil → só leitura, com link para o GitHub.
6. Estado de erro: "gh não encontrado" e "gh sem login".

## 8. Mapa da API do mod

| Necessidade | API |
| --- | --- |
| Painel e comando | `$.ui.open`, hook `ui.render` em `{ component: 'Pane' }`, `$.command.register` + `command.run` |
| GitHub | `$.process.run` com `gh api ...` |
| Polling | `$.clock` |
| Estado da tela | `atom` / `read` / `update` sobre `$.state`, com tipos em `types/index.d.ts` (usar `Shaped` + `shape` quando o formato mudar) |
| Dados entre sessões | `$.store` (contatos, último lido, preferências) |
| Ler arquivo para anexar | `$.fs.read(path, { as: 'bytes' })` (até 4 MB) |
| Resumo da sessão | `$.session.messages` + `$.model.complete` |
| Trazer pro meu Claude | `$.prompt.fill` |
| Ferramentas do Claude | `$.tool.register` + hook `tool.call` em `mcp__team-chat__<nome>` |
| Avisos | `$.ui.toast`, `$.ui.status` |

## 9. Fases

1. **Base de projeto:** copiar o mod atual para o repositório novo, configurar `tsconfig`, testes e validação.
2. **GitHub e identidade:** localizar o `gh`, tela "Entrar com GitHub", camada `github.ts` com as chamadas e testes com respostas simuladas.
3. **Grupos e mensagens:** criar e descobrir chats, enviar e receber texto e links, polling com ETag, não lidas, aceitar convites e silenciar notificações.
4. **Membros e contatos:** adicionar contato, adicionar ao grupo, conversa direta, sair do grupo.
5. **Arquivos:** anexar por caminho, commit em `files/`, cartão de arquivo e tela Arquivos e links.
6. **Sessão conjunta:** compartilhar contexto, depois o Claude no chat, depois passar tarefa.
7. **Acabamento:** estados vazios e de erro, limites, teste real com duas contas do GitHub.

Cada fase termina com `claude plugin validate`, `claude plugin test` e o tipo checado com `tsc` passando.

## 10. Ponto de partida no código

O mod atual (só interface, com dados de exemplo) está em `mod/`:

```
mod/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/register.tsx      # estado, ações, /chat
├── hooks/views.tsx         # todas as telas
├── hooks/mock.ts           # dados de exemplo (trocar pela camada GitHub)
├── hooks/register.test.tsx # teste de interface (terminal e desktop)
├── types/index.d.ts        # contrato do $.state
└── tsconfig.json           # estende .claude-plugin/types, gerado quando o engine carrega o mod
```

Como validar, testar e carregar o mod: skill `team-chat-dev`.

## 11. Riscos e decisões em aberto

- **Dono do repositório:** quem cria o chat é o dono. Se apagar o repo ou sair do GitHub, o chat some para todos.
- **Muitos repositórios:** cada conversa direta cria um repo. Aceitável no MVP. Se incomodar, avaliar uma organização do GitHub dedicada.
- **Latência de cerca de 20 s:** suficiente para coordenar o trabalho. Se não bastar, reavaliar um servidor com conexão contínua.
- **Conteúdo sensível:** contextos podem conter código e trechos da sessão. Ficam em repo privado, mas visíveis a todos os colaboradores. A prévia obrigatória é a proteção.
