'use strict';

/**
 * A chamada ao Claude Code em modo headless (`claude -p`).
 *
 * O Claude faz uma coisa só: lê a transcrição e devolve a análise da reunião
 * em JSON (`prompts/analise.md`). Cards do Kanban e documento em PDF saem
 * dessa análise, montados pelo app — o modelo não escreve HTML nem imprime.
 *
 * Os prompts ficam em `prompts/*.md`, fora do código, e a pessoa pode
 * editá-los em Configurações (`prompts-store.js`).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPrompt } = require('./prompts-store');

// Sufixo do PDF da reunião: "<nome> - Documento.pdf".
const DOCUMENT_SUFFIX = 'Documento';

// Navegadores capazes de imprimir HTML em PDF, na ordem de preferência.
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  return BROWSERS.find((b) => fs.existsSync(b)) || null;
}

/**
 * Onde o Claude Code costuma estar instalado, na ordem de preferência.
 *
 * Depender só do PATH quebra quando o app é aberto pelo Explorer ou por um
 * atalho: o processo herda um ambiente diferente do terminal, e o binário
 * some. A variável CLAUDE_BIN cobre instalações fora do lugar padrão.
 */
function findClaude() {
  const home = os.homedir();
  const candidatos = [
    process.env.CLAUDE_BIN,
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
  ].filter(Boolean);

  const achado = candidatos.find((c) => {
    try { return fs.existsSync(c); } catch { return false; }
  });
  // Sem caminho conhecido, ainda vale tentar pelo PATH do sistema.
  return achado || 'claude';
}

/**
 * Bloco de contexto inserido no prompt.
 *
 * Sem contexto, o texto diz isso explicitamente: um placeholder vazio deixaria
 * o modelo preenchendo a lacuna por conta própria.
 */
function contextBlock(context) {
  const texto = (context || '').trim();
  if (!texto) {
    return 'Nenhum contexto foi fornecido. Baseie-se apenas na transcrição e '
      + 'mantenha um registro profissional e neutro.';
  }
  return [
    'O contexto abaixo descreve o projeto e o tipo de documento esperado.',
    'Use-o para ajustar o foco, o vocabulário e o registro do texto — mas ele',
    'não é fonte de fatos: nada que esteja apenas no contexto pode virar',
    'decisão, tarefa ou conclusão atribuída à reunião.',
    '',
    '```',
    texto,
    '```',
  ].join('\n');
}

/**
 * Prompt da análise: o Claude lê a transcrição e grava um JSON com título,
 * resumo, decisões e as ações combinadas. Sai dado, não documento.
 *
 * `userPromptsDir` é onde ficam os prompts editados em Configurações; quando
 * há um lá, é ele que vale.
 */
function buildAnalysisPrompt({ transcriptPath, jsonPath, context = '', userPromptsDir }) {
  const template = readPrompt('analise', { userDir: userPromptsDir }).text;
  return template
    .replaceAll('{{TRANSCRICAO}}', transcriptPath)
    .replaceAll('{{JSON}}', jsonPath)
    .replaceAll('{{CONTEXTO}}', contextBlock(context));
}

/** Onde o JSON que o Claude escreve é gravado antes de o app normalizá-lo. */
function analysisTmpPathFor(transcriptPath) {
  return path.join(
    os.tmpdir(),
    `synapse-analise-${path.basename(transcriptPath, path.extname(transcriptPath))}.json`,
  );
}

/** Caminho do PDF da reunião, ao lado da transcrição. */
function documentPdfPath(transcriptPath) {
  const dir = path.dirname(transcriptPath);
  const stem = path.basename(transcriptPath, path.extname(transcriptPath));
  return path.join(dir, `${stem} - ${DOCUMENT_SUFFIX}.pdf`);
}

/**
 * Argumentos do `claude -p`. O prompt NÃO vai aqui: ele é escrito no stdin.
 *
 * Como argumento, um prompt de várias linhas com aspas e barras é destruído
 * pelo shell do Windows — o processo chega a rodar, mas sem instrução nenhuma.
 *
 * `stream-json` (que exige `--verbose`) permite acompanhar o trabalho em vez
 * de olhar para uma tela parada por dois minutos.
 *
 * **Só Read e Write.** Esta análise roda sozinha ao fim de toda transcrição,
 * sem ninguém para aprovar nada, e o que ela lê é a fala de terceiros — ou um
 * arquivo de legenda que veio de fora. Texto assim é dado, nunca instrução:
 * com Bash liberado, uma frase plantada na reunião viraria comando na máquina
 * de quem só queria o resumo. Ler a transcrição e escrever o JSON é tudo de
 * que o trabalho precisa.
 */
function buildClaudeArgs({ model = 'sonnet' } = {}) {
  return [
    '-p',
    '--allowedTools', 'Read,Write',
    '--permission-mode', 'acceptEdits',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

/**
 * Traduz um evento do stream do Claude numa frase curta para a interface.
 * Devolve null quando o evento não interessa ao usuário.
 */
function describeEvent(event) {
  if (event.type === 'assistant') {
    const blocks = event.message?.content || [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (block.name === 'Read') return 'lendo a transcrição';
        if (block.name === 'Write') return 'escrevendo a análise';
        if (block.name === 'Bash') return 'executando um comando';
        return `usando ${block.name}`;
      }
      if (block.type === 'text' && block.text.trim()) return 'analisando a reunião';
    }
  }
  if (event.type === 'result') {
    return event.is_error ? 'erro na análise' : 'análise pronta';
  }
  return null;
}

module.exports = {
  DOCUMENT_SUFFIX,
  analysisTmpPathFor,
  buildAnalysisPrompt,
  buildClaudeArgs,
  describeEvent,
  documentPdfPath,
  findBrowser,
  findClaude,
};
