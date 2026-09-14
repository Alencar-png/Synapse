'use strict';

/**
 * O Kanban do projeto: criar uma tarefa numa coluna, editar, ver o contador
 * acompanhar e excluir.
 */

const {
  test, expect, waitForHome, createProject, openProjectByName,
} = require('./fixtures');

async function openKanban(page, name) {
  await createProject(page, name);
  await openProjectByName(page, name);
  await page.locator('#project-tabs .tab[data-tab="kanban"]').click();
  await expect(page.locator('#project-view[data-tab="kanban"]')).toBeVisible();
  await expect(page.locator('#kanban .kcol')).toHaveCount(3);
}

async function confirmIfAsked(page) {
  const danger = page.locator('#modal-danger');
  try {
    await danger.waitFor({ state: 'visible', timeout: 1500 });
    await danger.locator('#md-confirm').click();
  } catch {
    // Excluiu direto, sem confirmação.
  }
}

test.describe('kanban', () => {
  test('as três colunas nascem vazias e com contador zero', async ({ page, uniqueName }) => {
    await waitForHome(page);
    await openKanban(page, uniqueName);
    for (const status of ['backlog', 'doing', 'done']) {
      const col = page.locator(`#kanban .kcol[data-status="${status}"]`);
      await expect(col).toBeVisible();
      await expect(col.locator('.kcard')).toHaveCount(0);
      await expect(col.locator('.kcount')).toHaveText('0');
    }
  });

  test('cria uma tarefa na coluna "fazendo" e ela aparece lá', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await openKanban(page, uniqueName);

    const doing = page.locator('#kanban .kcol[data-status="doing"]');
    await doing.locator('.kadd').click();
    const modal = page.locator('#modal-task');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mt-status')).toHaveValue('doing');

    await modal.locator('#mt-name').fill('Revisar módulo de usuários');
    await modal.locator('#mt-desc').fill('Conferir as pendências do módulo.');
    await modal.locator('#mt-assignee').fill('Guilherme');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    const card = doing.locator('.kcard', { hasText: 'Revisar módulo de usuários' });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.kcard-who')).toContainText('Guilherme');
    await expect(doing.locator('.kcount')).toHaveText('1');

    // A tela inicial conta a tarefa aberta no bloco do projeto.
    await page.locator('#nav-home').click();
    await expect(page.locator('#home-projects .tile', { hasText: uniqueName })).toContainText('1 tarefa(s) aberta(s)');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('recusa uma tarefa sem título', async ({ page, uniqueName }) => {
    await waitForHome(page);
    await openKanban(page, uniqueName);
    await page.locator('#kanban .kcol[data-status="backlog"] .kadd').click();
    const modal = page.locator('#modal-task');
    await modal.locator('#mt-name').fill('  ');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mt-error')).not.toHaveText('');
    await modal.locator('#mt-cancel').click();
    await expect(modal).toBeHidden();
  });

  test('edita a tarefa, muda a coluna pelo modal e depois exclui', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await openKanban(page, uniqueName);

    await page.locator('#kanban .kcol[data-status="backlog"] .kadd').click();
    const modal = page.locator('#modal-task');
    await modal.locator('#mt-name').fill('Tarefa para editar');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    const card = page.locator('#kanban .kcard', { hasText: 'Tarefa para editar' });
    await card.click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mt-name')).toHaveValue('Tarefa para editar');
    await modal.locator('#mt-name').fill('Tarefa editada');
    await modal.locator('#mt-status').selectOption('done');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toBeHidden();

    const done = page.locator('#kanban .kcol[data-status="done"]');
    await expect(done.locator('.kcard', { hasText: 'Tarefa editada' })).toHaveCount(1);
    await expect(page.locator('#kanban .kcol[data-status="backlog"] .kcard')).toHaveCount(0);

    await done.locator('.kcard', { hasText: 'Tarefa editada' }).click();
    await modal.locator('#mt-delete').click();
    await confirmIfAsked(page);
    await expect(modal).toBeHidden();
    await expect(page.locator('#kanban .kcard')).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
