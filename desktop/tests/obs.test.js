'use strict';

/**
 * A camada do OBS vista pelo app, e o servidor MCP que está do outro lado.
 *
 * O que importa aqui: o app precisa saber *decidir* — gravar pelo OBS ou pela
 * própria janela — e essa decisão depende de uma resposta honesta sobre o que
 * o OBS tem configurado. Uma faixa de áudio só significa tudo misturado, e
 * gravar assim prometendo marcar quem fala seria pior do que não marcar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeObs, DEFAULT_OBS } = require('../obs');
const { countTracks } = require('../../mcp-obs/recording');
const { authenticationString, explainConnectionError } = require('../../mcp-obs/obs-websocket');
const server = require('../../mcp-obs/server');

test('normalizeObs completa o que falta e recusa o que não serve', () => {
  assert.deepEqual(normalizeObs(undefined), DEFAULT_OBS);
  assert.deepEqual(normalizeObs('não é objeto'), DEFAULT_OBS);

  const cheio = normalizeObs({ enabled: true, host: ' 192.168.0.5 ', port: 4466, password: 'x' });
  assert.deepEqual(cheio, { enabled: true, host: '192.168.0.5', port: 4466, password: 'x' });

  // Porta fora da faixa não derruba a configuração: cai no padrão.
  assert.equal(normalizeObs({ port: 0 }).port, 4455);
  assert.equal(normalizeObs({ port: 99999 }).port, 4455);
  assert.equal(normalizeObs({ port: 'quatro mil' }).port, 4455);
  assert.equal(normalizeObs({ host: '   ' }).host, '127.0.0.1');
});

test('countTracks lê a bitmask de faixas do perfil do OBS', () => {
  assert.equal(countTracks('1'), 1);    // só a faixa 1
  assert.equal(countTracks('3'), 2);    // faixas 1 e 2 — mic e sistema separados
  assert.equal(countTracks('7'), 3);
  assert.equal(countTracks(63), 6);
  // Valor ausente ou sem sentido vale como "uma faixa": o pessimista é quem
  // não promete separação que talvez não exista.
  assert.equal(countTracks(''), 1);
  assert.equal(countTracks(undefined), 1);
  assert.equal(countTracks('abc'), 1);
});

test('a prova de senha segue a receita do obs-websocket v5', () => {
  // Duas voltas de sha256+base64: primeiro senha+salt, depois esse resultado
  // + challenge. A senha em si nunca sai da máquina.
  //
  // A entrada é o exemplo da especificação do protocolo; o valor esperado foi
  // obtido aplicando os quatro passos dela a essa entrada (a spec publica o
  // algoritmo, não o resultado). Errar a ordem ou o encoding aqui não produz
  // erro visível — produz um OBS que fecha a conexão sem dizer por quê.
  const prova = authenticationString('supersecretpassword', {
    salt: 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=',
    challenge: '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=',
  });
  assert.equal(prova, '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');

  // Salt e challenge mudam a cada conexão: a mesma senha nunca dá a mesma prova.
  const outra = authenticationString('supersecretpassword', {
    salt: 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=',
    challenge: 'outroDesafioQualquer=',
  });
  assert.notEqual(prova, outra);
});

test('erro de conexão diz o que ligar, não o código do soquete', () => {
  const alvo = { host: '127.0.0.1', port: 4455 };

  const recusado = explainConnectionError(new Error('connect ECONNREFUSED'), alvo);
  assert.match(recusado, /Servidor WebSocket/);
  assert.match(recusado, /127\.0\.0\.1:4455/);

  // O WebSocket do Node diz "Received network error or non-101 status code":
  // a causa prática é a mesma, e a saída também.
  assert.match(
    explainConnectionError(new Error('Received network error or non-101 status code.'), alvo),
    /Abra o OBS/,
  );
  assert.match(explainConnectionError(new Error('timeout'), alvo), /não respondeu a tempo/);
});

test('o servidor MCP anuncia as ferramentas de gravação', async () => {
  const inicial = await server.handle({ method: 'initialize' });
  assert.equal(inicial.protocolVersion, server.PROTOCOL_VERSION);
  assert.equal(inicial.serverInfo.name, 'synapse-obs');

  const { tools } = await server.handle({ method: 'tools/list' });
  const nomes = tools.map((t) => t.name);
  assert.deepEqual(nomes, [
    'obs_status',
    'obs_start_recording',
    'obs_stop_recording',
    'obs_recording_status',
    'obs_pause_recording',
  ]);
  // A descrição é o que um modelo lê para decidir usar a ferramenta: vaga
  // aqui, ela é usada na hora errada.
  for (const t of tools) {
    assert.ok(t.description.length > 40, `descrição curta demais em ${t.name}`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.run, undefined, 'o run é nosso, não vai para o protocolo');
  }
});

test('método desconhecido vira erro de protocolo, não exceção', async () => {
  assert.equal(await server.handle({ method: 'resources/list' }), null);
  assert.deepEqual(await server.handle({ method: 'ping' }), {});
});

test('ferramenta inexistente responde com isError, não derruba o servidor', async () => {
  const r = await server.callTool('obs_dançar', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /desconhecida/);
});
