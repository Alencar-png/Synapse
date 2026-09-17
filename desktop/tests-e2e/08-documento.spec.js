'use strict';

/**
 * O documento em PDF, gerado de ponta a ponta.
 *
 * Este teste existe por causa de uma troca de motor: a impressão era feita
 * chamando o Edge ou o Chrome instalado na máquina, por caminhos fixos em
 * `C:\Program Files\...`. Isso amarrava o app ao Windows e quebrava em quem
 * não tivesse nenhum dos dois. Agora quem imprime é o próprio Electron.
 *
 * Nada disso aparece num teste de unidade: `printToPDF` só existe com o
 * Chromium de pé, e o veredito é um arquivo no disco com bytes dentro. Um PDF
 * de zero byte, ou uma promessa que resolve sem escrever nada, passaria por
 * qualquer verificação mais fraca do que abrir o arquivo e olhar.
 *
 * A análise é semeada no disco de propósito: `generateDocs` usa a que já está
 * gravada e não chama o modelo, então o que se mede aqui é a impressão, não o
 * Claude.
 */

const fs = require('node:fs');
const path = require('node:path');

const { test, expect, waitForHome } = require('./fixtures');

const NOME = 'Reunião de teste';

const TRANSCRICAO = `# ${NOME}

**Gravado em:** 16/09/2026 às 14:30
**Duracao:** 00:02:00
**Idioma:** pt

---

**[00:00] Você:** Bom dia. Vamos fechar o escopo do onboarding.
**[00:12] Participantes:** Fechado. Eu ajusto o e-mail de confirmação até sexta.
`;

const ANALISE = {
  title: NOME,
  note: '',
  overview: ['A conversa fechou o escopo do onboarding.'],
  topics: [{ title: 'Onboarding', summary: 'O escopo foi fechado nesta reunião.' }],
  decisions: [{ text: 'O escopo do onboarding está fechado.', open: false }],
  risks: ['O prazo de sexta é apertado.'],
  tasks: [{
    title: 'Ajustar o e-mail de confirmação',
    description: 'Combinado na reunião.',
    assignee: 'Participantes',
    deadline: 'sexta',
    priority: 'high',
    origin: '00:12',
  }],
  pending: ['Confirmar a data do próximo teste.'],
  generatedAt: Date.now(),
};

/** Uma reunião pronta no disco: pasta, transcrição, metadados e análise. */
function semearReuniao(outputDir) {
  const dir = path.join(outputDir, NOME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${NOME}.md`), TRANSCRICAO, 'utf-8');
  fs.writeFileSync(path.join(dir, `${NOME}.txt`), 'Bom dia.\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({
    name: NOME,
    recorded_at_local: '2026-09-16 14:30:00',
    duration_seconds: 120,
    segments: 2,
    language: 'pt',
  }), 'utf-8');
  fs.writeFileSync(path.join(dir, 'analise.json'), JSON.stringify(ANALISE), 'utf-8');
  return dir;
}

test.describe('documento em PDF', () => {
  test('imprime pelo próprio Electron e grava um PDF com conteúdo', async ({
    page, workspace, errors,
  }) => {
    const dir = semearReuniao(workspace.outputDir);
    await waitForHome(page);

    // O pedido passa pela mesma ponte que o botão "Gerar documentos" usa.
    const resultado = await page.evaluate(async (meetingId) => {
      const fim = new Promise((resolve) => {
        const parar = window.api.on('doc:done', (evento) => { parar(); resolve(evento); });
      });
      await window.api.generateDoc({ meetingId });
      return fim;
    }, NOME);

    expect(resultado.message || '').toBe('');
    expect(resultado.ok).toBe(true);

    const pdf = path.join(dir, `${NOME} - Documento.pdf`);
    expect(fs.existsSync(pdf)).toBe(true);

    // Um arquivo existe e tem tamanho; um PDF começa com %PDF- e termina com
    // %%EOF. Sem os dois, o que está no disco não abre em leitor nenhum.
    const bytes = fs.readFileSync(pdf);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.subarray(-1024).toString('latin1')).toContain('%%EOF');

    expect(errors).toEqual([]);
  });
});
