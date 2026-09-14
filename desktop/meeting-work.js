'use strict';

/**
 * O trabalho que ainda corre por uma reunião, quando ela é excluída.
 *
 * Apagar os arquivos e os registros não basta: depois da transcrição a reunião
 * continua ocupando processos por um bom tempo — o `claude -p` da análise, as
 * etapas do fluxo, o navegador imprimindo o PDF, e a fila do que ainda vai ser
 * gerado. Excluir a reunião e deixar tudo isso de pé produz um estrago
 * silencioso: o modelo termina e **recria** a pasta que acabou de ir para a
 * Lixeira, com um `analise.json` órfão dentro; o navegador imprime um PDF de
 * uma reunião que não existe mais; e a tela segue mostrando progresso de algo
 * que ninguém pode mais abrir.
 *
 * Este módulo não mata processo nem toca disco: ele só decide o que precisa
 * parar, para que a decisão possa ser testada sem abrir nada.
 */

/**
 * O que fazer para que nada continue correndo por `meetingId`.
 *
 * Devolve:
 * - `queue`: a fila de documentos sem os itens da reunião;
 * - `removedFromQueue`: quantos saíram da fila;
 * - `cancelDocJob`: se o PDF em andamento é desta reunião;
 * - `cancelExtraction`: se a análise (ou etapa do fluxo) em andamento é dela.
 *
 * Sem `meetingId` nada é cancelado: apagar arquivos avulsos de uma reunião
 * (o caso em que a pessoa escolhe quais arquivos remover) não é motivo para
 * derrubar trabalho nenhum.
 */
function planWorkCancellation({
  meetingId,
  docQueue = [],
  docJob = null,
  extraction = null,
} = {}) {
  if (!meetingId) {
    return {
      queue: docQueue,
      removedFromQueue: 0,
      cancelDocJob: false,
      cancelExtraction: false,
    };
  }

  const queue = docQueue.filter((item) => item.meetingId !== meetingId);
  return {
    queue,
    removedFromQueue: docQueue.length - queue.length,
    cancelDocJob: Boolean(docJob) && docJob.meetingId === meetingId,
    cancelExtraction: Boolean(extraction) && extraction.meetingId === meetingId,
  };
}

/** O que dizer no log quando algo foi interrompido. Vazio quando nada foi. */
function describeCancellation({ removedFromQueue = 0, cancelDocJob = false, cancelExtraction = false }) {
  const partes = [];
  if (cancelExtraction) partes.push('a análise em andamento');
  if (cancelDocJob) partes.push('o documento em andamento');
  if (removedFromQueue) {
    partes.push(`${removedFromQueue} documento(s) que estavam na fila`);
  }
  return partes.length ? `Reunião excluída: ${partes.join(', ')} foi interrompido.` : '';
}

module.exports = { describeCancellation, planWorkCancellation };
