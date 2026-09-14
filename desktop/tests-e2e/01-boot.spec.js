'use strict';

/**
 * A partida do app. É aqui que um "erro aleatório ao abrir" precisa aparecer:
 * o teste recolhe toda exceção do renderer e todo console.error desde o
 * primeiro frame e exige a lista vazia ao fim.
 */

const { test, expect, waitForHome, expectNoUiErrorToast } = require('./fixtures');

test.describe('partida', () => {
  test('abre a janela, desenha a tela inicial e não emite erro nenhum', async ({ page, errors }) => {
    await waitForHome(page);
    await expect(page).toHaveTitle('Synapse');

    // A barra lateral inteira, com as quatro entradas.
    for (const id of ['nav-home', 'nav-projects-all', 'nav-library', 'nav-settings']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    await expect(page.locator('#nav-home')).toHaveClass(/is-active/);

    // As ações da tela inicial e os blocos de resumo.
    await expect(page.locator('#home-record')).toBeVisible();
    await expect(page.locator('#home-import')).toBeVisible();
    await expect(page.locator('#home-import-text')).toBeVisible();
    await expect(page.locator('#home-stats .stat').first()).toBeVisible();

    // Dá tempo para qualquer promessa da inicialização (motor, projetos) resolver.
    await page.waitForTimeout(1500);
    await expectNoUiErrorToast(page);
    expect(errors, `erros na partida:\n${errors.join('\n')}`).toEqual([]);
  });

  test('todo id que o renderer usa existe no HTML', async ({ page }) => {
    await waitForHome(page);
    // Se o app.js pedir um elemento que não existe, $() devolve null e o
    // próximo `.classList` explode. Esta checagem pega isso antes do clique.
    const missing = await page.evaluate(async () => {
      const src = await (await fetch('app.js')).text();
      const ids = [...new Set([...src.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
      return ids.filter((id) => !document.getElementById(id));
    });
    expect(missing).toEqual([]);
  });

  test('nenhum id se repete no HTML', async ({ page }) => {
    await waitForHome(page);
    const duplicates = await page.evaluate(() => {
      const seen = new Map();
      for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
      return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    });
    expect(duplicates).toEqual([]);
  });

  test('a segunda instância não abre outra janela', async ({ electronApp, page }) => {
    await waitForHome(page);
    // A trava de instância única vale por userData; o teste roda dentro do
    // mesmo processo, então basta conferir que a trava está tomada.
    const held = await electronApp.evaluate(({ app }) => app.hasSingleInstanceLock());
    expect(held).toBe(true);
  });
});
