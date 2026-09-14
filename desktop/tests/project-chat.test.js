'use strict';

/**
 * O chat do projeto é o Claude Code com contexto. O que se fixa aqui: o
 * system prompt leva o que o Claude precisa para achar as coisas, os
 * argumentos respeitam o modo (leitura × autônomo) e a sessão, e o stream
 * vira eventos que a tela entende.
 */

const assert = require('node:assert');
const { test } = require('node:test');

const {
  READ_ONLY_TOOLS,
  buildChatArgs,
  buildChatSystemPrompt,
  describeChatEvent,
  describeTool,
  isMissingSession,
} = require('../project-chat');

const project = { id: 'p-alpha', name: 'Projeto Alpha', context: 'Plataforma de onboarding. Time: Ana e Bruno.' };
const meetings = [
  {
    name: 'Weekly produto', recordedAt: new Date(2026, 7, 18).getTime(),
    transcriptPath: 'C:\\Reunioes\\Weekly produto\\Weekly produto.md',
    analysisPath: 'C:\\Reunioes\\Weekly produto\\analise.json',
    documentPath: 'C:\\Reunioes\\Weekly produto\\Weekly produto - Documento.pdf',
  },
  { name: 'Kickoff', recordedAt: 0, transcriptPath: 'C:\\Reunioes\\Kickoff\\Kickoff.md' },
];
const tasks = [
  { title: 'Ajustar e-mail', status: 'backlog', assignee: 'Bruno', meeting: { name: 'Weekly produto' } },
  { title: 'Já feito', status: 'done', assignee: '' },
];

test('system prompt: projeto, contexto, caminhos das reuniões e tarefas abertas', () => {
  const p = buildChatSystemPrompt({
    project, meetings, tasks,
    meetingsDir: 'C:\\code\\alpha\\synapse', workdir: 'C:\\code\\alpha', bypass: false,
  });
  assert.match(p, /## Projeto: Projeto Alpha/);
  assert.match(p, /Plataforma de onboarding/);
  assert.match(p, /Pasta de trabalho \(seu diretório atual\): C:\\code\\alpha/);
  assert.match(p, /Reuniões deste projeto: C:\\code\\alpha\\synapse/);
  // O banco guarda o Kanban, o contexto e a conversa de TODOS os projetos. O
  // prompt não pode apontá-lo: este chat é de um projeto só, e o caminho seria
  // um convite a abrir o material dos outros.
  assert.doesNotMatch(p, /synapse\.db/);
  assert.match(p, /O Kanban não é um arquivo que você abre/);
  assert.match(p, /\*\*Weekly produto\*\* \(18\/08\/2026\)/);
  assert.match(p, /transcrição: C:\\Reunioes\\Weekly produto\\Weekly produto\.md/);
  assert.match(p, /análise.*analise\.json/);
  assert.match(p, /documento PDF: .*Documento\.pdf/);
  assert.match(p, /Reuniões do projeto \(2\)/);
  assert.match(p, /Tarefas abertas no Kanban \(1\)/);
  assert.match(p, /\[backlog\] Ajustar e-mail — Bruno \(da reunião "Weekly produto"\)/);
  assert.doesNotMatch(p, /Já feito/);
});

test('system prompt: sem contexto, sem reuniões, workdir igual à pasta de saída', () => {
  const p = buildChatSystemPrompt({
    project: { name: 'Vazio', context: '' }, meetings: [], tasks: [],
    meetingsDir: 'C:\\R', workdir: 'C:\\R', bypass: true,
  });
  assert.doesNotMatch(p, /Contexto escrito/);
  assert.match(p, /Nenhuma ainda/);
  assert.doesNotMatch(p, /Reuniões deste projeto/);
  assert.doesNotMatch(p, /Tarefas abertas/);
});

test('system prompt: o modo muda o que o Claude acha que pode fazer', () => {
  const base = { project, meetings: [], tasks: [], meetingsDir: 'C:\\R', workdir: 'C:\\R' };
  assert.match(buildChatSystemPrompt({ ...base, bypass: true }), /modo autônomo/);
  assert.match(buildChatSystemPrompt({ ...base, bypass: true }), /destrutivo/);
  assert.match(buildChatSystemPrompt({ ...base, bypass: false }), /modo leitura/);
  assert.doesNotMatch(buildChatSystemPrompt({ ...base, bypass: false }), /sem pedir permissão/);
});

test('args: leitura restringe ferramentas e não pede permissão a ninguém', () => {
  const args = buildChatArgs({ sessionId: 'abc', resume: false, bypass: false, systemPromptFile: 'C:\\t\\sp.md', addDirs: ['C:\\R'] });
  assert.deepStrictEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.ok(args.includes('--session-id') && args[args.indexOf('--session-id') + 1] === 'abc');
  assert.ok(!args.includes('--resume'));
  assert.strictEqual(args[args.indexOf('--append-system-prompt-file') + 1], 'C:\\t\\sp.md');
  assert.strictEqual(args[args.indexOf('--add-dir') + 1], 'C:\\R');
  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.strictEqual(args[args.indexOf('--allowedTools') + 1], READ_ONLY_TOOLS.join(','));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!READ_ONLY_TOOLS.some((t) => ['Write', 'Edit', 'Bash'].includes(t)), 'leitura não escreve nem executa');
});

test('args: autônomo usa o bypass e retoma a sessão', () => {
  const args = buildChatArgs({ sessionId: 'abc', resume: true, bypass: true, model: 'sonnet' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--allowedTools'));
  assert.strictEqual(args[args.indexOf('--resume') + 1], 'abc');
  assert.ok(!args.includes('--session-id'));
  assert.strictEqual(args[args.indexOf('--model') + 1], 'sonnet');
});

test('describeTool fala em nomes de arquivo e comandos, não em JSON', () => {
  assert.strictEqual(describeTool('Read', { file_path: 'C:\\R\\Weekly\\Weekly.md' }), 'lendo Weekly.md');
  assert.strictEqual(describeTool('Bash', { command: 'git status' }), 'executando: git status');
  assert.strictEqual(describeTool('Grep', { pattern: 'onboarding' }), 'buscando "onboarding"');
  assert.strictEqual(describeTool('Inventada', {}), 'usando Inventada');
  assert.ok(describeTool('Bash', { command: 'x'.repeat(200) }).length < 110);
});

test('describeChatEvent: assistant vira texto e ferramentas; result fecha a rodada', () => {
  const assistant = {
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Vou olhar a reunião.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\R\\Weekly.md' } },
      { type: 'text', text: '   ' },
    ] },
  };
  assert.deepStrictEqual(describeChatEvent(assistant), [
    { kind: 'text', text: 'Vou olhar a reunião.' },
    { kind: 'tool', label: 'lendo Weekly.md' },
  ]);
  assert.deepStrictEqual(describeChatEvent({ type: 'result', result: 'Pronto.', session_id: 's1', is_error: false }), [
    { kind: 'result', text: 'Pronto.', sessionId: 's1', isError: false },
  ]);
  assert.strictEqual(describeChatEvent({ type: 'system', subtype: 'init' }), null);
  assert.strictEqual(describeChatEvent({ type: 'user' }), null);
  assert.strictEqual(describeChatEvent(null), null);
});

test('isMissingSession reconhece o erro de sessão perdida', () => {
  assert.strictEqual(isMissingSession('No conversation found with session ID abc'), true);
  assert.strictEqual(isMissingSession('rate limit'), false);
  assert.strictEqual(isMissingSession(''), false);
});
