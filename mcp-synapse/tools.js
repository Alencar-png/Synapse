'use strict';

/**
 * A leitura do workspace do Synapse, em funções puras de efeito.
 *
 * Tudo aqui **só lê**. O servidor MCP é uma janela para o que o app gravou —
 * projetos, reuniões, análises, transcrições e tarefas — e não tem uma única
 * ferramenta que escreva. Quem cria reunião é o app; um assistente que também
 * pudesse apagá-las seria uma superfície de estrago sem contrapartida.
 *
 * Os módulos de dados são os do próprio app (`desktop/`), não cópias: o
 * formato da pasta de reunião e o esquema do banco são sutis (raízes por
 * projeto, ids compostos, o formato antigo de arquivos soltos), e uma segunda
 * implementação divergiria em silêncio na primeira mudança.
 *
 * O tema recorrente deste arquivo é **tamanho**. Uma reunião de duas horas
 * gera uma transcrição de 150 KB e 3 mil falas; devolvê-la inteira queima o
 * contexto de quem perguntou "o que ficou decidido?". Por isso a listagem
 * nunca traz texto, a busca devolve trechos e a transcrição sai paginada.
 */

const fs = require('node:fs');

const library = require('../desktop/library');
const workspace = require('../desktop/workspace');
const { analysisPath, readAnalysis } = require('../desktop/analysis');

// Quantas linhas de transcrição uma leitura devolve por padrão, e o teto de um
// pedido. 200 linhas são cerca de 15 minutos de conversa: o bastante para
// seguir um assunto sem inundar o contexto.
const LINHAS_PADRAO = 200;
const LINHAS_MAX = 2000;

// A busca devolve trechos, não arquivos: alguns por reunião, cada um com o
// suficiente em volta para a frase fazer sentido sozinha.
const TRECHOS_POR_REUNIAO = 5;
const CONTEXTO_CHARS = 160;
const REUNIOES_NA_BUSCA = 20;

/** Sem acento e em minúsculas: é como as pessoas procuram, e como comparamos. */
const dobrar = (texto) => String(texto || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase();

/** Data legível pelo modelo sem precisar converter epoch de cabeça. */
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');

const minutos = (segundos) => Math.round((Number(segundos) || 0) / 60);

/**
 * Acha uma reunião pelo que o modelo escreveu.
 *
 * Um assistente não guarda ids: ele repete o nome que viu na listagem, às
 * vezes sem acento, às vezes só um pedaço. Aceitar isso é a diferença entre a
 * ferramenta servir e obrigar a uma chamada de listagem antes de cada uso.
 *
 * Ambiguidade não é resolvida por chute: devolvemos os candidatos e deixamos
 * quem chamou escolher — silenciosamente pegar o primeiro daria a resposta
 * certa sobre a reunião errada.
 */
function acharReuniao(dir, termo) {
  const alvo = dobrar(termo);
  if (!alvo) throw new Error('Diga qual reunião (id ou nome).');

  const todas = library.listMeetings(dir);
  if (!todas.length) throw new Error('Não há reuniões neste workspace.');

  const exata = todas.find((m) => m.id === termo)
    || todas.find((m) => dobrar(m.id) === alvo)
    || todas.find((m) => dobrar(m.name) === alvo);
  if (exata) return exata;

  const parciais = todas.filter((m) => dobrar(m.name).includes(alvo));
  if (parciais.length === 1) return parciais[0];
  if (parciais.length > 1) {
    throw new Error(
      `"${termo}" casa com ${parciais.length} reuniões: ${parciais.map((m) => m.name).join(' | ')}. `
      + 'Repita com o nome completo.',
    );
  }
  throw new Error(`Nenhuma reunião chamada "${termo}". Use synapse_list_meetings para ver as que existem.`);
}

/** O mesmo para projetos, com a mesma tolerância e a mesma recusa a chutar. */
function acharProjeto(dir, termo) {
  const alvo = dobrar(termo);
  if (!alvo) return null;

  const todos = workspace.listProjects(dir);
  const exato = todos.find((p) => p.id === termo) || todos.find((p) => dobrar(p.name) === alvo);
  if (exato) return exato;

  const parciais = todos.filter((p) => dobrar(p.name).includes(alvo));
  if (parciais.length === 1) return parciais[0];
  if (parciais.length > 1) {
    throw new Error(
      `"${termo}" casa com ${parciais.length} projetos: ${parciais.map((p) => p.name).join(' | ')}.`,
    );
  }
  throw new Error(`Nenhum projeto chamado "${termo}". Use synapse_list_projects para ver os que existem.`);
}

/**
 * As linhas de fala da transcrição, sem o cabeçalho do arquivo.
 *
 * O que separa uma fala de um metadado é o colchete: a fala é
 * `**[00:12] Você:** texto`, o metadado é `**Idioma:** pt`. Casar o metadado
 * por "negrito com dois-pontos" pareceria certo e comeria todas as falas de
 * qualquer transcrição com falante marcado — que é o padrão do app.
 */
function linhasDaTranscricao(caminho) {
  const texto = fs.readFileSync(caminho, 'utf-8');
  return texto
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l
      && l !== '---'
      && !l.startsWith('# ')
      && !(l.startsWith('**') && !l.startsWith('**[')));
}

// --- As ferramentas ---------------------------------------------------------

/** Quanto há para ler, em números. É a pergunta de orientação, a mais barata. */
function overview(dir) {
  const resumo = workspace.overview(dir);
  return {
    pastaDeSaida: dir,
    projetos: resumo.projects,
    reunioes: resumo.meetings,
    tarefasAbertas: resumo.openTasks,
    horasTranscritas: Math.round((resumo.transcribedSeconds / 3600) * 10) / 10,
  };
}

function listProjects(dir) {
  return workspace.listProjects(dir).map((p) => ({
    id: p.id,
    nome: p.name,
    // O contexto é o que a pessoa escreveu para orientar o tom do que é
    // gerado; para quem lê de fora, é a descrição do projeto.
    contexto: p.context || '',
    reunioes: p.meetings,
    tarefasAbertas: p.openTasks,
    ultimaReuniao: iso(p.lastMeetingAt),
  }));
}

/**
 * As reuniões, sem uma linha de transcrição.
 *
 * O que sai daqui é a ficha: nome, quando, quanto tempo, de que projeto, e se
 * já tem análise. Com isso o modelo escolhe qual abrir — e só então paga o
 * preço de ler.
 */
function listMeetings(dir, { projeto = '', limite = 50 } = {}) {
  const alvo = projeto ? acharProjeto(dir, projeto) : null;
  const todas = workspace.listMeetings(dir, alvo?.id || '');
  const teto = Math.max(1, Math.min(200, Number(limite) || 50));

  return {
    total: todas.length,
    mostrando: Math.min(teto, todas.length),
    reunioes: todas.slice(0, teto).map((m) => ({
      id: m.id,
      nome: m.name,
      projeto: m.project?.name || '',
      gravadaEm: iso(m.recordedAt),
      duracaoMin: minutos(m.duration),
      falas: m.segments,
      temAnalise: Boolean(readAnalysis(analysisPathDe(dir, m.id))),
      temDocumento: m.hasDocumento,
    })),
  };
}

/** O caminho da análise de uma reunião, ou null quando ela é do formato antigo. */
function analysisPathDe(dir, meetingId) {
  const bruta = library.getMeeting(dir, meetingId);
  return bruta ? analysisPath(bruta.dir, bruta.legacy) : null;
}

/**
 * Uma reunião por inteiro — menos a transcrição.
 *
 * A análise é o que o Claude já extraiu quando a reunião foi processada:
 * visão geral, pontos, decisões, riscos, tarefas e pendências. Para quase toda
 * pergunta sobre uma reunião, isto responde sem ninguém precisar ler as 3 mil
 * falas — e o tamanho da transcrição vem junto para a decisão de ler ser
 * informada.
 */
function getMeeting(dir, { reuniao }) {
  const bruta = acharReuniao(dir, reuniao);
  const m = workspace.toMeeting(bruta, bruta.project);
  const analise = readAnalysis(analysisPath(bruta.dir, bruta.legacy));

  const ficha = {
    id: m.id,
    nome: m.name,
    projeto: m.project?.name || '',
    contextoDoProjeto: m.project?.context || '',
    gravadaEm: iso(m.recordedAt),
    duracaoMin: minutos(m.duration),
    falas: m.segments,
    idioma: m.language,
    modelo: m.model,
    arquivos: m.files.map((f) => f.name),
  };

  if (m.transcriptPath) {
    const linhas = linhasDaTranscricao(m.transcriptPath);
    ficha.transcricao = {
      linhas: linhas.length,
      lidaCom: 'synapse_read_transcript',
    };
  }

  if (!analise) {
    ficha.analise = null;
    ficha.nota = 'Esta reunião ainda não foi analisada — só a transcrição existe.';
    return ficha;
  }

  ficha.analise = {
    titulo: analise.title,
    visaoGeral: analise.overview,
    pontos: analise.topics,
    decisoes: analise.decisions,
    riscos: analise.risks,
    tarefas: analise.tasks,
    pendencias: analise.pending,
  };
  return ficha;
}

/**
 * A transcrição, em páginas.
 *
 * `inicio` é o número da primeira linha (base 1, como o arquivo se lê), e a
 * resposta diz sempre se sobrou coisa — sem isso, um modelo lê as primeiras
 * 200 linhas de uma reunião de duas horas e conclui sobre o começo achando que
 * viu o todo.
 */
function readTranscript(dir, { reuniao, inicio = 1, linhas = LINHAS_PADRAO } = {}) {
  const bruta = acharReuniao(dir, reuniao);
  if (!bruta.transcript) throw new Error(`"${bruta.name}" não tem arquivo de transcrição.`);

  const todas = linhasDaTranscricao(bruta.transcript);
  const de = Math.max(1, Number(inicio) || 1);
  const quantas = Math.max(1, Math.min(LINHAS_MAX, Number(linhas) || LINHAS_PADRAO));
  const pedaco = todas.slice(de - 1, de - 1 + quantas);
  const proxima = de + pedaco.length;

  return {
    reuniao: bruta.name,
    totalDeLinhas: todas.length,
    de,
    ate: de + pedaco.length - 1,
    faltam: Math.max(0, todas.length - (proxima - 1)),
    proximoInicio: proxima <= todas.length ? proxima : null,
    texto: pedaco.join('\n'),
  };
}

/**
 * Procura um termo nas transcrições de todas as reuniões.
 *
 * É a ferramenta que responde "o que foi dito sobre X" sem abrir reunião por
 * reunião. Devolve trechos com o texto em volta, nunca o arquivo: o valor está
 * em apontar onde olhar, e quem quiser o resto pede a transcrição daquele
 * ponto.
 *
 * A comparação ignora acento e caixa porque é assim que se procura em
 * português — quem digita "decisao" quer achar "decisão".
 */
function searchTranscripts(dir, { termo, projeto = '', limite = REUNIOES_NA_BUSCA } = {}) {
  // O `trim` é o que faz uma busca por espaço em branco ser recusada em vez
  // de casar com o texto inteiro de todas as reuniões.
  const alvo = dobrar(termo).trim();
  if (!alvo) throw new Error('Diga o que procurar.');

  const filtro = projeto ? acharProjeto(dir, projeto) : null;
  const reunioes = library.listMeetings(dir)
    .filter((m) => !filtro || m.project?.id === filtro.id);

  const achados = [];
  for (const m of reunioes) {
    if (!m.transcript) continue;

    // Só as falas: o cabeçalho traz o nome da reunião, o nome do arquivo e o
    // idioma, e casar ali devolvia um trecho que não diz nada — o nome da
    // reunião já vem no resultado, e não é isso que quem procura quer ler.
    let texto;
    try {
      texto = linhasDaTranscricao(m.transcript).join('\n');
    } catch {
      continue;   // arquivo sumiu entre a listagem e a leitura
    }

    // A busca é no texto dobrado, mas o trecho sai do original: devolver o
    // texto sem acento seria mostrar a conversa errada.
    const dobrado = dobrar(texto);
    const posicoes = [];
    let i = dobrado.indexOf(alvo);
    while (i !== -1 && posicoes.length < TRECHOS_POR_REUNIAO) {
      posicoes.push(i);
      i = dobrado.indexOf(alvo, i + alvo.length);
    }
    if (!posicoes.length) continue;

    achados.push({
      reuniao: m.name,
      projeto: m.project?.name || '',
      ocorrencias: dobrado.split(alvo).length - 1,
      trechos: posicoes.map((pos) => {
        const de = Math.max(0, pos - CONTEXTO_CHARS);
        const ate = Math.min(texto.length, pos + alvo.length + CONTEXTO_CHARS);
        const corte = texto.slice(de, ate).replace(/\s+/g, ' ').trim();
        return `${de > 0 ? '…' : ''}${corte}${ate < texto.length ? '…' : ''}`;
      }),
    });
  }

  const teto = Math.max(1, Math.min(50, Number(limite) || REUNIOES_NA_BUSCA));
  achados.sort((a, b) => b.ocorrencias - a.ocorrencias);
  return {
    termo,
    reunioesComOTermo: achados.length,
    resultados: achados.slice(0, teto),
  };
}

/** As tarefas do Kanban, que nasceram das reuniões ou foram criadas à mão. */
function listTasks(dir, { projeto = '', status = '' } = {}) {
  const alvo = projeto ? acharProjeto(dir, projeto) : null;
  const todas = workspace.listTasks(dir, alvo?.id || '');
  const filtradas = status ? todas.filter((t) => t.status === status) : todas;

  // A tarefa guarda o id do projeto, não o nome. Um id como
  // "projetos-internos-genesis" não diz nada a quem lê a resposta.
  const nomePorProjeto = new Map(workspace.listProjects(dir).map((p) => [p.id, p.name]));

  return {
    total: filtradas.length,
    tarefas: filtradas.map((t) => ({
      titulo: t.title,
      descricao: t.description || '',
      responsavel: t.assignee || '',
      prioridade: t.priority,
      status: t.status,
      projeto: nomePorProjeto.get(t.projectId) || '',
      daReuniao: t.meeting?.name || '',
    })),
  };
}

module.exports = {
  LINHAS_MAX,
  LINHAS_PADRAO,
  acharProjeto,
  acharReuniao,
  dobrar,
  getMeeting,
  listMeetings,
  listProjects,
  listTasks,
  overview,
  readTranscript,
  searchTranscripts,
};
