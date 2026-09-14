'use strict';

/**
 * A fixture de todos os testes de ponta a ponta: o Synapse de verdade, aberto
 * pelo Playwright, mas num workspace descartável.
 *
 * - `SYNAPSE_USER_DATA` aponta para uma pasta temporária: settings.json e a
 *   trava de instância única ficam ali, longe dos dados de quem usa a máquina.
 * - O settings.json é semeado com uma pasta de saída também temporária, para
 *   o synapse.db e as reuniões nascerem e morrerem com o teste.
 * - `CLAUDE_BIN` aponta para o claude de mentira (global-setup), então o chat
 *   funciona sem rede, sem login e sem custo.
 * - Toda exceção do renderer e todo `console.error` são recolhidos em
 *   `errors`; o teste de partida exige a lista vazia — é assim que um "erro
 *   aleatório ao abrir" vira um teste vermelho com a mensagem exata.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test: base, expect, _electron: electron } = require('@playwright/test');
const { FAKE_CLAUDE } = require('./global-setup');

const DESKTOP_DIR = path.resolve(__dirname, '..');

// Ruído do Chromium/Electron que não é problema do app.
const IGNORED_CONSOLE = [
  /Autofill\.enable/,
  /Electron Security Warning/,
  /ExperimentalWarning/,
];

function seedSettings(userData, outputDir) {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const settings = {
    outputDir,
    engine: 'native',
    language: 'pt',
    formats: ['md', 'txt'],
    steps: { kanban: false, documento: false },
    // A voz do sistema não chama processo nenhum: o teste não depende de rede.
    tts: { engine: 'system' },
  };
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}

const test = base.extend({
  // Pastas do teste: uma para o userData do Electron, outra para o workspace.
  workspace: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-e2e-'));
    const userData = path.join(root, 'user-data');
    const outputDir = path.join(root, 'workspace');
    seedSettings(userData, outputDir);
    await use({ root, userData, outputDir });
    fs.rmSync(root, { recursive: true, force: true });
  },

  electronApp: async ({ workspace }, use) => {
    const env = {
      ...process.env,
      SYNAPSE_USER_DATA: workspace.userData,
      CLAUDE_BIN: FAKE_CLAUDE,
    };
    // Nunca deixa o teste cair na conta real de quem roda a suíte.
    delete env.CLAUDE_CONFIG_DIR;
    const app = await electron.launch({ args: ['.'], cwd: DESKTOP_DIR, env });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },

  errors: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      errors.push(`console.error: ${text}`);
    });
    await use(errors);
  },

  // Nome único por teste, para o texto na tela ser inequívoco.
  uniqueName: async ({}, use) => {
    await use(`Projeto E2E ${Date.now().toString(36)}`);
  },
});

/** O app está de pé quando a tela inicial já foi desenhada. */
async function waitForHome(page) {
  await expect(page.locator('#app[data-view="home"]')).toBeVisible();
  await expect(page.locator('#crumb')).toHaveText('Início');
}

/** Cria um projeto pelo modal e espera a tela dele abrir. */
async function createProject(page, name, { context = '' } = {}) {
  await page.locator('#nav-new-project').click();
  const modal = page.locator('#modal-project');
  await expect(modal).toBeVisible();
  await modal.locator('#mp-name').fill(name);
  if (context) await modal.locator('#mp-context').fill(context);
  await modal.locator('button[type="submit"]').click();
  await expect(modal).toBeHidden();
}

/** Abre um projeto pelo nome, a partir da lista de projetos. */
async function openProjectByName(page, name) {
  await page.locator('#nav-projects-all').click();
  await expect(page.locator('#app[data-view="projects"]')).toBeVisible();
  await page.locator('#projects-grid .proj-card', { hasText: name }).first().click();
  await expect(page.locator('#app[data-view="project"]')).toBeVisible();
  await expect(page.locator('#project-name')).toHaveText(name);
}

/** Um toast de erro da interface é sempre falha de teste. */
function expectNoUiErrorToast(page) {
  return expect(page.locator('#toast', { hasText: 'Erro na interface' })).toBeHidden();
}

const hasFakeClaude = () => fs.existsSync(FAKE_CLAUDE);

module.exports = {
  test, expect, waitForHome, createProject, openProjectByName, expectNoUiErrorToast, hasFakeClaude,
};
