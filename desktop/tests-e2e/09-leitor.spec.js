'use strict';

/**
 * A leitura da transcrição no painel da reunião.
 *
 * Este teste nasce de um bug que passou despercebido justamente por só existir
 * com a janela aberta: o filtro que descarta os metadados do arquivo casava
 * "negrito com dois-pontos", e a linha de fala com falante marcado
 * (`**[00:12] Você:** ...`) tem exatamente essa forma. Resultado: em toda
 * transcrição com falante — que é o padrão do app — o leitor descartava as
 * falas uma a uma, terminava sem nada para mostrar e caía no despejo do
 * markdown cru.
 *
 * Nenhum teste de unidade alcança isso: o filtro vive dentro do renderer e o
 * veredito é o que aparece na tela. Por isso a afirmação aqui é sobre os
 * elementos desenhados, não sobre o texto de saída de uma função.
 */

const fs = require('node:fs');
const path = require('node:path');

const { test, expect, waitForHome } = require('./fixtures');

const NOME = 'Alinhamento com falantes';

// O formato que o pipeline grava quando a gravação separou os dois lados.
const COM_FALANTE = `# ${NOME}

**Gravado em:** 16/09/2026 às 14:30
**Duracao:** 00:02:00
**Idioma:** pt
**Falantes:** separados pelo canal de áudio

---

**[00:00] Você:** Bom dia, vamos fechar o escopo.
**[00:12] Participantes:** Fechado. Ajusto o e-mail até sexta.
**[00:31] Você:** Combinado então.
`;

function semear(outputDir) {
  const dir = path.join(outputDir, NOME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${NOME}.md`), COM_FALANTE, 'utf-8');
  fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({
    name: NOME,
    recorded_at_local: '2026-09-16 14:30:00',
    duration_seconds: 120,
    segments: 3,
    language: 'pt',
  }), 'utf-8');
}

test.describe('leitor da transcrição', () => {
  test('mostra as falas com horário e falante, e não o markdown cru', async ({
    page, workspace, errors,
  }) => {
    semear(workspace.outputDir);
    await waitForHome(page);

    await page.locator('#nav-library').click();
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'library');

    // A reunião nasceu no disco depois de o app já ter lido a biblioteca.
    // Digitar na busca é o que faz a tela consultar de novo — e é também o
    // caminho que uma pessoa usaria para achá-la.
    await page.locator('#lib-search').fill('Alinhamento');
    const cartao = page.locator('#lib-list .tile', { hasText: NOME });
    await expect(cartao).toHaveCount(1);
    await cartao.click();

    const leitor = page.locator('#drawer-text');
    await expect(leitor).toBeVisible();

    // Uma linha desenhada por fala: nem as três viraram uma só (o despejo do
    // markdown cru), nem os metadados entraram como se fossem conversa.
    await expect(leitor.locator('.reader-line')).toHaveCount(3);
    await expect(leitor.locator('.reader-time').first()).toHaveText('00:00');
    await expect(leitor.locator('.reader-who').first()).toHaveText('Você');
    await expect(leitor.locator('.reader-who').nth(1)).toHaveText('Participantes');

    // O texto é o da conversa, sem os asteriscos do arquivo.
    await expect(leitor).toContainText('Bom dia, vamos fechar o escopo.');
    await expect(leitor).not.toContainText('**');
    // E o cabeçalho do arquivo não vira linha de fala: já está no topo do painel.
    await expect(leitor).not.toContainText('Idioma:');

    expect(errors).toEqual([]);
  });
});
