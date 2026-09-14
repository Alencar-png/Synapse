'use strict';

/**
 * Testes de ponta a ponta do Synapse: o Electron de verdade, guiado pelo
 * Playwright. Cada teste abre o app num workspace temporário (ver
 * tests-e2e/fixtures.js), então eles não compartilham estado — mas o app é
 * pesado para abrir muitas vezes ao mesmo tempo, por isso um worker só.
 *
 *   npm run test:e2e             # tudo
 *   npm run test:e2e -- --headed # vendo a janela
 *   npm run test:e2e -- -g chat  # só um cenário
 */

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests-e2e',
  testMatch: /.*\.spec\.js/,
  globalSetup: require.resolve('./tests-e2e/global-setup.js'),
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
