'use strict';

/**
 * Excluir uma reunião precisa parar o que ainda corre por ela.
 *
 * Depois da transcrição a reunião continua ocupando processos por um bom
 * tempo — a análise, as etapas do fluxo, o navegador imprimindo o PDF, a fila
 * do que ainda vai ser gerado. Deixar isso de pé não dá erro: o modelo termina,
 * grava o arquivo, e **recria** a pasta que acabou de ir para a Lixeira. O
 * usuário exclui a reunião, ela some da tela, e no disco aparece de novo uma
 * pasta com um `analise.json` órfão dentro.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeCancellation, planWorkCancellation } = require('../meeting-work');

const fila = () => [
  { meetingId: 'reuniao-a', kinds: ['documento'] },
  { meetingId: 'reuniao-b', kinds: ['documento'] },
  { meetingId: 'reuniao-a', kinds: ['resumo'] },
];

test('a fila perde todos os itens da reunião excluída, e só eles', () => {
  const plano = planWorkCancellation({ meetingId: 'reuniao-a', docQueue: fila() });

  assert.deepEqual(plano.queue, [{ meetingId: 'reuniao-b', kinds: ['documento'] }]);
  assert.equal(plano.removedFromQueue, 2);
});

test('a análise em andamento é cancelada quando é da reunião excluída', () => {
  const extraction = { child: { pid: 10 }, meetingId: 'reuniao-a' };

  assert.equal(planWorkCancellation({ meetingId: 'reuniao-a', extraction }).cancelExtraction, true);
  assert.equal(planWorkCancellation({ meetingId: 'outra', extraction }).cancelExtraction, false);
});

test('o documento em andamento é cancelado quando é da reunião excluída', () => {
  const docJob = { child: { pid: 20 }, meetingId: 'reuniao-a', canceled: false };

  assert.equal(planWorkCancellation({ meetingId: 'reuniao-a', docJob }).cancelDocJob, true);
  assert.equal(planWorkCancellation({ meetingId: 'outra', docJob }).cancelDocJob, false);
});

test('o trabalho de outra reunião não é tocado', () => {
  const plano = planWorkCancellation({
    meetingId: 'reuniao-a',
    docQueue: [{ meetingId: 'reuniao-b', kinds: ['documento'] }],
    docJob: { child: { pid: 20 }, meetingId: 'reuniao-b' },
    extraction: { child: { pid: 10 }, meetingId: 'reuniao-b' },
  });

  assert.equal(plano.removedFromQueue, 0);
  assert.equal(plano.cancelDocJob, false);
  assert.equal(plano.cancelExtraction, false);
});

test('sem reunião, nada é cancelado', () => {
  // É o caso de apagar arquivos avulsos escolhidos na tela: não é motivo para
  // derrubar trabalho nenhum.
  const plano = planWorkCancellation({
    meetingId: '',
    docQueue: fila(),
    docJob: { child: { pid: 20 }, meetingId: 'reuniao-a' },
    extraction: { child: { pid: 10 }, meetingId: 'reuniao-a' },
  });

  assert.equal(plano.removedFromQueue, 0);
  assert.equal(plano.cancelDocJob, false);
  assert.equal(plano.cancelExtraction, false);
  assert.deepEqual(plano.queue, fila());
});

test('sem trabalho em andamento, o plano é vazio e não quebra', () => {
  const plano = planWorkCancellation({ meetingId: 'reuniao-a' });

  assert.deepEqual(plano.queue, []);
  assert.equal(plano.removedFromQueue, 0);
  assert.equal(plano.cancelDocJob, false);
  assert.equal(plano.cancelExtraction, false);
  assert.deepEqual(planWorkCancellation(), {
    queue: [], removedFromQueue: 0, cancelDocJob: false, cancelExtraction: false,
  });
});

test('o aviso diz o que foi interrompido, e cala quando nada foi', () => {
  assert.equal(describeCancellation({ removedFromQueue: 0 }), '');

  const tudo = describeCancellation({
    removedFromQueue: 2, cancelDocJob: true, cancelExtraction: true,
  });
  assert.match(tudo, /análise em andamento/);
  assert.match(tudo, /documento em andamento/);
  assert.match(tudo, /2 documento\(s\) que estavam na fila/);

  assert.match(describeCancellation({ cancelExtraction: true }), /análise/);
});
