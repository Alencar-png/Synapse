'use strict';

/**
 * O ciclo de vida de um projeto: criar, abrir cada aba, editar e excluir.
 * Criar um projeto era um dos gatilhos de erro silencioso (o formulário
 * dividia o id com o modal de prompt), então cada passo confere `errors`.
 */

const {
  test, expect, waitForHome, createProject, openProjectByName, expectNoUiErrorToast,
} = require('./fixtures');

const TABS = ['overview', 'kanban', 'meetings', 'graph', 'chat'];

test.describe('projetos', () => {
  test('cria um projeto e ele aparece na lista e na tela inicial', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await createProject(page, uniqueName, { context: 'Contexto de teste.' });

    await page.locator('#nav-projects-all').click();
    await expect(page.locator('#projects-grid .proj-card', { hasText: uniqueName })).toHaveCount(1);
    await expect(page.locator('#projects-empty')).toBeHidden();

    await page.locator('#nav-home').click();
    await expect(page.locator('#home-projects', { hasText: uniqueName })).toBeVisible();

    await expectNoUiErrorToast(page);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('recusa um projeto sem nome e mostra o motivo no modal', async ({ page }) => {
    await waitForHome(page);
    await page.locator('#nav-new-project').click();
    const modal = page.locator('#modal-project');
    await modal.locator('#mp-name').fill('   ');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mp-error')).not.toHaveText('');
    await modal.locator('#mp-cancel').click();
    await expect(modal).toBeHidden();
  });

  test('abre o projeto e passa por todas as abas', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await createProject(page, uniqueName);
    await openProjectByName(page, uniqueName);

    await expect(page.locator('#top-record')).toBeVisible();
    for (const tab of TABS) {
      await page.locator(`#project-tabs .tab[data-tab="${tab}"]`).click();
      await expect(page.locator(`#project-view[data-tab="${tab}"]`)).toBeVisible();
      await expect(page.locator(`#project-tabs .tab[data-tab="${tab}"]`)).toHaveClass(/is-active/);
      await expect(page.locator(`.ptab-${tab}`)).toBeVisible();
      if (tab === 'kanban') await expect(page.locator('#kanban .kcol')).toHaveCount(3);
      if (tab === 'graph') await expect(page.locator('#graph-canvas')).toBeVisible();
      if (tab === 'chat') await expect(page.locator('#chat-input')).toBeVisible();
    }

    await expectNoUiErrorToast(page);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('edita o nome e o contexto pelo botão da visão geral', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await createProject(page, uniqueName);
    await openProjectByName(page, uniqueName);

    await page.locator('#overview-edit').click();
    const modal = page.locator('#modal-project');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mp-title')).toHaveText('Editar projeto');
    await expect(modal.locator('#mp-name')).toHaveValue(uniqueName);

    const renamed = `${uniqueName} renomeado`;
    await modal.locator('#mp-name').fill(renamed);
    await modal.locator('#mp-context').fill('Novo contexto.');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    await expect(page.locator('#project-name')).toHaveText(renamed);
    await expect(page.locator('#overview-context')).toContainText('Novo contexto.');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('exclui o projeto com confirmação e ele some da lista', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await createProject(page, uniqueName);
    await openProjectByName(page, uniqueName);

    await page.locator('#overview-edit').click();
    await page.locator('#modal-project #mp-delete').click();
    const danger = page.locator('#modal-danger');
    await expect(danger).toBeVisible();
    await danger.locator('#md-confirm').click();
    await expect(danger).toBeHidden();

    // Excluído, o app volta para a tela inicial; a lista não tem mais o projeto.
    await expect(page.locator('#app[data-view="home"]')).toBeVisible();
    await expect(page.locator('#home-projects .tile', { hasText: uniqueName })).toHaveCount(0);
    await page.locator('#nav-projects-all').click();
    await expect(page.locator('#projects-grid .proj-card', { hasText: uniqueName })).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
