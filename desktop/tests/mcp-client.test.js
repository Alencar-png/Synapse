'use strict';

/**
 * O cliente MCP: JSON-RPC 2.0 por stdio.
 *
 * O que se afirma aqui é o contrato do protocolo — handshake antes de
 * qualquer chamada, notificação sem resposta, erro de ferramenta virando
 * exceção. Quebrar qualquer um desses pontos não dá erro de sintaxe: dá um
 * servidor que fecha a conexão sem explicar por quê.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { McpClient } = require('../mcp-client');

/** Um servidor de mentira que responde ao protocolo linha a linha. */
function fakeServer({ responder }) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.recebidas = [];
  child.stdin = new PassThrough();
  child.stdin.setEncoding('utf-8');
  child.stdin.on('data', (chunk) => {
    for (const linha of String(chunk).split('\n').filter(Boolean)) {
      const msg = JSON.parse(linha);
      child.recebidas.push(msg);
      const resposta = responder(msg);
      if (resposta) child.stdout.write(`${JSON.stringify(resposta)}\n`);
    }
  });
  return child;
}

function clienteCom(responder) {
  let servidor;
  const client = new McpClient({
    command: 'node',
    args: ['servidor.js'],
    spawnFn: () => {
      servidor = fakeServer({ responder });
      return servidor;
    },
  });
  return { client, servidor: () => servidor };
}

const ok = (msg, result) => ({ jsonrpc: '2.0', id: msg.id, result });

test('o handshake acontece antes de qualquer chamada', async () => {
  const { client, servidor } = clienteCom((msg) => (msg.id ? ok(msg, {}) : null));
  await client.start();

  const metodos = servidor().recebidas.map((m) => m.method);
  assert.deepEqual(metodos, ['initialize', 'notifications/initialized']);
  // A notificação vai sem id — respondê-la seria erro de protocolo.
  assert.equal(servidor().recebidas[1].id, undefined);
  client.stop();
});

test('callTool devolve o JSON da ferramenta já em objeto', async () => {
  const { client } = clienteCom((msg) => {
    if (!msg.id) return null;
    if (msg.method === 'tools/call') {
      return ok(msg, { content: [{ type: 'text', text: '{"recording":true,"durationSeconds":42}' }] });
    }
    return ok(msg, {});
  });
  await client.start();

  assert.deepEqual(await client.callTool('obs_recording_status'), {
    recording: true,
    durationSeconds: 42,
  });
  client.stop();
});

test('resposta que não é JSON volta como texto, sem quebrar', async () => {
  const { client } = clienteCom((msg) => (msg.method === 'tools/call'
    ? ok(msg, { content: [{ type: 'text', text: 'tudo certo por aqui' }] })
    : ok(msg, {})));
  await client.start();

  assert.deepEqual(await client.callTool('qualquer'), { text: 'tudo certo por aqui' });
  client.stop();
});

test('isError vira exceção com a mensagem da ferramenta', async () => {
  const { client } = clienteCom((msg) => (msg.method === 'tools/call'
    ? ok(msg, { content: [{ type: 'text', text: 'O OBS não está gravando.' }], isError: true })
    : ok(msg, {})));
  await client.start();

  await assert.rejects(
    () => client.callTool('obs_stop_recording'),
    /O OBS não está gravando/,
  );
  client.stop();
});

test('erro de protocolo também vira exceção', async () => {
  const { client } = clienteCom((msg) => {
    if (msg.method === 'tools/call') {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Método não suportado' } };
    }
    return msg.id ? ok(msg, {}) : null;
  });
  await client.start();

  await assert.rejects(() => client.callTool('inexistente'), /Método não suportado/);
  client.stop();
});

test('listTools devolve lista vazia quando o servidor não manda nenhuma', async () => {
  const { client } = clienteCom((msg) => (msg.id ? ok(msg, {}) : null));
  await client.start();

  assert.deepEqual(await client.listTools(), []);
  client.stop();
});

test('o servidor caindo no meio não deixa chamada pendurada', async () => {
  const { client, servidor } = clienteCom((msg) => {
    // Responde só ao handshake; o tools/call fica sem resposta de propósito.
    if (msg.method === 'initialize') return ok(msg, {});
    return null;
  });
  await client.start();

  const chamada = client.callTool('obs_status');
  servidor().emit('exit', 1);

  await assert.rejects(() => chamada, /encerrou/);
});

test('sem servidor no ar, a chamada falha na hora', async () => {
  const client = new McpClient({ command: 'node', args: [] });
  await assert.rejects(() => client.request('tools/list'), /não está no ar/);
});
