# Backlog — Synapse

Status real do produto. 🟢 = pronto e verificado no app com dados reais,
🟡 = parcial, ⬜ = pendente.

| ID | Épico | Feature | Prior. | Status |
|----|-------|---------|--------|--------|
| PRJ-01 | Projetos | Criar projeto | Alta | 🟢 |
| PRJ-02 | Projetos | Editar projeto | Alta | 🟢 |
| PRJ-03 | Projetos | Excluir projeto | Alta | 🟡 leva tudo: reuniões (Lixeira), pasta `synapse`, tarefas, vínculos e chat; falta verificar no app |
| PRJ-04 | Projetos | Listar projetos | Alta | 🟢 (módulo próprio: blocos ou tabela ordenável, com CRUD na própria lista) |
| PRJ-05 | Projetos | Dashboard individual do projeto | Alta | 🟢 |
| PRJ-06 | Projetos | Associar reuniões ao projeto | Alta | 🟢 (na importação, na gravação e no painel da reunião) |
| KAN-01 | Kanban | Kanban individual por projeto | Alta | 🟢 |
| KAN-02 | Kanban | Colunas configuráveis | Média | ⬜ (fixas: backlog, em andamento, concluído) |
| KAN-03 | Kanban | Cards de tarefas | Alta | 🟢 |
| KAN-04 | Kanban | Drag-and-drop entre colunas | Alta | 🟢 |
| KAN-05 | Kanban | Abrir detalhes do card | Alta | 🟢 |
| KAN-06 | Kanban | Criar/editar/excluir tarefa manual | Alta | 🟢 |
| KAN-07 | Kanban | Vincular card à reunião de origem | Alta | 🟢 (e o painel da reunião lista as tarefas dela, abrindo o card) |
| AI-01 | IA | Analisar a reunião (uma leitura só) | Alta | 🟡 `prompts/analise.md` → `analise.json`; cards e PDF saem dela; falta verificar no app com reunião real |
| AI-02 | IA | Criar automaticamente cards das ações | Alta | 🟢 (roda ao fim do pipeline, antes do aviso de pronto) |
| AI-03 | IA | Gerar o documento da reunião | Alta | 🟡 PDF montado pelo app a partir da análise (`document-html.js`); a tabela de tarefas é a mesma do Kanban; falta verificar no app |
| AI-04 | IA | Documento PDF dentro do projeto | Alta | 🟢 (painel da reunião) |
| AI-05 | IA | Identificar contexto entre reuniões | Média | ⬜ M3 |
| REC-01 | Gravação | Iniciar gravação dentro do projeto | Alta | 🟢 (microfone + áudio do sistema) |
| REC-02 | Gravação | Pausar/continuar | Média | 🟡 pelo OBS (`obs_pause_recording`); a captura do próprio app ainda não pausa |
| REC-03 | Gravação | Encerrar gravação | Alta | 🟢 |
| REC-04 | Gravação | Processar automaticamente após encerrar | Alta | 🟢 (mesmo pipeline da importação) |
| REC-05 | Gravação | Associar gravação ao projeto | Alta | 🟢 |
| MEM-01 | Memória | Indexar reuniões em Vector DB | Alta | ⬜ M3 |
| MEM-02 | Memória | Indexar tarefas/cards | Alta | ⬜ M3 |
| MEM-03 | Memória | Embeddings dos contextos | Alta | ⬜ M3 |
| MEM-04 | Memória | Relacionar reuniões semanticamente | Média | ⬜ M3 |
| MEM-05 | Memória | Relacionar tarefas semanticamente | Média | ⬜ M3 |
| MEM-06 | Memória | Grafo visual estilo Obsidian | Média | 🟢 (projeto ↔ reuniões ↔ tarefas; conceitos entram no M4) |
| MEM-07 | Memória | Abrir reunião/card clicando no nó | Média | 🟢 |
| CHAT-01 | Chat | Chat individual por projeto | Alta | 🟡 é o Claude Code (`claude -p`) com sessão por projeto e system prompt do projeto (`project-chat.js`); falta verificar no app |
| CHAT-02 | Chat | Reuniões do projeto no chat | Alta | 🟡 o system prompt leva os caminhos de transcrição, análise e PDF; o Claude lê com Read (sem embeddings — M3 continua para busca semântica) |
| CHAT-03 | Chat | Tarefas do projeto no chat | Alta | 🟡 tarefas abertas entram no system prompt |
| CHAT-04 | Chat | Histórico de conversas | Média | 🟡 persistido em `chat_messages` (synapse.db); "Nova conversa" apaga e solta a sessão |
| CHAT-05 | Chat | Citar reunião utilizada | Alta | 🟡 o Claude cita no texto; as ferramentas usadas (arquivos lidos) aparecem acima da resposta |
| CHAT-06 | Chat | Citar tarefas/cards utilizados | Alta | 🟡 idem, no texto |
| CHAT-07 | Chat | Modo autônomo por projeto (bypass) | Alta | 🟡 interruptor no chat, desligado por padrão, com confirmação; `--dangerously-skip-permissions`; modo leitura só Read/Glob/Grep/web |
| CHAT-08 | Chat | Conversar por voz | Alta | 🟡 microfone → whisper.cpp local (GPU, VAD) → mensagem; modo Voz envia direto e lê a resposta; dois motores (Edge neural online, voz do sistema); cada resposta tem 🔊 → barra de progresso (frase N de M, tocando conforme chega) → player para reouvir; falta verificar no app |
| PRJ-07 | Projetos | Pasta de trabalho do projeto | Alta | 🟡 a casa do projeto: `synapse/` dentro dela guarda as reuniões dele (biblioteca lê várias raízes; mudar a pasta move; excluir o projeto exclui tudo dele); é o cwd do chat |
| UI-01 | Interface | Sidebar organizada por módulos | Alta | 🟢 |
| UI-02 | Interface | Navegação Projeto → Dashboard | Alta | 🟢 |
| UI-03 | Interface | Alternar Kanban/Reuniões/Grafo/Chat | Alta | 🟢 |
| SET-01 | Interface | Configurações centralizadas | Alta | 🟢 (motor, modelo, idioma, pasta de saída) |
| SET-02 | Interface | Ligar/desligar cada etapa depois da transcrição | Alta | 🟡 implementado (tarefas no Kanban, documento em PDF); falta verificar no app com reunião real |
| SET-03 | Interface | Ver e editar o prompt de cada etapa | Alta | 🟢 modal em Configurações; a edição vale por cima do padrão, com restaurar |
| SET-05 | Interface | Fluxo próprio depois da transcrição | Alta | 🟢 etapas criadas por quem usa, em ordem, encadeadas (a saída de uma alimenta a seguinte); cada uma pode chamar uma skill do Claude Code (`flows.js`, `flow-runner.js`) |
| REC-06 | Gravação | Gravar pelo OBS Studio via MCP | Alta | 🟢 servidor MCP próprio em `mcp-obs/` (obs-websocket v5, sem dependências); o app usa quando o OBS está no ar e cai na captura própria quando não está |
| TRA-01 | Transcrição | Identificar quem fala | Alta | 🟢 `--diarize` do whisper.cpp: microfone à esquerda, som da chamada à direita; a transcrição sai com "Você" e "Participantes" |
| TRA-02 | Transcrição | Whisper Large V3 como padrão | Alta | 🟢 preferência por fidelidade, não por tamanho (`MODEL_PREFERENCE`, nos dois motores) |
| SET-04 | Interface | Atualizar o app pelo próprio app | Alta | 🟡 implementado (Sobre → verificar, lista dos commits, atualizar, reiniciar; recusa árvore suja e histórico divergente); falta verificar contra o remoto |
| UI-04 | Interface | Minimizar a tela de processamento e seguir usando o app | Alta | 🟡 implementado (chip na barra lateral com progresso; Esc minimiza); falta verificar no app |

## Milestones

- **M1 — Projects** ✅ projetos, kanban, reuniões vinculadas, grafo, gravação e
  extração automática de tarefas, tudo sobre a pasta de saída.
- **M2 — Meetings → Work** 🟡 falta pausar/continuar a gravação, colunas
  configuráveis e o resumo estruturado (hoje o resumo só existe em PDF).
- **M3 — Memory** ⬜ embeddings + Vector DB local, `chatAsk` real com RAG,
  citações clicáveis e relações semânticas entre reuniões e tarefas.
- **M4 — Neural Graph** ⬜ extração de entidades e conceitos; nós de conceito
  no grafo ligando reuniões que falam do mesmo assunto.

## Verificado nesta entrega

Áudio de teste (42 s, pt-BR) processado pelo app do começo ao fim:

```
audio 100% → transcription 100% (whisper.cpp, GPU AMD, 6 s) →
export 2 arquivo(s) → extract → 4 tarefas criadas com responsáveis
```

As tarefas saíram com título, descrição, responsável e prioridade, ligadas à
reunião de origem, e apareceram no kanban do projeto sem intervenção manual.

**Quem fala**, medido no próprio whisper.cpp desta máquina: WAV estéreo com uma
fala em cada canal, `--diarize` ligado, modelo `large-v3-turbo` na Radeon RX
9060 XT.

```
[00:00:00 → 00:00:03] (speaker 0) Bom dia pessoal, eu sou o anfitrião da reunião.
[00:00:07 → 00:00:10] (speaker 1) Claro, do meu lado o relatório fica pronto na sexta-feira.
```

No JSON o falante vem em campo próprio (`"speaker": "0"`), com o texto limpo, e
os tempos continuam certos **com o VAD ligado** — os dois foram testados juntos.

**Servidor MCP do OBS**: handshake, `tools/list` e `tools/call` verificados
contra o servidor real (`mcp-obs/server.js`) pelo cliente do app. A conexão com
o OBS em si ainda não foi exercitada ao vivo: o obs-websocket precisa estar
ligado na máquina.

**Testes**: 154 unidades (node:test), 68 do motor (pytest) e 38 de ponta a ponta
(Playwright abrindo o Electron de verdade).
