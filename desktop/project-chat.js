'use strict';

/**
 * O chat do projeto é o Claude Code rodando com o contexto daquele projeto.
 *
 * Cada mensagem vira um `claude -p` na pasta de trabalho do projeto, com um
 * system prompt que diz o que é o projeto, onde estão as reuniões (transcrição,
 * análise, PDF) e quais tarefas estão abertas. A conversa continua entre
 * mensagens — e entre aberturas do app — pela sessão do próprio Claude Code
 * (`--session-id` na primeira, `--resume` nas seguintes).
 *
 * Dois modos, escolhidos por projeto:
 * - **leitura**: só ferramentas que não mudam nada (Read, Glob, Grep, web).
 *   O Claude responde e consulta; não executa.
 * - **autônomo**: `--dangerously-skip-permissions`. O Claude age na máquina
 *   sem pedir — é o assistente pessoal que o usuário pediu, e por isso fica
 *   desligado por padrão, por projeto, com confirmação ao ligar.
 *
 * Este módulo só monta argumentos, prompt e traduz eventos: nada aqui abre
 * processo, para poder ser testado.
 */

const path = require('node:path');

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/**
 * O system prompt: quem o Claude é aqui e o que tem à mão.
 *
 * Caminhos vão inteiros, para ele abrir a transcrição certa com Read em vez
 * de procurar. Tarefas vão com id e status; sem API de escrita, o que ele pode
 * fazer é ler e sugerir — o texto diz isso para não prometer o que não faz.
 */
function buildChatSystemPrompt({
  project, meetings = [], tasks = [], meetingsDir, workdir, bypass,
}) {
  const linhas = [
    'Você é o assistente do Synapse — o segundo cérebro de quem usa o app — trabalhando dentro de um projeto.',
    'Responda em português do Brasil, direto e concreto. Quando a resposta vier de uma reunião ou tarefa, diga qual.',
    '',
    `## Projeto: ${project.name}`,
  ];
  if (project.context?.trim()) {
    linhas.push('', 'Contexto escrito pela pessoa:', '', '```', project.context.trim(), '```');
  }

  linhas.push('', '## Onde as coisas estão', '');
  linhas.push(`- Pasta de trabalho (seu diretório atual): ${workdir}`);
  if (meetingsDir && meetingsDir !== workdir) linhas.push(`- Reuniões deste projeto: ${meetingsDir}`);
  // O banco fica fora do alcance de propósito: ele guarda o Kanban, o contexto
  // e a conversa de todos os projetos, e este chat é de um só. O que interessa
  // deste projeto já vem no prompt, abaixo.
  linhas.push('- O Kanban não é um arquivo que você abre: as tarefas deste projeto estão listadas abaixo. Para mudar alguma, diga à pessoa o que faria.');

  if (meetings.length) {
    linhas.push('', `## Reuniões do projeto (${meetings.length})`, '');
    for (const m of meetings) {
      const partes = [`- **${m.name}**${m.recordedAt ? ` (${fmtDate(m.recordedAt)})` : ''}`];
      if (m.transcriptPath) partes.push(`  - transcrição: ${m.transcriptPath}`);
      if (m.analysisPath) partes.push(`  - análise (JSON com resumo, decisões e tarefas): ${m.analysisPath}`);
      if (m.documentPath) partes.push(`  - documento PDF: ${m.documentPath}`);
      linhas.push(...partes);
    }
  } else {
    linhas.push('', '## Reuniões do projeto', '', 'Nenhuma ainda.');
  }

  const abertas = tasks.filter((t) => t.status !== 'done');
  if (abertas.length) {
    linhas.push('', `## Tarefas abertas no Kanban (${abertas.length})`, '');
    for (const t of abertas) {
      const quem = t.assignee ? ` — ${t.assignee}` : '';
      const origem = t.meeting?.name ? ` (da reunião "${t.meeting.name}")` : '';
      linhas.push(`- [${t.status}] ${t.title}${quem}${origem}`);
    }
  }

  linhas.push('', '## Como agir', '');
  if (bypass) {
    linhas.push(
      'Você está em modo autônomo: pode ler, escrever e executar comandos nesta máquina sem pedir permissão.',
      'Use isso a favor da pessoa: quando a tarefa envolver a máquina (arquivos, código, comandos), faça e conte o que fez.',
      'Antes de algo destrutivo ou difícil de desfazer (apagar, sobrescrever, enviar), diga o que vai fazer e por quê.',
    );
  } else {
    linhas.push(
      'Você está em modo leitura: pode ler arquivos e pesquisar, mas não escrever nem executar comandos.',
      'Se a pessoa pedir uma ação na máquina, explique o que faria e lembre que o modo autônomo pode ser ligado no chat.',
    );
  }
  return linhas.join('\n');
}

/**
 * Argumentos do `claude -p` para uma mensagem do chat.
 *
 * O system prompt vai por arquivo (`--append-system-prompt-file`): como
 * argumento, um texto grande com aspas e barras não sobrevive à linha de
 * comando do Windows. A mensagem em si vai por stdin.
 */
function buildChatArgs({ sessionId, resume, bypass, systemPromptFile, addDirs = [], model }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push(resume ? '--resume' : '--session-id', sessionId);
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (model) args.push('--model', model);
  if (bypass) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY_TOOLS.join(','));
  }
  return args;
}

/**
 * Só o nome do arquivo, venha o caminho em que separador vier.
 *
 * `path.basename` usa o separador da plataforma em que o app roda, e num Linux
 * ele não reconhece a barra invertida: um caminho do Windows voltaria inteiro
 * para a tela, no lugar do nome curto que a linha promete.
 */
function nomeDoArquivo(caminho) {
  return String(caminho).split(/[/\\]/).filter(Boolean).pop() || '';
}

/** O que dizer na tela quando o Claude usa uma ferramenta. */
function describeTool(name, input = {}) {
  const alvo = input.file_path || input.path || input.pattern || input.command || input.url || input.query || '';
  const curto = typeof alvo === 'string' && alvo.length > 90 ? `${alvo.slice(0, 87)}…` : alvo;
  switch (name) {
    case 'Read': return `lendo ${nomeDoArquivo(curto) || 'arquivo'}`;
    case 'Write': return `escrevendo ${nomeDoArquivo(curto) || 'arquivo'}`;
    case 'Edit': return `editando ${nomeDoArquivo(curto) || 'arquivo'}`;
    case 'Glob': return `procurando ${curto}`;
    case 'Grep': return `buscando "${curto}"`;
    case 'Bash': return `executando: ${curto}`;
    case 'WebSearch': return `pesquisando na web: ${curto}`;
    case 'WebFetch': return `abrindo ${curto}`;
    default: return `usando ${name}`;
  }
}

/**
 * Traduz uma linha do stream-json num evento para a janela, ou null.
 *
 * - `text`: um trecho de resposta do assistente.
 * - `tool`: uma ferramenta em uso (o que ele está fazendo agora).
 * - `result`: fim da rodada, com o texto final, a sessão e se deu erro.
 */
function describeChatEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'assistant') {
    const saida = [];
    for (const block of event.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) saida.push({ kind: 'text', text: block.text });
      if (block.type === 'tool_use') saida.push({ kind: 'tool', label: describeTool(block.name, block.input) });
    }
    return saida.length ? saida : null;
  }
  if (event.type === 'result') {
    return [{
      kind: 'result',
      text: typeof event.result === 'string' ? event.result : '',
      sessionId: event.session_id || '',
      isError: Boolean(event.is_error),
    }];
  }
  return null;
}

/** O erro do `--resume` quando a sessão não existe mais: vale recomeçar. */
function isMissingSession(stderr) {
  return /no conversation found|session.*not found|could not find session/i.test(String(stderr || ''));
}

module.exports = {
  READ_ONLY_TOOLS,
  buildChatArgs,
  buildChatSystemPrompt,
  describeChatEvent,
  describeTool,
  isMissingSession,
};
