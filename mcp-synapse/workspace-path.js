'use strict';

/**
 * Onde mora o workspace do Synapse, visto de fora do app.
 *
 * O servidor MCP roda sem Electron, então não tem `app.getPath('userData')`
 * para perguntar. Ele refaz o mesmo caminho na mão: a pasta de dados do app
 * guarda um `settings.json`, e é lá que está a pasta de saída escolhida por
 * quem usa — a que tem o `synapse.db` e as pastas de reunião.
 *
 * A ordem de busca vai do mais explícito ao mais genérico, e cada degrau
 * existe por um motivo:
 *
 *   1. `SYNAPSE_OUTPUT_DIR` — aponta direto para a pasta de saída. É como se
 *      lê um workspace que não é o desta máquina (um backup, um disco de rede)
 *      sem mexer na configuração do app.
 *   2. `SYNAPSE_USER_DATA` — a mesma variável que o app respeita, e a que os
 *      testes de ponta a ponta usam para rodar num workspace descartável.
 *   3. A pasta de dados padrão da plataforma.
 *   4. `~/Documents/Transcricoes`, o padrão de fábrica do app.
 *
 * Tudo é injetável (`env`, `platform`, `home`) porque a alternativa seria
 * testar isto mexendo nas variáveis do processo de teste.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// O nome da pasta de dados vem do `name` do package.json do app — é o que o
// Electron usa para montar o userData. Mudar um sem o outro separa o servidor
// do app sem que nada acuse.
const APP_DIR = 'meeting-processor-desktop';

const SETTINGS_FILE = 'settings.json';

/** A pasta de dados do app, do jeito que o Electron a monta em cada sistema. */
function userDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR);
}

/**
 * A `outputDir` gravada num settings.json, ou vazio.
 *
 * Arquivo ausente, JSON quebrado ou campo faltando são todos o mesmo caso para
 * quem chama — "não sei por aqui" —, e o próximo degrau da busca assume.
 */
function outputDirFrom(userData) {
  try {
    const salvo = JSON.parse(fs.readFileSync(path.join(userData, SETTINGS_FILE), 'utf-8'));
    const dir = typeof salvo.outputDir === 'string' ? salvo.outputDir.trim() : '';
    return dir;
  } catch {
    return '';
  }
}

/**
 * A pasta de saída do Synapse, e de onde a resposta veio.
 *
 * Devolver a origem junto (`from`) não é enfeite: quando o servidor lê um
 * workspace vazio, a primeira pergunta de quem depura é "vazio onde?", e a
 * resposta muda conforme o degrau que respondeu.
 */
function resolveWorkspace({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const explicito = (env.SYNAPSE_OUTPUT_DIR || '').trim();
  if (explicito) return { dir: explicito, from: 'SYNAPSE_OUTPUT_DIR' };

  const userDataEnv = (env.SYNAPSE_USER_DATA || '').trim();
  if (userDataEnv) {
    const dir = outputDirFrom(userDataEnv);
    if (dir) return { dir, from: `SYNAPSE_USER_DATA/${SETTINGS_FILE}` };
  }

  const padrao = userDataDir({ platform, env, home });
  const dir = outputDirFrom(padrao);
  if (dir) return { dir, from: `${SETTINGS_FILE} do app` };

  return { dir: path.join(home, 'Documents', 'Transcricoes'), from: 'padrão de fábrica' };
}

module.exports = { APP_DIR, outputDirFrom, resolveWorkspace, userDataDir };
