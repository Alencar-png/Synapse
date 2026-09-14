'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { dockerRemove, killTree, spawnDetached } = require('../process-kill');

/** Um filho de mentira que registra o que recebeu. */
function fakeSpawn(registro, { throws = false } = {}) {
  return (command, args, options) => {
    if (throws) throw new Error('spawn síncrono falhou');
    registro.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4321;
    return child;
  };
}

test('spawnDetached ouve o erro de nascimento em vez de deixá-lo escapar', () => {
  const chamadas = [];
  const child = spawnDetached('taskkill', ['/pid', '1'], fakeSpawn(chamadas));

  // Sem ouvinte, este emit derrubaria o processo inteiro do Electron.
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('não achei'), { code: 'ENOENT' })));
  assert.equal(child.listenerCount('error'), 1);
});

test('spawnDetached devolve null quando o próprio spawn lança', () => {
  assert.equal(spawnDetached('taskkill', [], fakeSpawn([], { throws: true })), null);
});

test('killTree no Windows derruba a árvore, não só o pai', () => {
  const chamadas = [];
  const ok = killTree({ pid: 99 }, { platform: 'win32', spawnFn: fakeSpawn(chamadas) });

  assert.equal(ok, true);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].command, 'taskkill');
  // /t é o que leva os filhos junto: sem ele o whisper-cli segue na GPU.
  assert.deepEqual(chamadas[0].args, ['/pid', '99', '/t', '/f']);
});

test('killTree fora do Windows manda o sinal direto ao filho', () => {
  let matou = false;
  const ok = killTree({ pid: 7, kill: () => { matou = true; } }, { platform: 'linux' });

  assert.equal(ok, true);
  assert.equal(matou, true);
});

test('killTree não quebra quando o processo já morreu', () => {
  const morto = { pid: 7, kill: () => { throw new Error('ESRCH'); } };
  assert.equal(killTree(morto, { platform: 'linux' }), false);
  assert.equal(killTree(null), false);
  assert.equal(killTree({ pid: undefined }), false);
});

test('dockerRemove remove o container pelo nome', () => {
  const chamadas = [];
  const ok = dockerRemove('mp-transcribe-1', { spawnFn: fakeSpawn(chamadas) });

  assert.equal(ok, true);
  assert.deepEqual(chamadas[0].args, ['rm', '-f', 'mp-transcribe-1']);
});

test('dockerRemove sem nome não chama nada', () => {
  const chamadas = [];
  assert.equal(dockerRemove('', { spawnFn: fakeSpawn(chamadas) }), false);
  assert.equal(chamadas.length, 0);
});
