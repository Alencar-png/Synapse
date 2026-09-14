'use strict';

/**
 * Executa as etapas do fluxo, uma depois da outra.
 *
 * Cada etapa é um `claude -p` com o prompt já preenchido: os placeholders
 * viram caminhos de arquivo, o modelo lê o que precisa e grava onde foi
 * mandado. A saída de uma etapa fica disponível para a seguinte, que é o que
 * transforma uma lista de prompts num fluxo de verdade.
 *
 * **Só Read e Write** — mais Skill, quando a etapa pede uma. O que entra aqui
 * é fala de terceiros numa reunião: dado, nunca instrução. Com Bash liberado,
 * uma frase plantada numa reunião viraria comando na máquina de quem só queria
 * o resumo.
 *
 * Uma etapa que falha não derruba as outras nem a reunião: a transcrição já
 * está no disco, e o que se perde é aquele arquivo. O motivo vai para o log da
 * janela, com o nome da etapa na frente.
 */

const path = require('node:path');

const { ANALYSIS_STEP_ID, runnableSteps } = require('./flows');

/**
 * Argumentos do `claude -p` para uma etapa.
 *
 * `Skill` só entra quando a etapa nomeia uma: ferramenta disponível é
 * ferramenta que o modelo pode decidir usar, e o mínimo necessário é a regra.
 */
function buildStepArgs({ skill = '', model = 'sonnet' } = {}) {
  const tools = skill ? 'Read,Write,Skill' : 'Read,Write';
  return [
    '-p',
    '--allowedTools', tools,
    '--permission-mode', 'acceptEdits',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

/**
 * Onde a etapa grava. Cada uma tem o seu arquivo na pasta da reunião — duas
 * etapas escrevendo no mesmo lugar apagariam o trabalho uma da outra.
 */
function outputPathFor(step, meetingDir) {
  if (step.output === 'nenhuma' || !meetingDir) return '';
  return path.join(meetingDir, step.fileName);
}

/**
 * Troca os placeholders pelos caminhos e valores desta reunião.
 *
 * Um placeholder sem valor vira uma frase dizendo isso, e não um caminho
 * vazio: "leia o arquivo " manda o modelo procurar o que não existe.
 */
function fillPrompt(step, contexto) {
  const {
    transcriptPath = '', analysisPath = '', previousPath = '', outputPath = '',
    context = '', meetingName = '', projectName = '',
  } = contexto;

  const valores = {
    '{{TRANSCRICAO}}': transcriptPath,
    '{{ANALISE}}': analysisPath,
    '{{ANTERIOR}}': previousPath,
    '{{SAIDA}}': outputPath,
    '{{REUNIAO}}': meetingName,
    '{{PROJETO}}': projectName,
    '{{CONTEXTO}}': context.trim()
      ? context.trim()
      : 'Nenhum contexto foi fornecido para este projeto.',
  };

  let texto = step.prompt;
  for (const [marca, valor] of Object.entries(valores)) {
    texto = texto.replaceAll(marca, valor || `(não disponível nesta reunião)`);
  }

  // A skill vem como instrução no começo, onde o modelo a lê antes de
  // qualquer outra coisa.
  if (step.skill) {
    texto = `Use a skill \`${step.skill}\` para executar o que segue.\n\n${texto}`;
  }
  return texto;
}

/**
 * Prepara cada etapa que vai rodar: prompt pronto e destino resolvido.
 *
 * Função pura, separada da execução, porque é aqui que mora a parte difícil —
 * o encadeamento — e é o que um teste consegue afirmar sem abrir processo.
 */
function planSteps(flow, contexto) {
  const { meetingDir = '', analysisPath = '' } = contexto;
  let anterior = '';
  const plano = [];

  for (const step of runnableSteps(flow)) {
    const outputPath = step.id === ANALYSIS_STEP_ID
      ? analysisPath
      : outputPathFor(step, meetingDir);

    const prompt = fillPrompt(step, {
      ...contexto,
      previousPath: anterior,
      outputPath,
    });

    plano.push({ step, prompt, outputPath, args: buildStepArgs({ skill: step.skill }) });
    // Só quem gravou alguma coisa serve de entrada para a próxima; uma etapa
    // sem saída não pode virar o "anterior" de ninguém.
    if (outputPath) anterior = outputPath;
  }
  return plano;
}

/** O que dizer na tela enquanto uma etapa roda. */
function describeStepProgress(step, índice, total) {
  return `etapa ${índice + 1} de ${total}: ${step.name}`;
}

module.exports = {
  buildStepArgs,
  describeStepProgress,
  fillPrompt,
  outputPathFor,
  planSteps,
};
