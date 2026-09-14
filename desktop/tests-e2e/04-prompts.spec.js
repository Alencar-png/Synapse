'use strict';

/**
 * O editor de prompts em Configurações. Antes, o formulário dele não tinha
 * handler (o id era do modal de projeto) e "Salvar" recarregava a página
 * inteira — o app parecia reiniciar do nada. O teste marca a janela antes
 * de salvar e confere que a marca sobreviveu.
 */

const { test, expect, waitForHome } = require('./fixtures');

async function openFirstPrompt(page) {
  await page.locator('#nav-settings').click();
  const select = page.locator('#set-prompt-kind');
  await expect(select.locator('option')).not.toHaveCount(0);
  const kind = await select.inputValue();
  await page.locator('#set-prompt-open').click();
  const modal = page.locator('#modal-prompt');
  await expect(modal).toBeVisible();
  return { modal, kind };
}

test.describe('prompts', () => {
  test('abre o prompt padrão com título, texto e ajuda de placeholders', async ({ page, errors }) => {
    await waitForHome(page);
    const { modal } = await openFirstPrompt(page);
    await expect(modal.locator('#mpr-title')).not.toHaveText('');
    await expect(modal.locator('#mpr-status')).toHaveText('padrão do app');
    await expect(modal.locator('#mpr-text')).not.toHaveValue('');
    await expect(modal.locator('#mpr-help code').first()).toBeVisible();
    await expect(modal.locator('#mpr-reset')).toBeHidden();
    await modal.locator('#mpr-cancel').click();
    await expect(modal).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('salvar sem mudar nada não recarrega a página e avisa que é igual ao padrão', async ({ page, errors }) => {
    await waitForHome(page);
    await page.evaluate(() => { window.__e2eMarker = 'vivo'; });
    const { modal } = await openFirstPrompt(page);
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#toast')).toContainText('igual ao padrão');
    expect(await page.evaluate(() => window.__e2eMarker)).toBe('vivo');
    expect(errors).toEqual([]);
  });

  test('edita, salva, reabre como personalizado e restaura o padrão', async ({ page, errors }) => {
    await waitForHome(page);
    const { modal } = await openFirstPrompt(page);
    const original = await modal.locator('#mpr-text').inputValue();
    await modal.locator('#mpr-text').fill(`${original}\n\nLinha acrescentada pelo teste.`);
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#toast')).toContainText('Prompt salvo');

    await page.locator('#set-prompt-open').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mpr-status')).toContainText('editado por você');
    await expect(modal.locator('#mpr-reset')).toBeVisible();

    await modal.locator('#mpr-reset').click();
    await expect(page.locator('#toast')).toContainText('restaurado');
    await expect(modal.locator('#mpr-status')).toHaveText('padrão do app');
    await expect(modal.locator('#mpr-text')).toHaveValue(original);
    await modal.locator('#mpr-cancel').click();
    expect(errors).toEqual([]);
  });

  test('recusa um prompt sem os placeholders obrigatórios', async ({ page }) => {
    await waitForHome(page);
    const { modal } = await openFirstPrompt(page);
    await modal.locator('#mpr-text').fill('Texto sem nenhum placeholder.');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mpr-error')).not.toHaveText('');
    await modal.locator('#mpr-cancel').click();
  });
});
