# Servidor MCP do OBS Studio

Expõe a gravação do OBS como ferramentas do Model Context Protocol. O Synapse
usa este servidor para gravar reuniões; como ele é MCP de verdade, o Claude
Code (e qualquer outro cliente) também pode usá-lo.

## O que ele faz

| Ferramenta | Para quê |
|------------|----------|
| `obs_status` | Versão, se está gravando, pasta de saída e **se o áudio está em faixas separadas** |
| `obs_start_recording` | Começa a gravar com o perfil e a cena atuais |
| `obs_stop_recording` | Encerra e devolve o caminho do arquivo (`outputPath`) |
| `obs_recording_status` | Duração e tamanho da gravação em andamento |
| `obs_pause_recording` | Pausa ou retoma (`resume: true`) |

Sem dependências: o protocolo é JSON-RPC 2.0 por stdio e a conexão com o OBS
usa o `WebSocket` que o Node 22 já traz.

## Ligar o OBS

O obs-websocket vem embutido no OBS desde a versão 28. Em **Ferramentas →
Configurações do Servidor WebSocket**:

1. marque *Ativar servidor WebSocket*;
2. anote a porta (4455 por padrão) e a senha em *Mostrar informações de conexão*.

No Synapse, a senha vai em **Configurações → Gravar pelo OBS Studio**.

## Faixas separadas (para saber quem falou)

Com o áudio numa faixa só, o microfone e o som da chamada chegam somados, e não
há como dizer quem falou. Para separar, em **Configurações → Saída** do OBS:

1. Modo de saída: **Avançado**;
2. na aba *Gravação*, marque as faixas **1 e 2**;
3. em **Configurações → Áudio**, mande o microfone para a faixa 1 e o áudio da
   área de trabalho para a faixa 2 (no mixer, ⚙ → *Propriedades de áudio
   avançadas*).

Grave em **MKV** ou **hybrid MP4**: o MP4 simples não guarda várias faixas.

`obs_status` responde `separateAudioTracks: true` quando isso está no lugar, e
o app avisa na tela quando não está.

## Usar no Claude Code

O `.mcp.json` na raiz do repositório já registra este servidor. Para a senha,
exporte `OBS_PASSWORD` antes de abrir o Claude Code — argumento de linha de
comando apareceria na lista de processos da máquina inteira.

```bash
export OBS_PASSWORD="a senha do OBS"   # PowerShell: $env:OBS_PASSWORD = "..."
claude
```

Depois é só pedir: *"comece a gravar no OBS"*, *"a gravação já passou de
quarenta minutos?"*.

## Rodar na mão

```bash
node mcp-obs/server.js
```

Ele fala JSON-RPC pelo stdin, uma mensagem por linha:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```
