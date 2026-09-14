'use strict';

/**
 * A gravação pelo OBS Studio, vista pelo app.
 *
 * O Synapse não fala com o OBS diretamente: ele chama as ferramentas do
 * servidor MCP em `mcp-obs/`, o mesmo que o assistente do projeto pode usar no
 * chat. Uma implementação, dois consumidores — e nada de uma segunda cópia da
 * lógica de gravação vivendo dentro do processo principal.
 *
 * O servidor sobe na primeira chamada e fica de pé enquanto o app estiver
 * aberto. É um processo Node pequeno e ocioso entre uma gravação e outra; subir
 * e derrubar a cada clique custaria mais do que mantê-lo.
 */

const path = require('node:path');

const { McpClient } = require('./mcp-client');

const SERVER_PATH = path.join(__dirname, '..', 'mcp-obs', 'server.js');

// Porta padrão do obs-websocket, embutido no OBS desde a versão 28.
const DEFAULT_OBS = Object.freeze({
  enabled: false,
  host: '127.0.0.1',
  port: 4455,
  password: '',
});

/** Completa o que falta e descarta o que não serve. */
function normalizeObs(raw) {
  const obs = { ...DEFAULT_OBS };
  if (!raw || typeof raw !== 'object') return obs;
  obs.enabled = Boolean(raw.enabled);
  if (typeof raw.host === 'string' && raw.host.trim()) obs.host = raw.host.trim().slice(0, 120);
  const porta = Number(raw.port);
  if (Number.isInteger(porta) && porta > 0 && porta < 65536) obs.port = porta;
  if (typeof raw.password === 'string') obs.password = raw.password.slice(0, 200);
  return obs;
}

let client = null;
let assinatura = '';

/** Identifica a configuração em uso: mudou, o servidor precisa renascer. */
const chave = ({ host, port, password }) => `${host}:${port}:${password ? 'auth' : 'aberto'}`;

async function ensureClient(config) {
  const obs = normalizeObs(config);
  if (client && assinatura === chave(obs)) return client;

  if (client) client.stop();
  client = new McpClient({
    command: process.execPath,
    args: [SERVER_PATH],
    // O Electron reaproveita o próprio binário como Node quando esta variável
    // está presente; sem ela, `process.execPath` abriria outra janela do app.
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      OBS_HOST: obs.host,
      OBS_PORT: String(obs.port),
      OBS_PASSWORD: obs.password,
    },
  });
  assinatura = chave(obs);
  await client.start();
  return client;
}

/**
 * Chama uma ferramenta do servidor e nunca lança.
 *
 * O OBS estar fechado é o caso comum, não uma exceção: o app precisa dessa
 * resposta para decidir entre gravar pelo OBS ou pela própria janela, e uma
 * exceção no meio do caminho viraria uma tela de erro onde deveria haver uma
 * gravação começando.
 */
async function call(config, tool, args = {}) {
  try {
    const mcp = await ensureClient(config);
    return { ok: true, ...(await mcp.callTool(tool, args)) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/** Se dá para gravar pelo OBS agora, e o que falta quando não dá. */
async function status(config) {
  const obs = normalizeObs(config);
  if (!obs.enabled) {
    return { ok: false, enabled: false, message: 'Gravação pelo OBS desligada nas configurações.' };
  }
  const r = await call(obs, 'obs_status');
  if (!r.ok) return { ...r, enabled: true };
  return {
    ...r,
    enabled: true,
    // O OBS grava de qualquer jeito, mas com uma faixa só o microfone e a
    // chamada chegam somados — e aí não há como marcar quem falou.
    warning: r.separateAudioTracks
      ? ''
      : 'O OBS está gravando tudo numa faixa só. Para marcar quem fala, use o modo '
        + 'de saída Avançado e ligue as faixas 1 e 2 em Configurações → Saída.',
  };
}

const startRecording = (config) => call(normalizeObs(config), 'obs_start_recording');
const stopRecording = (config) => call(normalizeObs(config), 'obs_stop_recording');
const recordingStatus = (config) => call(normalizeObs(config), 'obs_recording_status');
const pauseRecording = (config, resume = false) =>
  call(normalizeObs(config), 'obs_pause_recording', { resume });

/** Derruba o servidor MCP — no encerramento do app. */
function shutdown() {
  if (client) client.stop();
  client = null;
  assinatura = '';
}

module.exports = {
  DEFAULT_OBS,
  SERVER_PATH,
  normalizeObs,
  pauseRecording,
  recordingStatus,
  shutdown,
  startRecording,
  status,
  stopRecording,
};
