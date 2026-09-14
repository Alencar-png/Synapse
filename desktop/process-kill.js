'use strict';

/**
 * Encerrar processo filho sem derrubar o app junto.
 *
 * Um `spawn` é um EventEmitter: se o binário não existe (ENOENT), se a
 * política da máquina bloqueia o `taskkill`, se o Docker foi desinstalado
 * depois que o job começou — o Node emite `'error'`, e um `'error'` sem
 * ouvinte vira exceção não tratada que mata o processo principal do Electron.
 *
 * O detalhe cruel é *onde* isso acontece: cancelar um trabalho e fechar o app
 * são justamente os momentos em que essas chamadas são feitas. O app morreria
 * ao ser fechado, ou ao cancelar uma transcrição numa máquina sem Docker.
 *
 * As funções aqui nunca lançam e nunca rejeitam. Matar um processo é trabalho
 * de limpeza: se não deu, o que se pode fazer é registrar, não quebrar.
 */

const { spawn } = require('node:child_process');

/** Um spawn que engole o erro de nascimento em vez de deixá-lo escapar. */
function spawnDetached(command, args, spawnFn = spawn) {
  try {
    const child = spawnFn(command, args, { windowsHide: true });
    // O ouvinte existe para o evento ter dono. Sem ele, o Node trata o
    // 'error' como exceção não tratada e o app inteiro cai.
    if (child && typeof child.on === 'function') child.on('error', () => {});
    return child;
  } catch {
    // spawn síncrono também pode lançar (argumento inválido, por exemplo).
    return null;
  }
}

/**
 * Derruba o processo e os filhos dele.
 *
 * No Windows um `child.kill()` mata só o pai: o Python continuaria com o
 * whisper-cli pendurado na GPU, e o `claude` com o comando que estava
 * rodando. `taskkill /t` leva a árvore toda. Fora do Windows, o sinal já
 * chega ao grupo.
 */
function killTree(child, { platform = process.platform, spawnFn = spawn } = {}) {
  if (!child || !child.pid) return false;
  if (platform === 'win32') {
    return Boolean(spawnDetached('taskkill', ['/pid', String(child.pid), '/t', '/f'], spawnFn));
  }
  try {
    child.kill();
    return true;
  } catch {
    return false;   // já morreu entre a checagem e o sinal
  }
}

/**
 * Remove um container pelo nome.
 *
 * Matar o cliente `docker run` não para o container: ele fica transcrevendo
 * sozinho, segurando a pasta de saída. Quem encerra de verdade é o `rm -f`.
 */
function dockerRemove(containerName, { spawnFn = spawn } = {}) {
  if (!containerName) return false;
  return Boolean(spawnDetached('docker', ['rm', '-f', containerName], spawnFn));
}

module.exports = { dockerRemove, killTree, spawnDetached };
