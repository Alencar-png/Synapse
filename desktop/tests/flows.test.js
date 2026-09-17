'use strict';

/**
 * Fluxos próprios depois da transcrição.
 *
 * Dois pontos carregam o risco: a etapa da análise não pode sumir (o Kanban e
 * o PDF saem dela) e o encadeamento precisa ligar a saída de uma etapa na
 * entrada da seguinte. Errar qualquer um dos dois produz silêncio, não erro —
 * um Kanban que para de receber cards, ou uma etapa lendo um caminho vazio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ANALYSIS_STEP_ID,
  moveStep,
  newStep,
  normalizeFlow,
  normalizeStep,
  runnableSteps,
  safeFileName,
  validateStep,
} = require('../flows');
const { fillPrompt, buildStepArgs, planSteps } = require('../flow-runner');

const PROMPT_ANALISE = 'Leia {{TRANSCRICAO}} e grave {{JSON}}.';

const etapaDeArquivo = (patch = {}) => newStep({
  name: 'Resumo para o cliente',
  prompt: 'Leia {{TRANSCRICAO}} e escreva um resumo em {{SAIDA}}.',
  fileName: 'resumo-cliente.md',
  ...patch,
});

test('a análise entra mesmo num fluxo que nunca foi configurado', () => {
  const flow = normalizeFlow(undefined, { analysisPrompt: PROMPT_ANALISE });

  assert.equal(flow.length, 1);
  assert.equal(flow[0].id, ANALYSIS_STEP_ID);
  assert.equal(flow[0].builtin, true);
  assert.equal(flow[0].prompt, PROMPT_ANALISE);
});

test('a análise não pode ser apagada, renomeada nem mudar de destino', () => {
  const flow = normalizeFlow(
    [{ id: ANALYSIS_STEP_ID, name: 'Outro nome', output: 'arquivo', fileName: 'x.md', enabled: false }],
    { analysisPrompt: PROMPT_ANALISE },
  );

  assert.equal(flow.length, 1);
  assert.equal(flow[0].name, 'Análise da reunião');
  assert.equal(flow[0].output, 'analise');
  assert.equal(flow[0].fileName, 'analise.json');
  // Desligar, isso sim: quem não quer cards nem PDF desliga a etapa.
  assert.equal(flow[0].enabled, false);
});

test('a análise volta para o começo quando o fluxo salvo não a tinha', () => {
  const flow = normalizeFlow([etapaDeArquivo()], { analysisPrompt: PROMPT_ANALISE });

  assert.equal(flow[0].id, ANALYSIS_STEP_ID);
  assert.equal(flow[1].name, 'Resumo para o cliente');
});

test('o prompt da análise vem do arquivo de prompts, não da cópia salva', () => {
  // Guardar o texto nos dois lugares daria duas versões do mesmo prompt, e a
  // edição feita em Configurações ficaria para trás.
  const flow = normalizeFlow(
    [{ id: ANALYSIS_STEP_ID, prompt: 'texto velho, de outra versão do app' }],
    { analysisPrompt: PROMPT_ANALISE },
  );
  assert.equal(flow[0].prompt, PROMPT_ANALISE);
});

test('etapa do usuário nunca escreve por cima da análise', () => {
  const s = normalizeStep({ name: 'Minha', output: 'analise', fileName: 'analise.json' });
  assert.equal(s.output, 'arquivo');
  assert.equal(s.builtin, false);
});

test('nome de arquivo não vira caminho', () => {
  assert.equal(safeFileName('..\\..\\Windows\\system32\\algo.md'), '-..-Windows-system32-algo.md');
  assert.equal(safeFileName('relatório: final?.md'), 'relatório- final-.md');
  assert.equal(safeFileName(''), 'saida.md');
  assert.equal(safeFileName('  '), 'saida.md');
});

test('ids repetidos não colapsam duas etapas numa', () => {
  const flow = normalizeFlow([
    { id: 'igual', name: 'Primeira', prompt: 'a {{SAIDA}}' },
    { id: 'igual', name: 'Segunda', prompt: 'b {{SAIDA}}' },
  ], { analysisPrompt: PROMPT_ANALISE });

  const ids = new Set(flow.map((s) => s.id));
  assert.equal(ids.size, flow.length);
  assert.equal(flow.length, 3);
});

test('validateStep recusa o que não roda', () => {
  assert.match(validateStep({ name: '', prompt: 'algo' }), /nome/);
  assert.match(validateStep({ name: 'X', prompt: '' }), /prompt/);
  // Grava em arquivo mas não diz onde: o modelo escolheria sozinho.
  assert.match(validateStep({ name: 'X', prompt: 'faça algo', output: 'arquivo' }), /\{\{SAIDA\}\}/);
  assert.equal(validateStep(etapaDeArquivo()), '');
  // Com skill, o prompt pode ser curto: a instrução mora na skill.
  assert.equal(validateStep({ name: 'X', prompt: '', skill: 'wiki-ingest', output: 'nenhuma' }), '');
});

test('etapa desligada não roda; etapa que depende da análise cai com ela', () => {
  const flow = normalizeFlow([
    etapaDeArquivo({ id: 'a', name: 'Depende', input: 'analise' }),
    etapaDeArquivo({ id: 'b', name: 'Independente' }),
    etapaDeArquivo({ id: 'c', name: 'Desligada', enabled: false }),
  ], { analysisPrompt: PROMPT_ANALISE });

  assert.deepEqual(runnableSteps(flow).map((s) => s.name),
    ['Análise da reunião', 'Depende', 'Independente']);

  // Sem análise, quem dependia dela não tem o que ler.
  const semAnalise = flow.map((s) => (s.id === ANALYSIS_STEP_ID ? { ...s, enabled: false } : s));
  assert.deepEqual(runnableSteps(semAnalise).map((s) => s.name), ['Independente']);
});

test('moveStep troca a ordem e ignora o que sairia da lista', () => {
  const flow = normalizeFlow([
    etapaDeArquivo({ id: 'a', name: 'A' }),
    etapaDeArquivo({ id: 'b', name: 'B' }),
  ], { analysisPrompt: PROMPT_ANALISE });

  assert.deepEqual(moveStep(flow, 'b', 'up').map((s) => s.name), ['Análise da reunião', 'B', 'A']);
  assert.deepEqual(moveStep(flow, 'a', 'down').map((s) => s.name), ['Análise da reunião', 'B', 'A']);
  // Primeira para cima e última para baixo não fazem nada.
  assert.deepEqual(moveStep(flow, ANALYSIS_STEP_ID, 'up'), flow);
  assert.deepEqual(moveStep(flow, 'b', 'down'), flow);
  assert.deepEqual(moveStep(flow, 'inexistente', 'up'), flow);
});

test('fillPrompt troca os placeholders pelos caminhos da reunião', () => {
  const texto = fillPrompt(
    { prompt: 'Leia {{TRANSCRICAO}}, use {{CONTEXTO}}, grave em {{SAIDA}} sobre {{REUNIAO}}.', skill: '' },
    {
      transcriptPath: 'C:\\r\\Weekly\\Weekly.md',
      outputPath: 'C:\\r\\Weekly\\resumo.md',
      meetingName: 'Weekly',
      context: 'Projeto de onboarding',
    },
  );

  assert.match(texto, /C:\\r\\Weekly\\Weekly\.md/);
  assert.match(texto, /C:\\r\\Weekly\\resumo\.md/);
  assert.match(texto, /Projeto de onboarding/);
  assert.match(texto, /sobre Weekly/);
});

test('placeholder sem valor diz que não há, em vez de virar caminho vazio', () => {
  const texto = fillPrompt({ prompt: 'Leia {{ANTERIOR}}.', skill: '' }, {});
  assert.match(texto, /não disponível/);
  assert.doesNotMatch(texto, /Leia \./);
});

test('a skill entra como instrução antes do prompt', () => {
  const texto = fillPrompt({ prompt: 'Resuma a reunião.', skill: 'wiki-ingest' }, {});
  assert.match(texto, /^Use a skill `wiki-ingest`/);
});

test('a etapa só ganha a ferramenta de skill quando pede uma', () => {
  assert.deepEqual(buildStepArgs({ skill: '' }).slice(0, 3), ['-p', '--allowedTools', 'Read,Write']);
  assert.deepEqual(buildStepArgs({ skill: 'wiki' }).slice(0, 3), ['-p', '--allowedTools', 'Read,Write,Skill']);
  // Bash nunca: a transcrição é fala de terceiros, e fala de terceiros é dado.
  for (const skill of ['', 'wiki']) {
    assert.doesNotMatch(buildStepArgs({ skill }).join(' '), /Bash/);
  }
});

test('a saída de uma etapa vira a entrada da seguinte', () => {
  const flow = normalizeFlow([
    etapaDeArquivo({ id: 'a', name: 'Resumo', fileName: 'resumo.md' }),
    etapaDeArquivo({
      id: 'b',
      name: 'Tradução',
      input: 'anterior',
      fileName: 'resumo-en.md',
      prompt: 'Traduza {{ANTERIOR}} e grave em {{SAIDA}}.',
    }),
  ], { analysisPrompt: PROMPT_ANALISE });

  // O separador é o da plataforma: montar a expectativa com o mesmo
  // path.join que o código usa é o que faz este teste valer no Windows e no
  // Linux — a suíte do CI roda em Ubuntu.
  const dir = 'C:\\r\\Weekly';
  const dentro = (nome) => path.join(dir, nome);

  const plano = planSteps(flow, {
    meetingDir: dir,
    analysisPath: dentro('analise.json'),
    transcriptPath: dentro('Weekly.md'),
  });

  assert.equal(plano.length, 3);
  assert.equal(plano[0].outputPath, dentro('analise.json'));
  assert.equal(plano[1].outputPath, dentro('resumo.md'));
  assert.equal(plano[2].outputPath, dentro('resumo-en.md'));
  // A tradução recebe o caminho do resumo, não o da análise.
  assert.ok(plano[2].prompt.includes(`Traduza ${dentro('resumo.md')}`));
});

test('etapa sem saída não vira o "anterior" de ninguém', () => {
  const flow = normalizeFlow([
    etapaDeArquivo({ id: 'a', name: 'Grava', fileName: 'resumo.md' }),
    newStep({ id: 'b', name: 'Só age', output: 'nenhuma', prompt: 'Faça algo com {{TRANSCRICAO}}.' }),
    etapaDeArquivo({
      id: 'c', name: 'Usa o anterior', input: 'anterior', prompt: 'Leia {{ANTERIOR}} e grave {{SAIDA}}.',
    }),
  ], { analysisPrompt: PROMPT_ANALISE });

  const dir = 'C:\\r\\W';
  const plano = planSteps(flow, { meetingDir: dir, analysisPath: path.join(dir, 'analise.json') });
  // A última pega o resumo, pulando a etapa que não gravou nada.
  assert.ok(plano[3].prompt.includes(`Leia ${path.join(dir, 'resumo.md')}`));
});
