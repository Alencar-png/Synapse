#!/usr/bin/env node
'use strict';

/**
 * Servidor MCP do Synapse.
 *
 * Abre o workspace — projetos, reuniões, análises, transcrições e o Kanban —
 * como ferramentas do Model Context Protocol, em JSON-RPC 2.0 por
 * stdin/stdout. Registrado no Claude Code, o assistente passa a poder
 * responder "o que ficou decidido na última reunião do projeto X" sem que
 * ninguém precise abrir o app, achar a pasta e colar a transcrição.
 *
 * **Só lê.** Não há ferramenta que crie, renomeie ou apague nada. Quem escreve
 * no workspace é o app; um assistente com permissão de apagar reuniões seria
 * uma superfície de estrago sem contrapartida.
 *
 * A pasta de saída é descoberta sozinha (`workspace-path.js`): o servidor lê o
 * settings.json do app, do mesmo jeito que o app o lê. `SYNAPSE_OUTPUT_DIR`
 * aponta para outra, quando for o caso.
 *
 * Para usar no Claude Code, em `.mcp.json`:
 *
 *     { "mcpServers": { "synapse": {
 *         "command": "node",
 *         "args": ["mcp-synapse/server.js"] } } }
 */

// `node:sqlite` ainda é experimental e avisa a cada abertura. O aviso vai para
// o stderr, onde o cliente MCP o mostra como se fosse problema do servidor —
// e não é: o banco do Synapse é lido com a API estável o suficiente para o que
// fazemos aqui. Os outros avisos seguem passando.
process.on('warning', (aviso) => {
  if (aviso.name === 'ExperimentalWarning' && /SQLite/i.test(aviso.message)) return;
  console.error(aviso.stack || String(aviso));
});

const tools = require('./tools');
const { resolveWorkspace } = require('./workspace-path');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'synapse', version: '1.0.0' };

/** A pasta de saída, resolvida a cada chamada: o app pode tê-la mudado. */
const dir = () => resolveWorkspace().dir;

// As ferramentas, com a descrição que um modelo lê para decidir usá-las. O
// texto é parte do contrato: vago aqui vira ferramenta usada na hora errada —
// e, neste servidor, vira também transcrição de 150 KB despejada no contexto
// quando bastava a análise.
const TOOLS = [
  {
    name: 'synapse_overview',
    description:
      'Quantos projetos, reuniões e tarefas abertas existem no Synapse, e quantas horas '
      + 'já foram transcritas. Barata e sem argumentos: comece por aqui para saber se há '
      + 'material antes de procurar por ele.',
    inputSchema: { type: 'object', properties: {} },
    run: () => tools.overview(dir()),
  },
  {
    name: 'synapse_list_projects',
    description:
      'Os projetos do Synapse: nome, o contexto que descreve cada um, quantas reuniões e '
      + 'tarefas abertas tem, e a data da última reunião. O contexto é a melhor descrição '
      + 'disponível do que o projeto é.',
    inputSchema: { type: 'object', properties: {} },
    run: () => tools.listProjects(dir()),
  },
  {
    name: 'synapse_list_meetings',
    description:
      'As reuniões, da mais recente para a mais antiga: nome, projeto, quando foi gravada, '
      + 'duração, número de falas e se já tem análise. NÃO devolve transcrição — use esta '
      + 'para escolher qual reunião abrir, e depois synapse_get_meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        projeto: {
          type: 'string',
          description: 'Só as reuniões deste projeto (nome ou id; nome parcial serve)',
        },
        limite: {
          type: 'number',
          description: 'Quantas reuniões no máximo (padrão 50)',
        },
      },
    },
    run: (args) => tools.listMeetings(dir(), args),
  },
  {
    name: 'synapse_get_meeting',
    description:
      'Uma reunião com a análise que o Claude já extraiu quando ela foi processada: visão '
      + 'geral, pontos discutidos, decisões, riscos, tarefas combinadas e pendências. '
      + 'Para quase toda pergunta sobre uma reunião, isto responde — e custa uma fração de '
      + 'ler a transcrição. Vem também o tamanho da transcrição, para a decisão de lê-la '
      + 'ser informada.',
    inputSchema: {
      type: 'object',
      properties: {
        reuniao: {
          type: 'string',
          description: 'Nome ou id da reunião. Nome parcial e sem acento também funciona.',
        },
      },
      required: ['reuniao'],
    },
    run: (args) => tools.getMeeting(dir(), args),
  },
  {
    name: 'synapse_read_transcript',
    description:
      'O texto da transcrição, em páginas de linhas. Use só quando a análise '
      + '(synapse_get_meeting) não bastar — quando importa a palavra exata, quem disse o '
      + 'quê, ou um trecho que a análise não cobriu. A resposta diz quantas linhas faltam '
      + 'e por onde continuar.',
    inputSchema: {
      type: 'object',
      properties: {
        reuniao: { type: 'string', description: 'Nome ou id da reunião' },
        inicio: { type: 'number', description: 'Primeira linha a ler (base 1, padrão 1)' },
        linhas: { type: 'number', description: 'Quantas linhas ler (padrão 200, teto 2000)' },
      },
      required: ['reuniao'],
    },
    run: (args) => tools.readTranscript(dir(), args),
  },
  {
    name: 'synapse_search',
    description:
      'Procura um termo nas transcrições de todas as reuniões e devolve os trechos onde ele '
      + 'aparece, com o texto em volta. É a ferramenta para "o que já foi dito sobre X" '
      + 'quando não se sabe em qual reunião procurar. Ignora acento e maiúsculas.',
    inputSchema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'O que procurar' },
        projeto: { type: 'string', description: 'Limita a busca a um projeto' },
        limite: { type: 'number', description: 'Quantas reuniões no resultado (padrão 20)' },
      },
      required: ['termo'],
    },
    run: (args) => tools.searchTranscripts(dir(), args),
  },
  {
    name: 'synapse_list_tasks',
    description:
      'As tarefas do Kanban — as que a análise extraiu das reuniões e as criadas à mão — '
      + 'com responsável, prioridade, status e de qual reunião saíram.',
    inputSchema: {
      type: 'object',
      properties: {
        projeto: { type: 'string', description: 'Só as tarefas deste projeto' },
        status: {
          type: 'string',
          description: 'Filtra por coluna do Kanban',
          enum: ['backlog', 'doing', 'done'],
        },
      },
    },
    run: (args) => tools.listTasks(dir(), args),
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** A ferramenta como o protocolo a descreve — sem o `run`, que é nosso. */
const publicTool = ({ name, description, inputSchema }) => ({ name, description, inputSchema });

async function callTool(name, args) {
  const tool = toolByName.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }], isError: true };
  }
  try {
    const resultado = await tool.run(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }] };
  } catch (err) {
    // Erro de ferramenta volta como resultado com isError, não como erro de
    // protocolo: as mensagens daqui dizem o que fazer em seguida ("use
    // synapse_list_meetings"), e o modelo precisa lê-las para se corrigir.
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
    case 'tools/list':
      return { tools: TOOLS.map(publicTool) };
    case 'tools/call':
      return callTool(request.params?.name, request.params?.arguments);
    case 'ping':
      return {};
    default:
      return null;   // método desconhecido: vira erro -32601 abaixo
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * O laço do protocolo: uma mensagem JSON por linha.
 *
 * Notificações (sem `id`) não recebem resposta — respondê-las é erro de
 * protocolo, e o cliente encerra a conexão.
 */
async function onLine(linha) {
  const texto = linha.trim();
  if (!texto) return;

  let request;
  try {
    request = JSON.parse(texto);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    return;
  }

  const temId = request.id !== undefined && request.id !== null;
  try {
    const result = await handle(request);
    if (!temId) return;
    if (result === null) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Método não suportado: ${request.method}` },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch (err) {
    if (!temId) return;
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: err.message } });
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const linhas = buffer.split('\n');
    buffer = linhas.pop();   // a última pode estar pela metade
    for (const linha of linhas) onLine(linha);
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { PROTOCOL_VERSION, SERVER_INFO, TOOLS, callTool, handle, publicTool };
