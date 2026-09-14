'use strict';

/**
 * Antes da suíte: compila o `claude` de mentira (tests-e2e/fake-claude).
 *
 * O csc do .NET Framework vem com o Windows; é a forma mais barata de ter um
 * .exe que o app consiga spawnar sem shell. Se ele não existir, a suíte roda
 * mesmo assim e os testes que precisam do chat são pulados com o motivo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const BUILD_DIR = path.join(__dirname, '.build');
const FAKE_CLAUDE = path.join(BUILD_DIR, 'claude.exe');
const SOURCE = path.join(__dirname, 'fake-claude', 'FakeClaude.cs');

function isUpToDate() {
  try {
    return fs.statSync(FAKE_CLAUDE).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
  } catch {
    return false;
  }
}

module.exports = async function globalSetup() {
  if (process.platform !== 'win32') return;
  if (isUpToDate()) return;
  const csc = CSC_CANDIDATES.find((c) => fs.existsSync(c));
  if (!csc) {
    process.stderr.write('[e2e] csc.exe não encontrado: os testes do chat serão pulados.\n');
    return;
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const r = spawnSync(csc, ['/nologo', '/optimize', `/out:${FAKE_CLAUDE}`, SOURCE], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`[e2e] falha ao compilar o claude de mentira:\n${r.stdout}\n${r.stderr}`);
  }
};

module.exports.FAKE_CLAUDE = FAKE_CLAUDE;
