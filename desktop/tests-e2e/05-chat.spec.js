'use strict';

/**
 * O chat do projeto, de ponta a ponta, contra o claude de mentira: a mensagem
 * vai, a resposta volta, a ferramenta em uso aparece, o erro do processo vira
 * mensagem legível, e o histórico sobrevive a trocar de aba.
 */

const {
  test, expect, waitForHome, createProject, openProjectByName, hasFakeClaude,
} = require('./fixtures');

test.describe('chat do projeto', () => {
  test.skip(() => !hasFakeClaude(), 'sem csc.exe para compilar o claude de mentira');

  async function openChat(page, name) {
    await createProject(page, name);
    await openProjectByName(page, name);
    await page.locator('#project-tabs .tab[data-tab="chat"]').click();
    await expect(page.locator('#project-view[data-tab="chat"]')).toBeVisible();
    await expect(page.locator('#chat-thread .chat-empty')).toBeVisible();
    await expect(page.locator('#chat-workdir')).not.toHaveText('—');
  }

  async function send(page, text) {
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-send').click();
  }

  test('envia uma pergunta e recebe a resposta', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await openChat(page, uniqueName);

    await send(page, 'Olá, tudo bem?');
    await expect(page.locator('#chat-thread .msg-user .bubble')).toContainText('Olá, tudo bem?');
    const answer = page.locator('#chat-thread .msg-ai').last();
    await expect(answer).toContainText('Resposta de teste: Olá, tudo bem?');
    await expect(answer).not.toHaveClass(/msg-error/);

    // Terminada a rodada, a barra volta a aceitar mensagens.
    await expect(page.locator('#chat-input')).toBeEnabled();
    await expect(page.locator('#chat-send')).toBeVisible();
    await expect(page.locator('#chat-stop')).toBeHidden();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('mostra a ferramenta que o assistente usou', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await openChat(page, uniqueName);
    await send(page, 'FERRAMENTA: leia o README');
    const answer = page.locator('#chat-thread .msg-ai').last();
    await expect(answer).toContainText('Resposta de teste');
    await expect(answer.locator('.msg-tool').first()).toContainText('lendo README.md');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('falha do processo vira mensagem de erro, não tela travada', async ({ page, errors, uniqueName }) => {
    await waitForHome(page);
    await openChat(page, uniqueName);
    await send(page, 'FALHE agora');
    const answer = page.locator('#chat-thread .msg-ai').last();
    await expect(answer).toHaveClass(/msg-error/);
    await expect(answer).toContainText('Não deu para responder');
    await expect(answer).toContainText('erro simulado do Claude');
    await expect(page.locator('#chat-input')).toBeEnabled();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('o histórico fica guardado ao trocar de aba e voltar', async ({ page, uniqueName }) => {
    await waitForHome(page);
    await openChat(page, uniqueName);
    await send(page, 'primeira pergunta');
    await expect(page.locator('#chat-thread .msg-ai').last()).toContainText('primeira pergunta');

    await page.locator('#project-tabs .tab[data-tab="overview"]').click();
    await page.locator('#project-tabs .tab[data-tab="chat"]').click();
    await expect(page.locator('#chat-thread .msg-user')).toHaveCount(1);
    await expect(page.locator('#chat-thread .msg-ai')).toHaveCount(1);
  });

  test('Nova conversa pede confirmação e limpa o histórico', async ({ page, uniqueName }) => {
    await waitForHome(page);
    await openChat(page, uniqueName);
    await send(page, 'para apagar');
    await expect(page.locator('#chat-thread .msg-ai').last()).toContainText('para apagar');

    await page.locator('#chat-new').click();
    const danger = page.locator('#modal-danger');
    await expect(danger).toBeVisible();
    await danger.locator('#md-cancel').click();
    await expect(page.locator('#chat-thread .msg-user')).toHaveCount(1);

    await page.locator('#chat-new').click();
    await danger.locator('#md-confirm').click();
    await expect(page.locator('#chat-thread .chat-empty')).toBeVisible();
    await expect(page.locator('#chat-thread .msg-user')).toHaveCount(0);
  });

  test('o modo autônomo só liga depois da confirmação', async ({ page, uniqueName }) => {
    await waitForHome(page);
    await openChat(page, uniqueName);
    const toggle = page.locator('#chat-bypass');
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    const danger = page.locator('#modal-danger');
    await expect(danger).toBeVisible();
    await danger.locator('#md-cancel').click();
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await danger.locator('#md-confirm').click();
    await expect(toggle).toBeChecked();
    await expect(page.locator('#chat-box')).toHaveClass(/is-bypass/);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#chat-box')).not.toHaveClass(/is-bypass/);
  });
});
