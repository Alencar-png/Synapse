'use strict';

/**
 * O servidor MCP do Synapse: o que um assistente recebe quando pergunta pelo
 * workspace.
 *
 * O workspace aqui é de verdade — pastas temporárias, banco SQLite, arquivos
 * de transcrição e de análise —, porque o que se testa é justamente a leitura
 * desse formato. Mock de sistema de arquivos passaria com um formato que não
 * existe.
 *
 * Três coisas importam o bastante para ter teste:
 *
 *   1. **Tamanho.** A listagem não pode devolver transcrição, a leitura é
 *      paginada e diz o que falta, e a busca devolve trecho, não arquivo. É a
 *      diferença entre a ferramenta servir e queimar o contexto de quem
 *      perguntou.
 *   2. **Tolerância no nome.** Um modelo repete o nome que viu, sem acento e
 *      às vezes pela metade. Se isso não casar, toda chamada vira duas.
 *   3. **Ambiguidade recusada.** Dois nomes parecidos não podem virar um
 *      chute: a resposta certa sobre a reunião errada é o pior resultado
 *      possível.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const db = require('../db');
const projects = require('../projects');
const tasks = require('../tasks');
const tools = require('../../mcp-synapse/tools');
const server = require('../../mcp-synapse/server');
const { outputDirFrom, resolveWorkspace, userDataDir } = require('../../mcp-synapse/workspace-path');

let out;
let projetoId;

/** Uma reunião no disco: pasta, transcrição, metadados e (opcional) análise. */
function criarReuniao(raiz, nome, { falas = [], analise = null, gravadaEm = '2026-09-16 14:30:00' } = {}) {
  const dir = path.join(raiz, nome);
  fs.mkdirSync(dir, { recursive: true });

  const corpo = falas.map((f, i) => `**[00:${String(i).padStart(2, '0')}] Você:** ${f}  `).join('\n');
  fs.writeFileSync(
    path.join(dir, `${nome}.md`),
    `# ${nome}\n\n**Duracao:** 00:10:00  \n**Idioma:** pt  \n\n---\n\n${corpo}\n`,
    'utf-8',
  );
  fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({
    name: nome,
    recorded_at_local: gravadaEm,
    duration_seconds: 600,
    segments: falas.length,
    language: 'pt',
  }), 'utf-8');
  if (analise) fs.writeFileSync(path.join(dir, 'analise.json'), JSON.stringify(analise), 'utf-8');
  return dir;
}

before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-mcp-'));
  projetoId = projects.saveProject(out, { name: 'Onboarding', context: 'O fluxo de entrada de clientes.' }).id;

  criarReuniao(out, 'Kickoff do Onboarding', {
    falas: [
      'Bom dia, vamos fechar o escopo.',
      'A decisão foi adiar o e-mail de confirmação.',
      'Combinado, eu ajusto até sexta.',
    ],
    analise: {
      title: 'Kickoff do Onboarding',
      overview: ['O escopo foi fechado.'],
      topics: [{ title: 'Escopo', summary: 'Fechado nesta reunião.' }],
      decisions: [{ text: 'Adiar o e-mail de confirmação.', open: false }],
      risks: ['O prazo é apertado.'],
      tasks: [{ title: 'Ajustar o e-mail', priority: 'high', assignee: 'Bruno' }],
      pending: ['Confirmar a data do teste.'],
    },
  });

  // Sem análise: existe transcrição e nada mais. É o caso de reunião recém
  // importada, e a ferramenta precisa dizer isso em vez de fingir.
  criarReuniao(out, 'Retrospectiva sem análise', { falas: ['Só a transcrição existe aqui.'] });

  // Dois nomes que compartilham um prefixo: o material da ambiguidade.
  criarReuniao(out, 'Weekly Produto', { falas: ['Primeira weekly.'] });
  criarReuniao(out, 'Weekly Engenharia', { falas: ['Segunda weekly.'] });

  projects.assignMeeting(out, 'Kickoff do Onboarding', projetoId);
  tasks.saveTask(out, {
    projectId: projetoId,
    meetingId: 'Kickoff do Onboarding',
    title: 'Ajustar o e-mail de confirmação',
    assignee: 'Bruno',
    priority: 'high',
    status: 'backlog',
  });
});

after(() => {
  db.closeAll();
  fs.rmSync(out, { recursive: true, force: true });
});

// --- Onde fica o workspace --------------------------------------------------

test('a pasta de saída sai da variável explícita antes de qualquer arquivo', () => {
  const r = resolveWorkspace({ env: { SYNAPSE_OUTPUT_DIR: 'D:\\Outro' }, platform: 'win32', home: 'C:\\h' });
  assert.equal(r.dir, 'D:\\Outro');
  assert.equal(r.from, 'SYNAPSE_OUTPUT_DIR');
});

test('sem variável e sem settings.json, cai no padrão de fábrica em vez de falhar', () => {
  const r = resolveWorkspace({ env: {}, platform: 'linux', home: '/home/ana' });
  assert.equal(r.dir, path.join('/home/ana', 'Documents', 'Transcricoes'));
  assert.equal(r.from, 'padrão de fábrica');
});

test('a pasta de dados do app segue a convenção de cada sistema', () => {
  assert.match(userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\R' }, home: 'C:\\h' }), /C:\\R/);
  assert.match(userDataDir({ platform: 'darwin', env: {}, home: '/Users/ana' }), /Library[/\\]Application Support/);
  assert.match(userDataDir({ platform: 'linux', env: {}, home: '/home/ana' }), /\.config/);
});

test('settings.json ausente ou quebrado devolve vazio, e não exceção', () => {
  assert.equal(outputDirFrom(path.join(out, 'nao-existe')), '');
  const ruim = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ruim-'));
  fs.writeFileSync(path.join(ruim, 'settings.json'), '{ isto não é json', 'utf-8');
  assert.equal(outputDirFrom(ruim), '');
  fs.writeFileSync(path.join(ruim, 'settings.json'), '{"outputDir":"  D:\\\\X  "}', 'utf-8');
  assert.equal(outputDirFrom(ruim), 'D:\\X');
  fs.rmSync(ruim, { recursive: true, force: true });
});

// --- Listagens --------------------------------------------------------------

test('a visão geral conta o que existe sem abrir nada', () => {
  const r = tools.overview(out);
  assert.equal(r.projetos, 1);
  assert.equal(r.reunioes, 4);
  assert.equal(r.tarefasAbertas, 1);
});

test('o projeto vem com o contexto, que é a descrição que existe dele', () => {
  const [p] = tools.listProjects(out);
  assert.equal(p.nome, 'Onboarding');
  assert.equal(p.contexto, 'O fluxo de entrada de clientes.');
  assert.equal(p.reunioes, 1);
});

test('a listagem de reuniões não devolve uma única linha de transcrição', () => {
  const r = tools.listMeetings(out);
  assert.equal(r.total, 4);
  const texto = JSON.stringify(r);
  assert.ok(!texto.includes('Bom dia, vamos fechar o escopo'), 'a fala vazou para a listagem');
  // Mas diz onde há análise: é o que permite escolher sem abrir.
  const kickoff = r.reunioes.find((m) => m.nome === 'Kickoff do Onboarding');
  assert.equal(kickoff.temAnalise, true);
  assert.equal(r.reunioes.find((m) => m.nome === 'Retrospectiva sem análise').temAnalise, false);
});

test('filtrar por projeto aceita o nome, não só o id', () => {
  const r = tools.listMeetings(out, { projeto: 'Onboarding' });
  assert.equal(r.total, 1);
  assert.equal(r.reunioes[0].nome, 'Kickoff do Onboarding');
});

// --- Uma reunião ------------------------------------------------------------

test('a reunião vem com a análise inteira e o tamanho da transcrição', () => {
  const r = tools.getMeeting(out, { reuniao: 'Kickoff do Onboarding' });
  assert.equal(r.projeto, 'Onboarding');
  assert.equal(r.analise.decisoes[0].text, 'Adiar o e-mail de confirmação.');
  assert.equal(r.analise.tarefas[0].title, 'Ajustar o e-mail');
  assert.equal(r.transcricao.linhas, 3);
  // O contexto do projeto viaja junto: sem ele o modelo interpreta a reunião
  // sem saber do que o projeto trata.
  assert.match(r.contextoDoProjeto, /entrada de clientes/);
});

test('reunião sem análise diz que não tem, em vez de devolver estrutura vazia', () => {
  const r = tools.getMeeting(out, { reuniao: 'Retrospectiva sem análise' });
  assert.equal(r.analise, null);
  assert.match(r.nota, /ainda não foi analisada/);
});

test('o nome pode vir sem acento e pela metade', () => {
  assert.equal(tools.getMeeting(out, { reuniao: 'retrospectiva sem analise' }).nome, 'Retrospectiva sem análise');
  assert.equal(tools.getMeeting(out, { reuniao: 'kickoff' }).nome, 'Kickoff do Onboarding');
});

test('nome ambíguo recusa escolher e mostra os candidatos', () => {
  assert.throws(
    () => tools.getMeeting(out, { reuniao: 'Weekly' }),
    (err) => /casa com 2 reuniões/.test(err.message)
      && err.message.includes('Weekly Produto')
      && err.message.includes('Weekly Engenharia'),
  );
});

test('nome inexistente diz qual ferramenta usar em seguida', () => {
  assert.throws(
    () => tools.getMeeting(out, { reuniao: 'Não existe' }),
    /synapse_list_meetings/,
  );
});

// --- Transcrição ------------------------------------------------------------

test('a transcrição sai paginada e diz por onde continuar', () => {
  const p1 = tools.readTranscript(out, { reuniao: 'Kickoff do Onboarding', linhas: 2 });
  assert.equal(p1.totalDeLinhas, 3);
  assert.equal(p1.de, 1);
  assert.equal(p1.ate, 2);
  assert.equal(p1.faltam, 1);
  assert.equal(p1.proximoInicio, 3);
  assert.match(p1.texto, /Bom dia/);
  assert.ok(!p1.texto.includes('até sexta'), 'a página trouxe mais do que devia');

  const p2 = tools.readTranscript(out, { reuniao: 'Kickoff do Onboarding', inicio: p1.proximoInicio });
  assert.match(p2.texto, /até sexta/);
  assert.equal(p2.faltam, 0);
  assert.equal(p2.proximoInicio, null, 'a última página ainda prometia continuação');
});

test('o pedido de linhas tem teto — um número absurdo não vira leitura absurda', () => {
  const r = tools.readTranscript(out, { reuniao: 'Kickoff do Onboarding', linhas: 999999 });
  assert.equal(r.totalDeLinhas, 3);   // não estoura, só devolve o que há
  assert.equal(tools.LINHAS_MAX, 2000);
});

// --- Busca ------------------------------------------------------------------

test('a busca acha sem acento e devolve trecho, não o arquivo', () => {
  const r = tools.searchTranscripts(out, { termo: 'decisao' });
  assert.equal(r.reunioesComOTermo, 1);
  const achado = r.resultados[0];
  assert.equal(achado.reuniao, 'Kickoff do Onboarding');
  assert.match(achado.trechos[0], /decisão foi adiar/);
  // O trecho é um recorte: não pode conter a transcrição inteira.
  assert.ok(achado.trechos[0].length < 400, 'o trecho veio grande demais');
});

test('a busca pode ser presa a um projeto', () => {
  assert.equal(tools.searchTranscripts(out, { termo: 'weekly' }).reunioesComOTermo, 2);
  assert.equal(
    tools.searchTranscripts(out, { termo: 'weekly', projeto: 'Onboarding' }).reunioesComOTermo,
    0,
  );
});

test('busca sem termo é recusada em vez de devolver tudo', () => {
  assert.throws(() => tools.searchTranscripts(out, { termo: '  ' }), /Diga o que procurar/);
});

// --- Tarefas ----------------------------------------------------------------

test('a tarefa aponta o projeto pelo nome e a reunião de origem', () => {
  const r = tools.listTasks(out, {});
  assert.equal(r.total, 1);
  assert.equal(r.tarefas[0].projeto, 'Onboarding');
  assert.equal(r.tarefas[0].daReuniao, 'Kickoff do Onboarding');
  assert.equal(r.tarefas[0].responsavel, 'Bruno');
});

// --- O protocolo ------------------------------------------------------------

test('o servidor se apresenta e lista as ferramentas com esquema', async () => {
  const init = await server.handle({ method: 'initialize' });
  assert.equal(init.serverInfo.name, 'synapse');
  assert.equal(init.protocolVersion, server.PROTOCOL_VERSION);

  const { tools: lista } = await server.handle({ method: 'tools/list' });
  assert.ok(lista.length >= 7, 'o servidor deveria expor as sete leituras');
  for (const t of lista) {
    assert.ok(t.name.startsWith('synapse_'), `ferramenta fora do namespace: ${t.name}`);
    assert.ok(t.description.length > 60, `descrição curta demais em ${t.name}`);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(!('run' in t), `${t.name} vazou a implementação para o protocolo`);
  }
});

test('nenhuma ferramenta escreve: o servidor é só de leitura', async () => {
  const { tools: lista } = await server.handle({ method: 'tools/list' });
  const escrita = lista.filter((t) => /create|delete|write|update|rename|remove/i.test(t.name));
  assert.deepEqual(escrita, [], `ferramenta de escrita exposta: ${escrita.map((t) => t.name)}`);
});

test('método desconhecido vira erro de protocolo, não exceção', async () => {
  assert.equal(await server.handle({ method: 'nada/disso' }), null);
});

test('ferramenta inexistente volta como isError legível', async () => {
  const r = await server.callTool('synapse_inventada', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Ferramenta desconhecida/);
});

test('erro de ferramenta vira resultado com isError, para o modelo poder se corrigir', async () => {
  process.env.SYNAPSE_OUTPUT_DIR = out;
  try {
    const r = await server.callTool('synapse_get_meeting', { reuniao: 'Weekly' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /casa com 2 reuniões/);
  } finally {
    delete process.env.SYNAPSE_OUTPUT_DIR;
  }
});

test('uma chamada de verdade atravessa o protocolo e devolve JSON legível', async () => {
  process.env.SYNAPSE_OUTPUT_DIR = out;
  try {
    const r = await server.callTool('synapse_overview', {});
    assert.ok(!r.isError);
    const dados = JSON.parse(r.content[0].text);
    assert.equal(dados.reunioes, 4);
    assert.equal(dados.projetos, 1);
  } finally {
    delete process.env.SYNAPSE_OUTPUT_DIR;
  }
});
