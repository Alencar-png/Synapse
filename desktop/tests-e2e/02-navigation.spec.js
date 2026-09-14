'use strict';

/**
 * Cada tela do app abre, mostra o que promete e não deixa erro para trás.
 */

const { test, expect, waitForHome, expectNoUiErrorToast } = require('./fixtures');

const VIEWS = [
  { nav: 'nav-projects-all', view: 'projects', crumb: 'Projetos / Todos os projetos', probe: '#projects-new' },
  { nav: 'nav-library', view: 'library', crumb: 'Biblioteca / Todas as reuniões', probe: '#lib-search' },
  { nav: 'nav-settings', view: 'settings', crumb: 'Sistema / Configurações', probe: '#set-engine' },
  { nav: 'nav-home', view: 'home', crumb: 'Início', probe: '#home-record' },
];

test.describe('navegação', () => {
  test('percorre todas as telas pela barra lateral', async ({ page, errors }) => {
    await waitForHome(page);
    for (const v of VIEWS) {
      await page.locator(`#${v.nav}`).click();
      await expect(page.locator(`#app[data-view="${v.view}"]`)).toBeVisible();
      await expect(page.locator('#crumb')).toHaveText(v.crumb);
      await expect(page.locator(v.probe)).toBeVisible();
      await expect(page.locator(`#${v.nav}`)).toHaveClass(/is-active/);
    }
    await expectNoUiErrorToast(page);
    expect(errors).toEqual([]);
  });

  test('a biblioteca vazia diz que está vazia', async ({ page }) => {
    await waitForHome(page);
    await page.locator('#nav-library').click();
    await expect(page.locator('#lib-empty')).toBeVisible();
    await expect(page.locator('#lib-empty')).toHaveText('Nenhuma reunião encontrada.');
  });

  test('a lista de projetos vazia oferece criar o primeiro', async ({ page }) => {
    await waitForHome(page);
    await page.locator('#nav-projects-all').click();
    await expect(page.locator('#projects-empty')).toBeVisible();
    await expect(page.locator('#projects-grid .proj-card')).toHaveCount(0);
  });

  test('Configurações mostra os motores e a voz sem o Chatterbox', async ({ page, errors }) => {
    await waitForHome(page);
    await page.locator('#nav-settings').click();

    // Motor de transcrição: GPU e Docker, e um deles marcado.
    const engines = page.locator('#set-engine button[data-engine]');
    await expect(engines).toHaveCount(2);
    await expect(page.locator('#set-engine button.is-active')).toHaveCount(1);

    // Voz do assistente: só Edge e Sistema. O Chatterbox saiu do app.
    const voices = page.locator('#set-tts-engine button[data-engine]');
    await expect(voices).toHaveCount(2);
    await expect(voices.nth(0)).toHaveAttribute('data-engine', 'neural');
    await expect(voices.nth(1)).toHaveAttribute('data-engine', 'system');
    await expect(page.locator('#set-tts-engine-desc')).not.toHaveText('—');

    // Troca o motor de voz e volta: cada clique redesenha sem erro.
    await voices.nth(0).click();
    await expect(voices.nth(0)).toHaveClass(/is-active/);
    await expect(page.locator('#set-tts-voice option')).not.toHaveCount(0);
    await voices.nth(1).click();
    await expect(voices.nth(1)).toHaveClass(/is-active/);

    // A pasta de saída é a do teste, não a de quem roda a suíte.
    await expect(page.locator('#set-outdir')).toContainText('synapse-e2e-');
    expect(errors).toEqual([]);
  });
});
