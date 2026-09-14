'use strict';

/**
 * Etapas que rodam depois da transcrição.
 *
 * A transcrição é o mínimo. O que vem depois — tarefas no Kanban, resumo em
 * PDF, tarefas em PDF — é escolha de quem usa, em Configurações, e cada etapa
 * liga e desliga sem afetar as outras.
 *
 * Este módulo não toca disco nem processo: só decide o que fazer, para que a
 * decisão possa ser testada sem rodar o pipeline.
 */

// Documentos em PDF que podem sair da reunião. Hoje é um só: resumo, decisões
// e tarefas no mesmo arquivo.
const DOC_KINDS = ['documento'];

// `kanban` é a extração de ações para o Kanban; `documento` é o PDF acima.
// Os rótulos que a pessoa vê ficam no HTML de Configurações.
const DEFAULT_STEPS = Object.freeze({ kanban: true, documento: true });

/**
 * Completa o que falta e descarta o que não é booleano — ou não é etapa.
 *
 * Configurações gravadas antes do documento único tinham dois PDFs (`resumo` e
 * `tarefas`). Quem desligou os dois não quer documento; quem deixou qualquer um
 * ligado, quer.
 */
function normalizeSteps(raw) {
  const steps = { ...DEFAULT_STEPS };
  if (!raw || typeof raw !== 'object') return steps;
  for (const key of Object.keys(DEFAULT_STEPS)) {
    if (typeof raw[key] === 'boolean') steps[key] = raw[key];
  }
  const legado = ['resumo', 'tarefas'].filter((key) => typeof raw[key] === 'boolean');
  if (typeof raw.documento !== 'boolean' && legado.length) {
    steps.documento = legado.some((key) => raw[key]);
  }
  return steps;
}

/**
 * Decide o que roda quando a transcrição termina.
 *
 * - `analyze`: se o Claude lê a transcrição. É uma leitura só, e dela saem o
 *   título da reunião (`autoName`), os cards do Kanban e o documento — basta
 *   uma dessas três coisas ser pedida.
 * - `saveTasks`: se as tarefas da análise viram cards. Exige projeto e a etapa.
 * - `docs`: quais PDFs entram na fila.
 */
function planAfterTranscription({
  steps,
  projectId = '',
  autoName = false,
  hasTranscript = true,
  analysisEnabled = true,
} = {}) {
  const on = normalizeSteps(steps);
  // A etapa da análise desligada no fluxo derruba tudo o que nasce dela: sem
  // o JSON não há cards, não há tabela no PDF e não há título sugerido.
  const podeLer = Boolean(hasTranscript) && analysisEnabled !== false;
  const saveTasks = podeLer && Boolean(projectId) && on.kanban;
  const docs = podeLer ? DOC_KINDS.filter((kind) => on[kind]) : [];
  const analyze = podeLer && (saveTasks || Boolean(autoName) || docs.length > 0);
  return { analyze, saveTasks, docs };
}

/**
 * Dos PDFs pedidos, quais a fila ainda não promete para esta reunião.
 *
 * A fila tem itens `{ meetingId, kinds }`. Um segundo pedido para a mesma
 * reunião só entra com o que ainda não foi prometido — nada é descartado em
 * silêncio, nem gerado duas vezes.
 */
function pendingDocKinds(queue, meetingId, kinds) {
  const promised = new Set(
    queue.filter((item) => item.meetingId === meetingId).flatMap((item) => item.kinds),
  );
  return kinds.filter((kind) => !promised.has(kind));
}

module.exports = {
  DEFAULT_STEPS,
  DOC_KINDS,
  normalizeSteps,
  pendingDocKinds,
  planAfterTranscription,
};
