'use strict';

/**
 * O que acontece depois da transcrição, escrito por quem usa o app.
 *
 * Antes havia uma etapa só, fixa no código: o Claude lia a transcrição e
 * devolvia a análise, de onde saíam os cards e o PDF. Servia para reunião de
 * time e para mais nada — quem precisava de um relato de consulta, de um
 * resumo para cliente ou de um follow-up em inglês não tinha por onde pedir.
 *
 * Aqui uma etapa é um prompt com um destino. Elas rodam em ordem, e a saída de
 * cada uma fica disponível para as seguintes: a etapa 2 pode pegar o que a 1
 * escreveu. Uma etapa pode também chamar uma **skill** do Claude Code — uma
 * pasta de instruções que a pessoa já tenha, invocada por nome.
 *
 * A etapa da análise continua embutida porque o resto do app depende do
 * formato dela (os cards do Kanban e a tabela do PDF saem do `analise.json`).
 * Ela pode ser editada e desligada, mas não apagada nem renomeada — apagá-la
 * deixaria o Kanban sem fonte, e o app não teria como avisar depois.
 *
 * Este módulo é só o modelo: valida, normaliza e ordena. Quem executa é o
 * `flow-runner`.
 */

const { randomUUID } = require('node:crypto');

// O que uma etapa pode receber. `transcricao` é sempre o ponto de partida.
const INPUTS = ['transcricao', 'analise', 'anterior'];

// Onde a saída da etapa vai parar.
//   analise  — o JSON que alimenta Kanban e PDF (só a etapa embutida).
//   arquivo  — um arquivo na pasta da reunião, com o nome escolhido.
//   nenhuma  — a etapa faz o que faz e não precisa devolver arquivo.
const OUTPUTS = ['analise', 'arquivo', 'nenhuma'];

// Placeholders que o app troca antes de mandar o prompt.
const PLACEHOLDERS = {
  '{{TRANSCRICAO}}': 'caminho do arquivo da transcrição',
  '{{ANALISE}}': 'caminho do analise.json desta reunião',
  '{{ANTERIOR}}': 'caminho da saída da etapa anterior',
  '{{SAIDA}}': 'caminho onde esta etapa deve gravar',
  '{{CONTEXTO}}': 'o contexto escrito no projeto',
  '{{REUNIAO}}': 'nome da reunião',
  '{{PROJETO}}': 'nome do projeto',
};

// A etapa que o resto do app conhece pelo nome. `id` fixo: é por ele que a
// configuração antiga (e o código do Kanban) a encontra.
const ANALYSIS_STEP_ID = 'analise';

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Nome de arquivo sem caminho: uma etapa grava na pasta da reunião, e só. */
function safeFileName(nome) {
  const limpo = str(nome, 120).replace(/[<>:"/\\|?*]/g, '-').replace(/^\.+/, '');
  return limpo || 'saida.md';
}

/** A etapa embutida, com o prompt padrão vindo de `prompts/analise.md`. */
function analysisStep(promptText) {
  return {
    id: ANALYSIS_STEP_ID,
    name: 'Análise da reunião',
    description: 'Lê a transcrição uma vez e devolve o JSON que vira os cards do Kanban e a tabela do documento.',
    prompt: promptText,
    input: 'transcricao',
    output: 'analise',
    fileName: 'analise.json',
    skill: '',
    enabled: true,
    builtin: true,
  };
}

/** Uma etapa nova, em branco, pronta para ser editada. */
function newStep(patch = {}) {
  return normalizeStep({
    id: randomUUID(),
    name: 'Nova etapa',
    prompt: '',
    input: 'transcricao',
    output: 'arquivo',
    fileName: 'saida.md',
    skill: '',
    enabled: true,
    builtin: false,
    ...patch,
  });
}

function normalizeStep(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const builtin = src.id === ANALYSIS_STEP_ID;
  const output = OUTPUTS.includes(src.output) ? src.output : 'arquivo';
  return {
    id: str(src.id, 60) || randomUUID(),
    name: str(src.name, 80) || 'Etapa sem nome',
    description: str(src.description, 300),
    prompt: typeof src.prompt === 'string' ? src.prompt : '',
    input: INPUTS.includes(src.input) ? src.input : 'transcricao',
    // Só a etapa embutida escreve a análise: o formato dela é contrato com o
    // Kanban e com o PDF, não um destino livre.
    output: builtin ? 'analise' : (output === 'analise' ? 'arquivo' : output),
    fileName: builtin ? 'analise.json' : safeFileName(src.fileName),
    skill: str(src.skill, 80),
    enabled: src.enabled !== false,
    builtin,
  };
}

/**
 * A lista completa e em ordem, com a etapa da análise sempre presente.
 *
 * Configuração vinda de uma versão anterior do app não tem fluxo nenhum: o
 * resultado é o comportamento de sempre, com a análise ligada.
 */
function normalizeFlow(raw, { analysisPrompt = '' } = {}) {
  const lista = Array.isArray(raw) ? raw.map(normalizeStep) : [];
  const temAnalise = lista.some((s) => s.id === ANALYSIS_STEP_ID);
  const analise = lista.find((s) => s.id === ANALYSIS_STEP_ID);

  const etapas = temAnalise
    ? lista.map((s) => (s.id === ANALYSIS_STEP_ID
      // O prompt da análise mora em prompts/analise.md (e na edição que a
      // pessoa fez lá). Guardá-lo também aqui daria duas versões do mesmo
      // texto, e uma delas ficaria para trás.
      ? { ...analysisStep(analysisPrompt), enabled: analise.enabled }
      : s))
    : [analysisStep(analysisPrompt), ...lista];

  // Ids repetidos quebrariam a edição (duas etapas respondendo pelo mesmo
  // nome); o segundo ganha um id novo em vez de sumir.
  const vistos = new Set();
  return etapas.map((s) => {
    if (!vistos.has(s.id)) { vistos.add(s.id); return s; }
    return { ...s, id: randomUUID() };
  });
}

/**
 * Motivo para recusar a etapa, ou string vazia quando ela serve.
 *
 * O nome é conferido no que a pessoa digitou, não no normalizado: a
 * normalização já teria trocado o vazio por "Etapa sem nome", e o aviso nunca
 * apareceria — a etapa seria salva com um nome que ninguém escolheu.
 */
function validateStep(step) {
  const s = normalizeStep(step);
  const nomeDigitado = typeof step?.name === 'string' ? step.name.trim() : '';
  if (!nomeDigitado) return 'A etapa precisa de um nome.';
  if (!s.prompt.trim() && !s.skill) {
    return 'A etapa precisa de um prompt, ou de uma skill para executar.';
  }
  if (s.output === 'arquivo' && !s.prompt.includes('{{SAIDA}}') && !s.skill) {
    return 'O prompt precisa dizer onde gravar: use {{SAIDA}} no texto.';
  }
  if (s.input === 'analise' && s.id === ANALYSIS_STEP_ID) {
    return 'A análise não pode receber a si mesma.';
  }
  return '';
}

/**
 * As etapas que realmente vão rodar, na ordem.
 *
 * Uma etapa que depende da análise não roda com a análise desligada: sem o
 * arquivo, o prompt receberia um caminho que não existe, e o modelo
 * responderia sobre o nada.
 */
function runnableSteps(flow) {
  const etapas = flow.filter((s) => s.enabled);
  const temAnalise = etapas.some((s) => s.id === ANALYSIS_STEP_ID);
  return etapas.filter((s) => s.input !== 'analise' || temAnalise);
}

/** Move uma etapa uma posição para cima ou para baixo. */
function moveStep(flow, id, direcao) {
  const i = flow.findIndex((s) => s.id === id);
  const j = i + (direcao === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= flow.length) return flow;
  const copia = [...flow];
  [copia[i], copia[j]] = [copia[j], copia[i]];
  return copia;
}

module.exports = {
  ANALYSIS_STEP_ID,
  INPUTS,
  OUTPUTS,
  PLACEHOLDERS,
  analysisStep,
  moveStep,
  newStep,
  normalizeFlow,
  normalizeStep,
  runnableSteps,
  safeFileName,
  validateStep,
};
