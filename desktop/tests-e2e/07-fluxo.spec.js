'use strict';

/**
 * O fluxo depois da transcrição, montado por quem usa o app — e as duas
 * opções novas de Configurações: marcar quem fala e gravar pelo OBS.
 *
 * O que se afirma aqui é o que só aparece com a janela aberta: a etapa da
 * análise não pode ser apagada (o Kanban e o PDF saem dela), a ordem das
 * etapas é a ordem em que rodam, e uma etapa que grava arquivo sem dizer onde
 * gravar tem que ser recusada antes de chegar ao modelo.
 */

const { test, expect, waitForHome } = require('./fixtures');

const PROMPT_VALIDO = 'Leia {{TRANSCRICAO}} e escreva um resumo curto em {{SAIDA}}.';

async function abrirFluxo(page) {
  await page.locator('#nav-settings').click();
  const lista = page.locator('#flow-list');
  await expect(lista.locator('.flow-step')).not.toHaveCount(0);
  return lista;
}

async function criarEtapa(page, { nome, prompt = PROMPT_VALIDO, arquivo = 'resumo.md' }) {
  await page.locator('#flow-add').click();
  const modal = page.locator('#modal-step');
  await expect(modal).toBeVisible();
  await modal.locator('#mst-name').fill(nome);
  await modal.locator('#mst-file').fill(arquivo);
  await modal.locator('#mst-prompt').fill(prompt);
  await modal.locator('button[type="submit"]').click();
  return modal;
}

test.describe('fluxo depois da transcrição', () => {
  test('a análise vem embutida, numerada e sem botão de excluir', async ({ page, errors }) => {
    await waitForHome(page);
    const lista = await abrirFluxo(page);

    const primeira = lista.locator('.flow-step').first();
    await expect(primeira.locator('.flow-name')).toHaveText('Análise da reunião');
    await expect(primeira.locator('.flow-order')).toHaveText('1');
    // A etapa embutida abre o editor de prompt, não o de etapa.
    await expect(primeira.locator('button.btn')).toHaveText('Ver prompt');
    await primeira.locator('button.btn').click();
    await expect(page.locator('#modal-prompt')).toBeVisible();
    await page.locator('#mpr-cancel').click();

    expect(errors).toEqual([]);
  });

  test('cria uma etapa própria e ela entra no fim do fluxo', async ({ page, errors }) => {
    await waitForHome(page);
    const lista = await abrirFluxo(page);

    await criarEtapa(page, { nome: 'Resumo para o cliente' });
    await expect(page.locator('#modal-step')).toBeHidden();
    await expect(page.locator('#toast')).toContainText('Etapa salva');

    const etapas = lista.locator('.flow-step');
    await expect(etapas).toHaveCount(2);
    await expect(etapas.nth(1).locator('.flow-name')).toHaveText('Resumo para o cliente');
    await expect(etapas.nth(1).locator('.flow-order')).toHaveText('2');
    await expect(etapas.nth(1).locator('.flow-meta')).toContainText('grava resumo.md');
    await expect(page.locator('#flow-status')).toContainText('1 etapa');

    expect(errors).toEqual([]);
  });

  test('recusa a etapa que grava arquivo sem dizer onde', async ({ page }) => {
    await waitForHome(page);
    await abrirFluxo(page);

    const modal = await criarEtapa(page, {
      nome: 'Sem destino',
      prompt: 'Resuma a reunião em meia página.',
    });
    // O modal continua aberto com o motivo: o prompt iria ao modelo sem dizer
    // onde gravar, e o arquivo nasceria onde o modelo decidisse.
    await expect(modal).toBeVisible();
    await expect(page.locator('#toast')).toContainText('{{SAIDA}}');
    await modal.locator('#mst-cancel').click();
  });

  test('recusa a etapa sem nome', async ({ page }) => {
    await waitForHome(page);
    await abrirFluxo(page);

    const modal = await criarEtapa(page, { nome: '   ' });
    await expect(modal).toBeVisible();
    await expect(page.locator('#toast')).toContainText('nome');
    await modal.locator('#mst-cancel').click();
  });

  test('a ordem das etapas muda pelas setas e a análise não sobe além da primeira', async ({ page, errors }) => {
    await waitForHome(page);
    const lista = await abrirFluxo(page);

    await criarEtapa(page, { nome: 'Primeira minha', arquivo: 'a.md' });
    await criarEtapa(page, { nome: 'Segunda minha', arquivo: 'b.md' });
    const etapas = lista.locator('.flow-step');
    await expect(etapas).toHaveCount(3);

    // A seta de subir da primeira etapa está desabilitada — não há para onde.
    await expect(etapas.nth(0).locator('.flow-move').first()).toBeDisabled();
    // E a de descer da última também.
    await expect(etapas.nth(2).locator('.flow-move').nth(1)).toBeDisabled();

    // Sobe a última: ela passa a rodar antes da outra.
    await etapas.nth(2).locator('.flow-move').first().click();
    await expect(etapas.nth(1).locator('.flow-name')).toHaveText('Segunda minha');
    await expect(etapas.nth(2).locator('.flow-name')).toHaveText('Primeira minha');
    await expect(etapas.nth(1).locator('.flow-order')).toHaveText('2');

    expect(errors).toEqual([]);
  });

  test('desligar a etapa a deixa na lista, apagada', async ({ page, errors }) => {
    await waitForHome(page);
    const lista = await abrirFluxo(page);
    await criarEtapa(page, { nome: 'Desligável' });

    const etapa = lista.locator('.flow-step').nth(1);
    await etapa.locator('input.switch').uncheck();
    await expect(etapa).toHaveClass(/is-off/);
    // Continua na lista: desligar não é apagar.
    await expect(etapa.locator('.flow-name')).toHaveText('Desligável');

    expect(errors).toEqual([]);
  });

  test('edita e depois exclui a etapa, com confirmação', async ({ page, errors }) => {
    await waitForHome(page);
    const lista = await abrirFluxo(page);
    await criarEtapa(page, { nome: 'Para editar' });

    const modal = page.locator('#modal-step');
    await lista.locator('.flow-step').nth(1).locator('button.btn').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('#mst-name')).toHaveValue('Para editar');
    await modal.locator('#mst-name').fill('Nome novo');
    await modal.locator('button[type="submit"]').click();
    await expect(lista.locator('.flow-step').nth(1).locator('.flow-name')).toHaveText('Nome novo');

    // Excluir pede confirmação, como todo apagar do app.
    await lista.locator('.flow-step').nth(1).locator('button.btn').click();
    await modal.locator('#mst-delete').click();
    await expect(page.locator('#modal-danger')).toBeVisible();
    await page.locator('#md-confirm').click();
    await expect(lista.locator('.flow-step')).toHaveCount(1);
    await expect(page.locator('#toast')).toContainText('excluída');

    expect(errors).toEqual([]);
  });

  test('etapa que não grava nada esconde o nome do arquivo', async ({ page, errors }) => {
    await waitForHome(page);
    await abrirFluxo(page);

    await page.locator('#flow-add').click();
    const modal = page.locator('#modal-step');
    await expect(modal.locator('#mst-file')).toBeVisible();
    await modal.locator('#mst-output').selectOption('nenhuma');
    await expect(modal.locator('#mst-file')).toBeHidden();
    await modal.locator('#mst-cancel').click();

    expect(errors).toEqual([]);
  });
});

test.describe('configurações novas', () => {
  test('marcar quem fala aparece e guarda a escolha', async ({ page, errors }) => {
    await waitForHome(page);
    await page.locator('#nav-settings').click();

    const toggle = page.locator('#set-diarize');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    // Sai da tela e volta: a escolha veio do disco, não da memória da página.
    await page.locator('#nav-home').click();
    await page.locator('#nav-settings').click();
    await expect(page.locator('#set-diarize')).not.toBeChecked();

    expect(errors).toEqual([]);
  });

  test('a seção do OBS só mostra os campos quando está ligada', async ({ page, errors }) => {
    await waitForHome(page);
    await page.locator('#nav-settings').click();

    const ligar = page.locator('#set-obs-enabled');
    await expect(ligar).toBeVisible();
    await expect(ligar).not.toBeChecked();
    await expect(page.locator('#set-obs-conn')).toBeHidden();

    await ligar.check();
    await expect(page.locator('#set-obs-conn')).toBeVisible();
    await expect(page.locator('#set-obs-port')).toHaveValue('4455');
    // Sem OBS no ar, a tela diz o que fazer em vez de ficar calada.
    await expect(page.locator('#set-obs-desc')).toContainText('WebSocket');

    expect(errors).toEqual([]);
  });

  test('o modelo padrão é o mais fiel, não o mais rápido', async ({ page, errors }) => {
    await waitForHome(page);
    await page.locator('#nav-settings').click();

    const opcoes = page.locator('#set-model option');
    await expect(opcoes).not.toHaveCount(0);
    // O primeiro da lista é o que o app usa quando ninguém escolhe.
    await expect(opcoes.first()).toContainText('large-v3');
    await expect(opcoes.first()).not.toContainText('turbo');

    expect(errors).toEqual([]);
  });
});
