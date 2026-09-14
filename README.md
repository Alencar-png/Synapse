# Synapse

> Grave a reunião — ou solte o vídeo na janela — e receba **transcrição**,
> **tarefas no Kanban** e **documentos**, organizados por projeto.
> Roda **na sua máquina**: nada de áudio sai dela.

[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/)
[![Node 20+](https://img.shields.io/badge/node-20%2B-green.svg)](https://nodejs.org/)
[![License MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## O que ele faz

1. Você grava pela janela do app — ou pelo **OBS Studio**, se ele estiver
   aberto — ou solta um vídeo/áudio na janela.
2. O **ffmpeg** extrai o áudio e o **Whisper Large V3** transcreve — local, na
   GPU — marcando **quem falou** em cada trecho.
3. O Claude lê a transcrição **uma vez** e devolve a análise da reunião:
   visão geral, decisões, riscos e as **ações combinadas**.
4. Dessa análise saem, juntos, os cards no Kanban do projeto e um **documento
   em PDF** na pasta da reunião — a tabela de tarefas do PDF é a mesma lista
   dos cards.

**Quem falou** sai da separação do áudio: o microfone fica num canal e o som da
chamada no outro, e o whisper.cpp diz de qual lado veio cada fala. A
transcrição sai com *Você* e *Participantes* na frente das linhas. Ligado por
padrão em **Configurações → Marcar quem fala**; gravação mono simplesmente não
recebe marcação, em vez de receber uma errada.

Cards e documento são opcionais: em **Configurações → Depois da transcrição**
cada um liga e desliga sozinho, e o prompt da análise pode ser visto e editado
ali mesmo. Em **Seu fluxo** dá para ir além e criar **etapas próprias** — cada
uma com o seu prompt, gravando um arquivo na pasta da reunião, e a seguinte
podendo ler o que a anterior escreveu. Uma etapa também pode chamar uma
**skill** do Claude Code pelo nome. Enquanto a reunião processa, a tela de
trabalho pode ser **minimizada** — o progresso segue num chip na barra lateral
e o app fica livre para uso.

Com o **OBS Studio** aberto e o servidor WebSocket ligado, é ele que grava: o
microfone e o som da máquina ficam em faixas separadas do arquivo, e a gravação
não depende da janela do app. O Synapse fala com o OBS por um **servidor MCP**
próprio (`mcp-obs/`), que o chat do projeto também pode usar — dá para pedir ao
assistente que comece ou pare a gravação. Sem OBS, o app grava sozinho, como
sempre.

O centro é o **projeto**: cada um tem seu Kanban, suas reuniões, seus
documentos, um texto de contexto que orienta o tom do que é gerado — e um
**chat**, que é o Claude Code rodando com tudo isso à mão. Dê ao projeto uma
**pasta de trabalho** (um repositório, uma pasta de documentos): o app cria
`synapse/` lá dentro e passa a guardar as reuniões do projeto nela, e o chat
passa a trabalhar nessa pasta. Ligue o **modo autônomo** e ele age na máquina
sem pedir a cada passo; desligado, só lê e pesquisa. Dá para **falar** com ele:
o microfone do chat transcreve na GPU e, com o modo Voz ligado, a resposta é
lida em voz alta com uma voz neural (ou a do sistema, offline).

---

## Abrir e rodar

### Passo 1 — Requisitos

| O quê | Para quê | Como instalar |
|-------|----------|---------------|
| **Node.js 20+** | abrir o app | `winget install OpenJS.NodeJS.LTS` |
| **Python 3.11+** | motor de transcrição | <https://www.python.org/downloads/> (marque *Add to PATH*) |
| **ffmpeg** | extrair o áudio | `winget install Gyan.FFmpeg` · `brew install ffmpeg` · `apt install ffmpeg` |
| **Claude Code** | tarefas e documentos | <https://claude.com/claude-code> |

### Passo 2 — Instale as dependências do Python

```bash
git clone https://github.com/Alencar-png/meeting-processor.git
cd meeting-processor
python -m venv .venv
```

```powershell
.venv\Scripts\Activate.ps1      # Windows
```
```bash
source .venv/bin/activate       # macOS / Linux
```

```bash
pip install -e .
```

Isso basta para o caminho rápido (whisper.cpp). Se preferir a transcrição em
Python puro, que baixa o modelo sozinho mas é bem mais lenta:
`pip install -e ".[transcription]"`.

### Passo 3 — Coloque o whisper.cpp e um modelo

O motor rápido precisa de dois arquivos, que não vão no repositório por serem
binários grandes:

- `whisper-cli` (ou `whisper-cli.exe`) em **`.whisper-cpp/`**
- um modelo GGML `.bin` em **`.models/`** —
  [`ggml-large-v3.bin`](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin)
  (3,1 GB) é o padrão do app: o mais fiel em português.
  `ggml-large-v3-turbo.bin` (1,6 GB) transcreve em cerca de metade do tempo e
  erra mais em nomes, números e no fim das frases — se os dois estiverem em
  `.models/`, o app usa o v3 e deixa o turbo no seletor
  ([outros modelos](https://huggingface.co/ggerganov/whisper.cpp))
- opcional, mas recomendado: o modelo de **detecção de voz**
  [`ggml-silero-v5.1.2.bin`](https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin)
  (0,9 MB), também em **`.models/`**. Com ele o Whisper só vê os trechos com
  fala e deixa de inventar "Tchau." em série nos silêncios. Sem ele, uma
  limpeza posterior remove repetições e frases-fantasma isoladas.

Como compilar o whisper.cpp com Vulkan está em
[`desktop/README.md`](desktop/README.md). Sem esses arquivos o app ainda roda
pelo motor Docker, que dispensa GPU.

### Passo 4 — Abra

Clique duas vezes em **`Meeting Processor (sem console).vbs`**. Na primeira vez
ele instala as dependências do app; depois abre direto. O
**`Meeting Processor.bat`** faz o mesmo mostrando as mensagens — use quando algo
der errado.

Pela linha de comando:

```bash
cd desktop && npm install && npm start
```

**Abrir junto com o Windows:** coloque um atalho do `.vbs` na pasta de
Inicialização (`Win+R` → `shell:startup`). Em PowerShell, na raiz do projeto:

```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Startup'))\Synapse.lnk")
$s.TargetPath = "wscript.exe"; $s.Arguments = '"' + (Resolve-Path '.\Meeting Processor (sem console).vbs') + '"'
$s.WorkingDirectory = (Get-Location).Path; $s.IconLocation = (Resolve-Path '.\desktop\assets\icon.ico'); $s.Save()
```

O app só abre uma instância: com ele já aberto, o atalho traz a janela para
a frente.

**Variáveis só para o app:** um arquivo `.synapse-env` na raiz (fora do git),
uma linha `CHAVE=VALOR` por variável, é lido pelos dois launchers. Serve, por
exemplo, para apontar o perfil do Claude Code que o chat e a análise usam:

```
CLAUDE_CONFIG_DIR=C:\Users\voce\.claude-work
```

Para atualizar depois, não precisa voltar ao terminal: **Configurações →
Sobre → Verificar atualização** mostra o que mudou e o botão **Atualizar agora**
faz o `git pull`, reinstala dependências se elas mudaram e reabre o app.

---

## Os dois motores

Alterne em **Configurações → Motor ativo**.

| Motor | Onde roda | Velocidade |
|-------|-----------|------------|
| **GPU** (padrão) | Python do host + whisper.cpp com Vulkan | ~11x tempo real |
| **Docker** | container CPU-only | ~2x tempo real |

Medido no mesmo áudio de 5 min com `large-v3-turbo` numa Radeon RX 9060 XT:
**27 s na GPU** contra **153 s na CPU** com 16 threads. No Windows o Docker
Desktop **não** expõe GPU AMD, então container e GPU são exclusivos.

Para o motor Docker, construa a imagem uma vez:

```bash
docker build -t meeting-processor:latest .
```

---

## Transcrever pelo terminal

O app chama exatamente este comando. Ele também serve avulso:

```bash
# Cria ./saida/<nome>/ com a transcrição (.md e .txt) e o meeting.json
python -m meeting_processor transcribe reuniao.mkv --output-dir ./saida
python -m meeting_processor transcribe reuniao.mkv --output-dir ./saida --name "Call com o cliente"
```

Padrões em [`config.yaml`](config.yaml); qualquer um deles aceita override por
variável de ambiente (veja [`.env.example`](.env.example)).

---

## Solução de problemas

| Sintoma | O que fazer |
|---------|-------------|
| `ffmpeg não encontrado no PATH` | Instale o ffmpeg e reabra o terminal |
| `Motor nativo indisponível` | Falta o `whisper-cli` em `.whisper-cpp/` ou o `.bin` em `.models/` |
| Transcrição lenta | Confira se a linha "GPU: ..." aparece no progresso; sem ela está na CPU |
| "Tchau." (ou outra frase) repetida em série na transcrição | Alucinação do Whisper no silêncio. Coloque o `ggml-silero-v5.1.2.bin` em `.models/` (VAD); a limpeza já colapsa a repetição, mas o VAD evita que ela nasça |
| Kanban vazio depois da reunião | O aviso na tela diz o motivo; o log completo está em `meeting_processor.log` |
| `não foi possível executar o Claude Code` | Instale o Claude Code, ou aponte `CLAUDE_BIN` para o binário |

---

## Para desenvolvedores

```bash
python -m pytest -q                    # motor de transcrição
cd desktop && npm test                 # app: unidades (node:test)
cd desktop && npm run test:e2e         # app: ponta a ponta (Playwright abre o Electron)
```

```
meeting_processor/         # motor de transcrição (Python)
├── __main__.py            # CLI: transcribe
├── config.py              # configuração (YAML + .env)
├── audio.py               # extração de áudio (ffmpeg)
├── transcriber.py         # Whisper (whisper.cpp / openai-whisper), com VAD e diarização
├── cleanup.py             # remove alucinações: repetições em série e frases-fantasma
├── media_info.py          # data da gravação e duração (ffprobe)
├── transcript_export.py   # grava .md/.txt + meeting.json na pasta da reunião
├── events.py              # eventos JSONL consumidos pelo app
├── models.py              # Transcript, segmentos e quem falou em cada um
└── utils.py               # helpers compartilhados

desktop/                   # app Electron (Synapse) — veja desktop/README.md
├── main.js                # processo principal: jobs, extração, documentos
├── library.js             # reuniões na pasta de saída
├── projects.js tasks.js   # projetos e Kanban (SQLite)
├── claude-jobs.js         # a chamada ao Claude Code (análise da reunião)
├── analysis.js            # a análise: JSON normalizado em analise.json, por reunião
├── document-html.js       # o PDF da reunião montado a partir da análise
├── pipeline-steps.js      # quais etapas rodam depois da transcrição
├── flows.js               # o fluxo: etapas próprias, ordem, validação
├── flow-runner.js         # monta o prompt de cada etapa e encadeia as saídas
├── obs.js                 # gravação pelo OBS, via o servidor MCP
├── mcp-client.js          # cliente MCP por stdio (JSON-RPC 2.0)
├── process-kill.js        # encerrar processo filho sem derrubar o app junto
├── prompts-store.js       # prompts editados em Configurações, por cima do padrão
├── updater.js             # atualização pelo app: git pull + reinstalar o que mudou
├── project-chat.js        # o chat: argumentos do claude -p, system prompt do projeto, eventos
├── chat-messages.js       # histórico do chat por projeto (synapse.db)
├── voice.js               # recado de voz do chat → texto (whisper.cpp local)
├── tts.js                 # resposta → fala: Edge neural (online) ou voz do sistema
├── unicode-path.js        # caminhos com acento nas duas formas do Unicode
├── prompts/               # prompts de extração e documentos, fora do código
└── renderer/              # interface

mcp-obs/                   # servidor MCP do OBS Studio — veja mcp-obs/README.md
├── server.js              # as ferramentas de gravação, em JSON-RPC por stdio
├── obs-websocket.js       # cliente do obs-websocket v5 (sem dependências)
└── recording.js           # começar, parar, pausar e ler o estado da gravação

Dockerfile                 # imagem do motor CPU (whisper.cpp + ffmpeg)
```

---

## Licença

MIT — veja [`LICENSE`](LICENSE).
