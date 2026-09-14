#!/usr/bin/env node
'use strict';

/**
 * Servidor MCP do OBS Studio.
 *
 * Expõe a gravação do OBS como ferramentas do Model Context Protocol, faladas
 * em JSON-RPC 2.0 por stdin/stdout. Quem chama é o Synapse — mas, por ser MCP
 * de verdade, qualquer cliente serve: registrado no Claude Code, o assistente
 * do projeto passa a poder começar e parar a gravação sozinho.
 *
 * A conexão com o OBS vem das variáveis de ambiente `OBS_HOST`, `OBS_PORT` e
 * `OBS_PASSWORD`. A senha por ambiente, e não por argumento, porque argumento
 * de processo aparece na lista de processos da máquina inteira.
 *
 * Para usar no Claude Code, em `.mcp.json`:
 *
 *     { "mcpServers": { "obs": {
 *         "command": "node",
 *         "args": ["mcp-obs/server.js"],
 *         "env": { "OBS_PASSWORD": "..." } } } }
 */

const recording = require('./recording');
const { DEFAULT_HOST, DEFAULT_PORT } = require('./obs-websocket');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'synapse-obs', version: '1.0.0' };

function options() {
  return {
    host: process.env.OBS_HOST || DEFAULT_HOST,
    port: Number(process.env.OBS_PORT) || DEFAULT_PORT,
    password: process.env.OBS_PASSWORD || '',
  };
}

// As ferramentas, com a descrição que um modelo lê para decidir usá-las. O
// texto é parte do contrato: vago aqui vira ferramenta usada na hora errada.
const TOOLS = [
  {
    name: 'obs_status',
    description:
      'Estado do OBS Studio: versão, se está gravando agora, a pasta de saída e se o '
      + 'áudio está configurado em faixas separadas (microfone e sistema em faixas '
      + 'distintas, o que permite identificar quem falou na transcrição). '
      + 'Use antes de gravar, para saber se o OBS está disponível.',
    inputSchema: { type: 'object', properties: {} },
    run: () => recording.status(options()),
  },
  {
    name: 'obs_start_recording',
    description:
      'Começa a gravar no OBS Studio com o perfil e a cena que já estão configurados. '
      + 'Falha se já houver uma gravação em andamento.',
    inputSchema: { type: 'object', properties: {} },
    run: () => recording.startRecording(options()),
  },
  {
    name: 'obs_stop_recording',
    description:
      'Encerra a gravação do OBS e devolve o caminho do arquivo gravado (outputPath) '
      + 'e a duração em segundos.',
    inputSchema: { type: 'object', properties: {} },
    run: () => recording.stopRecording(options()),
  },
  {
    name: 'obs_recording_status',
    description:
      'Se o OBS está gravando neste momento, há quanto tempo e quantos bytes já foram '
      + 'escritos. Barato: use para acompanhar uma gravação em andamento.',
    inputSchema: { type: 'object', properties: {} },
    run: () => recording.recordingStatus(options()),
  },
  {
    name: 'obs_pause_recording',
    description:
      'Pausa a gravação em andamento, ou retoma quando "resume" é verdadeiro. O arquivo '
      + 'continua sendo o mesmo — o trecho pausado simplesmente não entra.',
    inputSchema: {
      type: 'object',
      properties: {
        resume: { type: 'boolean', description: 'true para retomar em vez de pausar' },
      },
    },
    run: (args) => recording.pauseRecording(options(), { resume: Boolean(args?.resume) }),
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
    // protocolo: o modelo precisa ler o motivo para poder contorná-lo.
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
