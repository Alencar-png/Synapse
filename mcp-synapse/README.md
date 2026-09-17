# mcp-synapse

Servidor **MCP** que abre o workspace do Synapse — projetos, reuniões,
análises, transcrições e o Kanban — para qualquer assistente que fale Model
Context Protocol. Registrado no Claude Code, o assistente responde *"o que
ficou decidido na última reunião do projeto X"* sem que ninguém precise abrir o
app, achar a pasta e colar a transcrição.

**Só lê.** Não existe ferramenta que crie, renomeie ou apague nada. Quem
escreve no workspace é o app; um assistente com permissão de apagar reuniões
seria uma superfície de estrago sem contrapartida.

## Usar

Já vem registrado em [`.mcp.json`](../.mcp.json) na raiz do projeto — o Claude
Code o encontra sozinho ao abrir esta pasta. Para usá-lo de qualquer outro
lugar:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/caminho/para/Synapse/mcp-synapse/server.js"]
    }
  }
}
```

Sem dependências: só o Node 22+ que o app já exige (o banco é lido com o
`node:sqlite` embutido).

## Onde ele acha o workspace

Sozinho, na mesma ordem que o app usa, do mais explícito ao mais genérico:

| Ordem | Origem |
|-------|--------|
| 1 | `SYNAPSE_OUTPUT_DIR` — aponta direto para uma pasta de saída |
| 2 | `SYNAPSE_USER_DATA`/`settings.json` |
| 3 | O `settings.json` na pasta de dados do app |
| 4 | `~/Documents/Transcricoes`, o padrão de fábrica |

O primeiro degrau é o que permite ler um workspace que não é o desta máquina —
um backup, um disco de rede — sem mexer na configuração do app.

## As ferramentas

| Ferramenta | O que devolve |
|------------|---------------|
| `synapse_overview` | Quantos projetos, reuniões e tarefas abertas, e horas transcritas |
| `synapse_list_projects` | Projetos com o contexto, contagens e a data da última reunião |
| `synapse_list_meetings` | Reuniões com data, duração e se já têm análise — **sem transcrição** |
| `synapse_get_meeting` | Uma reunião com a análise: visão geral, decisões, riscos, tarefas, pendências |
| `synapse_read_transcript` | O texto da transcrição, paginado por linhas |
| `synapse_search` | Trechos onde um termo aparece, em todas as reuniões |
| `synapse_list_tasks` | As tarefas do Kanban, com responsável, status e reunião de origem |

### O caminho barato

`synapse_get_meeting` devolve a **análise** que o Claude já extraiu quando a
reunião foi processada. Para quase toda pergunta sobre uma reunião, ela
responde — e custa uma fração de ler a transcrição. `synapse_read_transcript`
existe para quando importa a palavra exata, quem disse o quê, ou um trecho que
a análise não cobriu.

Isso é deliberado, e é o assunto do código: uma reunião de duas horas gera
150 KB e três mil falas. Por isso a listagem não traz uma linha de texto, a
busca devolve recortes com o contexto em volta, e a leitura sai em páginas
dizendo sempre quantas linhas faltam — um modelo que lê as primeiras 200 linhas
sem saber que há 3.000 conclui sobre o começo achando que viu o todo.

### Nome em vez de id

As ferramentas aceitam o nome da reunião ou do projeto, sem acento e pela
metade: um assistente repete o que viu na listagem, não guarda ids. Quando o
que veio casa com mais de um, a resposta **recusa escolher** e lista os
candidatos — a resposta certa sobre a reunião errada é o pior resultado
possível.

## Exemplos

> *"Do que tratou a última reunião do projeto Onboarding?"*
> → `synapse_list_meetings` (projeto: Onboarding) → `synapse_get_meeting`

> *"O que já foi dito sobre precificação?"*
> → `synapse_search` (termo: precificação) → `synapse_read_transcript` no ponto

> *"O que está pendente comigo?"*
> → `synapse_list_tasks` (status: backlog)

## Testes

```bash
cd desktop && npm test          # tests/mcp-synapse.test.js
```

Workspace de verdade em pasta temporária — pastas de reunião, banco SQLite,
arquivos de transcrição e de análise. O que se afirma: que a listagem não
vaza transcrição, que a paginação diz o que falta, que o nome tolera acento e
abreviação, que a ambiguidade é recusada, e que nenhuma ferramenta de escrita
foi exposta.
