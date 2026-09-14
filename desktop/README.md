# Synapse — app desktop

Um workspace por projeto para reuniões. Você grava ou solta um vídeo na janela;
o app extrai o áudio, transcreve, extrai as tarefas combinadas e liga tudo ao
projeto. Nada sai da máquina: transcrição e extração rodam localmente.

O nome antigo era *Meeting Processor*; o pipeline Python continua o mesmo.

## O modelo mental

O centro é o **projeto**, não a transcrição:

```
                    PROJETO
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
     REUNIÃO         TAREFA        DOCUMENTO
        │              │
        └──── grafo ───┘
```

Cada projeto tem visão geral, kanban, reuniões, grafo e chat. Um projeto
carrega também um texto de contexto, usado para orientar o registro dos
documentos gerados.

## Como funciona

```
janela (Electron)  →  motor de transcrição  →  arquivos na pasta de saída
       ↑                      │                        │
       └──── eventos JSONL ───┘                  extração (claude -p)
                                                        │
                                                  cards no kanban
```

O app não fala Python: faz spawn do motor, que emite um evento JSON por linha
no stdout (`stage`, `done`, `error`). Terminada a transcrição, o app roda a
extração estruturada e só então anuncia a reunião como pronta.

## Os dois motores

Alterne em **Configurações → Motor ativo**.

| Motor | Onde roda | Velocidade |
|-------|-----------|------------|
| **GPU** (padrão) | Python do host + whisper.cpp com Vulkan | ~11x tempo real numa Radeon RX 9060 XT |
| **Docker** | container CPU-only | ~2x tempo real com 16 threads |

Medido no mesmo áudio de 5 min com `large-v3-turbo`: **27 s na GPU** contra
**153 s na CPU**. No Windows o Docker Desktop **não** expõe GPU AMD, então
container e GPU são exclusivos.

## Pré-requisitos

- **Node.js 20+** para abrir o app.
- Motor **GPU**: Python com as dependências do projeto, ffmpeg no PATH,
  `whisper-cli.exe` em `.whisper-cpp/` e ao menos um modelo `.bin` em
  `.models/`.
- Motor **Docker**: só o Docker Desktop.
- Extração de tarefas e PDFs: **Claude Code** instalado e autenticado. O app
  procura o binário em `~/.local/bin` e no PATH; `CLAUDE_BIN` força um caminho.

## Rodar

```bash
cd desktop && npm install && npm start
```

Ou clique em `Meeting Processor (sem console).vbs` na raiz do projeto. Para
abrir junto com o Windows e para variáveis só do app (`.synapse-env`), veja o
README da raiz, em "Abra".

## Testes

```bash
npm test              # unidades: módulos puros, sem Electron (node:test)
npm run test:e2e      # ponta a ponta: o Electron de verdade, guiado pelo Playwright
npm run test:e2e -- --headed -g chat   # vendo a janela, só um cenário
```

A suíte de ponta a ponta (`tests-e2e/`) abre o app num workspace temporário
(`SYNAPSE_USER_DATA` aponta o userData; o `settings.json` semeado aponta a
pasta de saída), então ela nunca toca nas configurações nem no `synapse.db` de
quem roda. O chat conversa com um `claude` de mentira (`tests-e2e/fake-claude`,
compilado pelo `csc` do .NET Framework no início da suíte e apontado por
`CLAUDE_BIN`): responde o protocolo `stream-json` sem rede, sem login e sem
custo. Cada teste recolhe toda exceção do renderer e todo `console.error` — um
erro que antes aparecia "do nada" ao abrir vira um teste vermelho com a
mensagem. Os cenários:

| Arquivo | O que garante |
|---------|---------------|
| `01-boot` | a janela abre, a tela inicial desenha, zero erros; todo id usado pelo `app.js` existe no HTML e nenhum se repete; a trava de instância única está tomada |
| `02-navigation` | as quatro telas abrem pela barra lateral; estados vazios; Configurações com os motores de transcrição e de voz |
| `03-projects` | criar (e recusar sem nome), abrir cada aba, editar, excluir com confirmação |
| `04-prompts` | abrir, salvar sem recarregar a página, personalizar, restaurar, recusar sem placeholders |
| `05-chat` | pergunta e resposta, ferramenta em uso, falha do processo vira mensagem, histórico entre abas, Nova conversa, modo autônomo com confirmação |
| `06-kanban` | colunas vazias, criar na coluna certa, recusar sem título, editar/mover/excluir |

Falhou? `test-results/` guarda screenshot e trace (`npx playwright show-trace
<arquivo>`); `playwright-report/` tem o relatório em HTML.

## Os fluxos

### Gravar

Dentro de um projeto, **Iniciar reunião** grava microfone **e** áudio do
sistema (loopback) — numa chamada online o microfone traz apenas o seu lado.
As duas fontes não são mixadas: o microfone vai para o **canal esquerdo** e o
som do sistema para o **direito**. É dessa separação que sai o "quem falou" na
transcrição (`--diarize` do whisper.cpp); somadas num canal só, as vozes ficam
indistinguíveis para sempre. Sem permissão de loopback, o app segue só com o
microfone, diz isso na tela e a transcrição sai sem marcação de falante — em
vez de uma marcação errada. Ao finalizar, o áudio entra no mesmo pipeline da
importação e o arquivo temporário é apagado no fim.

**Pelo OBS Studio.** Com o OBS aberto e o servidor WebSocket ligado
(Configurações → Gravar pelo OBS Studio), é ele que grava. Vantagens: o
microfone e o som da máquina ficam em **faixas separadas** do arquivo, sem
vazamento de um lado no outro, e a gravação não depende da janela do app.
A conversa com o OBS passa por um servidor MCP próprio — veja
[`mcp-obs/README.md`](../mcp-obs/README.md), inclusive como configurar as
faixas separadas. O chat do projeto pode usar as mesmas ferramentas.

### Importar

Solte um vídeo em qualquer lugar da janela, ou use **Importar vídeo**. Você
confirma o nome e o projeto antes de começar.

**Importar transcrição** aceita texto já pronto (`.txt`, `.md`) e legendas
(`.srt`, `.vtt`) — útil para reuniões que já foram transcritas pelo Teams ou
pelo Zoom. A legenda vira fala com horário, e a reunião entra na biblioteca
como qualquer outra: com projeto escolhido, ainda passa pela extração de
tarefas.

### Depois da transcrição

O Claude lê a transcrição **uma vez** (`prompts/analise.md`) e devolve a
análise da reunião em JSON: título, visão geral, pontos discutidos, decisões,
riscos, tarefas e pendências. O app normaliza esse JSON (`analysis.js`) e o
guarda em `analise.json`, na pasta da reunião.

Dessa análise saem as duas coisas, por construção iguais:

- **Tarefas no Kanban** — cada tarefa vira um card no backlog do projeto,
  ligado à reunião. O painel da reunião lista essas tarefas e abre o card. Sem
  projeto, a etapa é pulada: tarefa sem projeto não teria onde viver.
- **Documento em PDF** — o app monta o HTML a partir da análise
  (`document-html.js`) e o imprime pelo Edge ou Chrome. A tabela de tarefas do
  PDF é a mesma lista dos cards.

Cada uma liga e desliga em **Configurações → Depois da transcrição**
(`pipeline-steps.js` decide o que roda; com as duas desligadas e sem nome
automático, o Claude nem é chamado). O botão **Gerar documentos**, no painel da
reunião, monta o PDF a partir da análise guardada — e, numa reunião de antes da
análise existir, pede a análise primeiro.

No mesmo cartão, **Prompts** lista as etapas num seletor (a lista vem de
`prompts-store.js`: um prompt novo registrado ali aparece sozinho) e abre as
instruções escolhidas num modal para ler e editar. O padrão fica em `prompts/*.md`; a edição vai para a pasta de
dados do usuário e vale por cima (`prompts-store.js`) — restaurar o padrão é
apagar essa cópia, e atualizar o app nunca sobrescreve o que a pessoa escreveu.
O editor recusa texto sem os placeholders obrigatórios (`{{TRANSCRICAO}}`,
`{{PDF}}`…), porque é por eles que o app passa os caminhos.

### Seu fluxo

Em **Configurações → Seu fluxo**, a análise deixa de ser a única coisa que
acontece depois da transcrição. Cada etapa tem nome, prompt, o que lê
(transcrição, análise ou a saída da etapa anterior) e onde grava — um arquivo
na pasta da reunião. Elas rodam na ordem da lista, e o encadeamento é o que dá
poder ao conjunto: a etapa 2 lê o que a 1 escreveu, e um resumo pode virar um
e-mail, uma tradução ou uma entrada de wiki sem nova leitura da transcrição.

Uma etapa pode nomear uma **skill** do Claude Code. O nome entra como instrução
no começo do prompt e a ferramenta `Skill` é liberada só nesse caso.

O modelo (`flows.js`) e a execução (`flow-runner.js`) são módulos separados: o
encadeamento — a parte difícil — é função pura e tem teste. As etapas ficam em
`flows.json`, na pasta de dados do usuário, para uma atualização do app nunca
apagar o que alguém escreveu.

A análise é uma etapa como as outras, com duas diferenças: não pode ser apagada
nem renomeada (o Kanban e o PDF nascem do formato dela) e o prompt dela mora em
`prompts/analise.md`, editado pelo editor de prompts. Desligá-la, isso sim —
e aí não saem cards nem documento.

Toda etapa roda com **apenas `Read` e `Write`**. A transcrição é fala de
terceiros, e fala de terceiros é dado, nunca instrução: com `Bash` liberado,
uma frase plantada numa reunião viraria comando na máquina de quem só queria o
resumo.

Enquanto tudo isso roda, a tela de processamento pode ser **minimizada** (botão
ou `Esc`): o progresso segue num chip no pé da barra lateral, o app fica livre
e um clique no chip traz a tela de volta. Ao terminar, o aviso único aparece
do mesmo jeito — só não puxa a pessoa para o projeto se ela estava em outra
coisa.

### O chat do projeto

O chat é o Claude Code (`claude -p`) rodando na **pasta de trabalho** do
projeto — um campo do projeto; vazio, usa a pasta das reuniões. Cada mensagem
vai com um system prompt montado na hora (`project-chat.js`): nome e contexto
do projeto, os caminhos de transcrição, `analise.json` e PDF de cada reunião,
as tarefas abertas do Kanban e o modo em vigor. A conversa continua entre
mensagens e entre aberturas do app pela sessão do próprio Claude Code
(`--session-id` na primeira, `--resume` depois); se a sessão sumiu, o app abre
outra e segue. O que a tela mostra fica em `chat_messages`, no `synapse.db`.

**Voz.** O microfone na barra do chat grava um recado, o mesmo whisper.cpp das
reuniões o transcreve na GPU (`voice.js`, com VAD e sem tokens não-fala) e o
texto entra na caixa. Com o interruptor **Voz** ligado, o recado vai direto
como mensagem e a resposta é lida em voz alta; 🔇 interrompe a leitura.

A leitura usa, por padrão, as **vozes neurais do Edge** (`tts.js` chama o
`edge-tts` no Python do app: pt-BR Francisca, Antônio ou Thalita, com
entonação de fala de verdade — gratuito, sem chave, precisa de internet na
hora). Sem internet ou sem o pacote, o renderer cai para a voz do sistema
(`speechSynthesis`, offline) e avisa uma vez. Motor, voz e velocidade ficam em
**Configurações → Voz do assistente**, com botão de amostra — no motor do
sistema, a lista é a das vozes instaladas no Windows. Cada resposta do
assistente tem um 🔊 para ser lida sozinha, com ou sem o modo Voz.

A Anthropic não expõe a voz do Claude como API e o modo de voz do Claude
Code é só entrada, na interface interativa — por isso a saída de voz é esta.

Dois modos, por projeto, no alto do chat:

- **Leitura** (padrão): `--permission-mode dontAsk` com `Read, Glob, Grep,
  WebSearch, WebFetch`. O Claude consulta e responde; não escreve nem executa.
- **Autônomo**: `--dangerously-skip-permissions`. O Claude age na máquina sem
  pedir a cada passo. Liga com confirmação, fica vermelho enquanto ativo, e o
  system prompt pede aviso antes de algo destrutivo. **Parar** derruba a rodada.

## Onde ficam os dados

Um projeto com **pasta de trabalho** é a casa das suas reuniões: o app cria
`synapse/` dentro dela e cada reunião do projeto é uma subpasta ali —
transcrição, `analise.json` e PDF. Definir, trocar ou limpar a pasta move as
reuniões do projeto para a raiz certa (entre discos, copia e apaga). Excluir o
projeto exclui tudo dele: cada reunião vai para a Lixeira, a `synapse/` vazia
sai, e tarefas, vínculos e histórico do chat caem do banco. Excluir uma
reunião leva a pasta dela e as tarefas que nasceram dela. A biblioteca lê
todas as raízes; o id da reunião leva o projeto na
frente (`alpha::Kickoff`) porque dois projetos podem ter reuniões de mesmo nome.

A **pasta de saída** (Configurações) fica com as reuniões sem projeto e com o
`synapse.db` — projetos, tarefas, vínculos, histórico do chat.

As transcrições e os documentos são arquivos na pasta de saída, legíveis sem
o app. O que não cabe num nome de pasta — projetos, tarefas e o vínculo de
cada reunião — fica num SQLite na mesma pasta:

```
<pasta de saída>/
├── synapse.db                     # projetos, tarefas e vínculos (SQLite)
└── <nome da reunião>/
    ├── <nome>.md                  # transcrição com timestamps
    ├── <nome>.txt
    ├── meeting.json               # data, duração, modelo, idioma, nº de falas
    └── <nome> - Tarefas.pdf       # quando gerado
```

## Estrutura

```
desktop/
├── assets/              # marca do app
│   ├── icon.svg         # fonte do ícone (neurônio disparando)
│   ├── icon.ico         # janela e barra de tarefas no Windows
│   └── icon.png         # 512px, para empacotamento e outras plataformas
├── main.js              # janela, IPC, pipeline, gravação e extração
├── engines.js           # os dois motores: nativo (GPU) e container (CPU)
├── docker-args.js       # montagem do comando do container
├── claude-jobs.js       # a chamada ao `claude -p` (análise da reunião)
├── analysis.js          # normaliza e guarda a análise (analise.json)
├── document-html.js     # o PDF da reunião, montado a partir da análise
├── pipeline-steps.js    # quais etapas rodam depois da transcrição (Configurações)
├── prompts-store.js     # prompts editados por cima do padrão (Configurações → Prompts)
├── updater.js           # Configurações → Sobre: git pull --ff-only, npm/pip se mudaram, relaunch
├── project-chat.js      # chat do projeto: system prompt, args do claude -p, tradução do stream
├── chat-messages.js     # histórico do chat (tabela chat_messages)
├── voice.js             # recado de voz → texto, com o whisper.cpp das reuniões
├── tts.js               # resposta → áudio: Edge neural ou voz do sistema
├── transcript-import.js # texto e legenda viram reunião (.txt .md .srt .vtt)
├── library.js           # a pasta de saída lida como biblioteca (CRUD)
├── db.js                # banco do workspace (SQLite) e migração dos JSONs
├── projects.js          # projetos, contextos e vínculo com as reuniões
├── tasks.js             # tarefas do kanban
├── workspace.js         # traduz disco → projeto/reunião/tarefa
├── preload.js           # ponte segura entre janela e sistema
├── prompts/             # instruções padrão, editáveis também pelo app
│   └── analise.md       # a leitura única: análise da reunião em JSON
└── renderer/
    ├── index.html       # shell: sidebar, vistas, drawer, overlays
    ├── styles.css       # tema neural (azul-tinta, ciano, violeta)
    ├── app.js           # navegação, kanban, gravação, chat, pipeline
    ├── neural.js        # rede do hero, no Início
    ├── network.js       # rede viva das telas de trabalho (interativa)
    ├── graph.js         # grafo força-dirigida (hero e projeto)
    └── mock-api.js      # backend simulado fora do Electron (inerte no app)
```

## Solução de problemas

> Excluir uma reunião manda a pasta para a **Lixeira** do sistema, não apaga
> do disco: transcrição não se refaz sem o vídeo original.
>
> Vindo de uma versão anterior, o `groups.json` e o `tasks.json` são
> importados para o banco na primeira abertura e guardados como `.migrado`.

| Sintoma | O que fazer |
|---------|-------------|
| "motor indisponível" | No modo GPU, confira `.whisper-cpp/whisper-cli.exe` e `.models/*.bin`. No Docker, abra o Docker Desktop e clique em **Verificar de novo**. |
| Transcrição muito lenta | Confira o motor em Configurações: se está em **Docker**, é CPU. O detalhe da tela mostra `GPU: <placa>` quando a GPU entra em ação. |
| Nenhuma tarefa foi criada | A reunião precisa estar num projeto e o `claude` precisa estar autenticado — rode `claude` uma vez no terminal. O log da janela traz o motivo. |
| "O PDF não foi gerado" | Além do `claude`, é preciso ter Edge ou Chrome instalado. |
| Gravação sem o áudio da outra pessoa | A tela de gravação diz a fonte em uso. Só microfone significa que o loopback do sistema foi negado. |
| Arquivo não aceito | Só vídeo e áudio: mkv, mp4, mov, webm, avi, mp3, wav, m4a e afins. |
