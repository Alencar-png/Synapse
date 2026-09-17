'use strict';

/**
 * Mock da window.api — SÓ para rodar o frontend fora do Electron.
 *
 * No app real o preload.js define window.api antes; aí este arquivo é inerte.
 * Fora do Electron ele simula todo o backend do Synapse: projetos, reuniões,
 * tarefas estruturadas, pipeline de processamento, chat RAG e configurações.
 * Também documenta o contrato que o processo principal precisa expor.
 */

(function mockApi() {
  if (window.api) return;

  const listeners = new Map();
  const on = (ch, fn) => {
    if (!listeners.has(ch)) listeners.set(ch, []);
    listeners.get(ch).push(fn);
  };
  const emit = (ch, payload) => {
    for (const fn of listeners.get(ch) || []) fn(payload);
  };

  let settings = {
    outputDir: 'C:\\Users\\voce\\Synapse',
    engine: 'native',
    nativeModel: 'models/ggml-large-v3.bin',
    model: 'large-v3',
    language: 'pt',
    diarize: true,
    steps: { kanban: true, documento: true },
    tts: { engine: 'system', voice: 'pt-BR-FranciscaNeural', rate: '+5%', systemVoice: '' },
  };

  let seq = 100;
  const nid = (p) => `${p}-${seq++}`;

  const mockPrompts = {
    analise: {
      label: 'Análise da reunião (documento e tarefas)',
      text: 'Leia `{{TRANSCRICAO}}` e grave a análise da reunião em `{{JSON}}`.\n\n## Contexto\n\n{{CONTEXTO}}',
      placeholders: ['{{TRANSCRICAO}}', '{{CONTEXTO}}', '{{JSON}}'],
      required: ['{{TRANSCRICAO}}', '{{JSON}}'],
      custom: null,
    },
  };

  // O fluxo depois da transcrição. Na demonstração vem com a análise embutida
  // e uma etapa de exemplo, para a tela mostrar como o encadeamento aparece.
  let mockFlow = [
    {
      id: 'analise',
      name: 'Análise da reunião',
      description: 'Lê a transcrição uma vez e devolve o JSON que vira os cards do Kanban e a tabela do documento.',
      prompt: mockPrompts.analise.text,
      input: 'transcricao',
      output: 'analise',
      fileName: 'analise.json',
      skill: '',
      enabled: true,
      builtin: true,
    },
  ];

  const chatLog = new Map();   // projectId → mensagens
  let projects = [
    { id: 'p-alpha', name: 'Projeto Alpha', workdir: 'C:\\code\\alpha', chatBypass: false, context: 'Plataforma de autenticação e onboarding. Time: Ana (PM), Bruno (backend), Carla (frontend). Documentos vão para o time todo: linguagem direta, sem jargão executivo.' },
    { id: 'p-beta', name: 'Projeto Beta', context: 'Migração da infraestrutura para a AWS. Decisões técnicas devem citar custo estimado.' },
  ];

  const T = [
    '[00:00:04] Ana: Bom dia, gente. Vamos começar pela revisão das metas da semana passada.',
    '[00:00:19] Bruno: A migração do banco terminou ontem à noite. Ficou faltando só o índice de busca.',
    '[00:01:02] Ana: Ótimo. E o onboarding novo, como ficou o teste com os cinco primeiros usuários?',
    '[00:01:33] Carla: Dois travaram na etapa do convite. O e-mail de confirmação está caindo em spam.',
    '[00:02:10] Bruno: Consigo ajustar o SPF hoje ainda. É configuração, não é código.',
    '[00:02:41] Ana: Fechado. Bruno ajusta o e-mail, Carla refaz o teste na quinta.',
    '[00:03:12] Carla: Combinado. Trago os números na próxima weekly.',
  ].join('\n\n');

  const now = Date.now();
  const H = 3600 * 1000;

  let meetings = [
    {
      id: 'm-1808', projectId: 'p-alpha', name: 'Weekly Produto 18/08',
      recordedAt: now - 4 * H, duration: 3480, segments: 214,
      model: 'large-v3-turbo', language: 'pt', source: 'weekly-produto.mkv',
      hasDocumento: true, transcript: T,
      concepts: ['Autenticação', 'Onboarding'],
      insights: ['a equipe optou por **OAuth2** no lugar do JWT decidido antes', 'o e-mail de confirmação do onboarding está caindo em spam'],
    },
    {
      id: 'm-1208', projectId: 'p-alpha', name: 'Decisão de arquitetura 12/08',
      recordedAt: now - 6 * 24 * H, duration: 2712, segments: 158,
      model: 'large-v3-turbo', language: 'pt', source: 'arquitetura.mp4',
      hasDocumento: false, transcript: T,
      concepts: ['Autenticação', 'API'],
      insights: ['foi decidido utilizar **JWT** inicialmente para a autenticação'],
    },
    {
      id: 'm-0908', projectId: 'p-beta', name: 'Kickoff migração AWS',
      recordedAt: now - 9 * 24 * H, duration: 5405, segments: 341,
      model: 'large-v3', language: 'pt', source: 'kickoff-aws.mkv',
      hasDocumento: false, transcript: T,
      concepts: ['Deploy AWS', 'Custos'],
      insights: ['o deploy será feito por etapas, começando pelo serviço de mídia'],
    },
    {
      id: 'm-solo', projectId: '', name: 'Conversa com fornecedor',
      recordedAt: now - 12 * 24 * H, duration: 1934, segments: 96,
      model: 'large-v3-turbo', language: 'pt', source: 'fornecedor.mkv',
      hasDocumento: false, transcript: T, concepts: [], insights: [],
    },
  ];

  let tasks = [
    { id: 't-42', projectId: 'p-alpha', meetingId: 'm-1808', title: 'Implementar OAuth2', description: 'Substituir o fluxo JWT pelo OAuth2 decidido na weekly.', assignee: 'Bruno', priority: 'high', status: 'doing', createdAt: now - 4 * H },
    { id: 't-43', projectId: 'p-alpha', meetingId: 'm-1808', title: 'Corrigir SPF do e-mail de convite', description: 'E-mails de confirmação caindo em spam no onboarding.', assignee: 'Bruno', priority: 'high', status: 'backlog', createdAt: now - 4 * H },
    { id: 't-44', projectId: 'p-alpha', meetingId: 'm-1808', title: 'Refazer teste de onboarding', description: 'Repetir o teste com 5 usuários após o ajuste do e-mail.', assignee: 'Carla', priority: 'medium', status: 'backlog', createdAt: now - 4 * H },
    { id: 't-30', projectId: 'p-alpha', meetingId: 'm-1208', title: 'Definir escopo do endpoint de auth', description: '', assignee: 'Ana', priority: 'low', status: 'done', createdAt: now - 6 * 24 * H },
    { id: 't-50', projectId: 'p-beta', meetingId: 'm-0908', title: 'Levantar custo do S3 + CloudFront', description: '', assignee: 'Bruno', priority: 'medium', status: 'doing', createdAt: now - 9 * 24 * H },
  ];

  const projOf = (id) => projects.find((p) => p.id === id) || null;
  const publicMeeting = (m) => ({ ...m, project: projOf(m.projectId) });

  let jobTimers = [];
  const clearJob = () => { jobTimers.forEach(clearTimeout); jobTimers = []; };

  /** Pipeline simulado: áudio → transcrição → export → extração (resumo + tasks). */
  function runPipeline({ name, projectId, source, recordedAt = 0, autoName = false }) {
    clearJob();
    const stages = [
      ...Array.from({ length: 3 }, (_, i) => ({ at: 250 + i * 300, key: 'audio', progress: (i + 1) * 33.4 })),
      ...Array.from({ length: 8 }, (_, i) => ({ at: 1400 + i * 380, key: 'transcription', progress: (i + 1) * 12.5, detail: `whisper.cpp · segmento ${i * 21 + 4}` })),
      { at: 4600, key: 'export', progress: 100 },
      { at: 5100, key: 'analyze', progress: 40, detail: 'Claude lendo a transcrição' },
      { at: 6100, key: 'analyze', progress: 100, detail: 'análise pronta' },
    ];
    for (const s of stages) {
      jobTimers.push(setTimeout(() => emit('job:event', { event: 'stage', ...s }), s.at));
    }
    jobTimers.push(setTimeout(() => {
      const meeting = {
        id: nid('m'), projectId: projectId || '',
        // Sem nome escrito na tela de gravação, a análise batiza a reunião.
        name: autoName ? 'Onboarding — ajustes no e-mail de confirmação' : name,
        recordedAt: recordedAt || Date.now(), duration: 1934, segments: 118,
        model: 'large-v3-turbo', language: settings.language, source,
        hasDocumento: true, transcript: T,
        concepts: ['Onboarding'],
        insights: ['ficou combinado repetir o teste de onboarding na quinta'],
      };
      meetings.unshift(meeting);
      // AI-02: as ações extraídas viram cards automaticamente — se a etapa
      // do Kanban estiver ligada em Configurações.
      const created = projectId && settings.steps.kanban ? [
        { id: nid('t'), projectId, meetingId: meeting.id, title: 'Ajustar e-mail de confirmação', description: 'Extraída automaticamente da reunião.', assignee: 'Bruno', priority: 'high', status: 'backlog', createdAt: Date.now() },
        { id: nid('t'), projectId, meetingId: meeting.id, title: 'Repetir teste com 5 usuários', description: 'Extraída automaticamente da reunião.', assignee: 'Carla', priority: 'medium', status: 'backlog', createdAt: Date.now() },
      ] : [];
      tasks.push(...created);
      // O documento, se ligado em Configurações, vem em seguida; a janela espera.
      const docs = ['documento'].filter((k) => settings.steps[k]);
      meeting.hasDocumento = false;
      emit('job:event', {
        event: 'done',
        meetingId: meeting.id,
        tasksCreated: created.length,
        renamedTo: autoName ? meeting.name : '',
        docs,
      });
      if (docs.length) jobTimers.push(setTimeout(() => window.api.generateDoc({ meetingId: meeting.id, kinds: docs }), 900));
    }, 6600));
    return { started: true };
  }

  window.api = {
    on,

    // --- Configurações ---
    async getSettings() { return { ...settings }; },
    async setSettings(patch) { settings = { ...settings, ...patch }; return { ...settings }; },
    async enginesStatus() {
      return {
        active: settings.engine,
        // Na ordem que o motor entrega: do mais fiel para o mais leve.
        native: { ok: true, models: [
          { id: 'large-v3', path: 'models/ggml-large-v3.bin', sizeMB: 3095 },
          { id: 'large-v3-turbo', path: 'models/ggml-large-v3-turbo.bin', sizeMB: 1624 },
          { id: 'medium', path: 'models/ggml-medium.bin', sizeMB: 1533 },
        ] },
        docker: { ok: false, docker: true, version: '27.1', message: 'Imagem não construída (demonstração).' },
        platform: 'win32',
        systemAudio: true,
      };
    },
    async pickOutputDir() { return null; },
    async pickVideo() { return 'C:\\videos\\gravacao-demo.mkv'; },
    async pickTranscript() { return 'C:\\videos\\legenda-demo.srt'; },
    pathForFile(file) { return file?.name || ''; },
    async openPath() {},
    // Na demonstração não há disco nem Explorer: estes existem para nenhum
    // clique da interface encontrar um método ausente.
    async showInFolder() {},
    async readFile() {
      return {
        ok: true,
        text: '# Transcrição de demonstração\n\n**[00:00]** Bom dia a todos.\n',
      };
    },
    async downloadFile() { return { ok: false, message: 'Sem disco na demonstração.' }; },
    async importTranscript() {
      return { ok: false, message: 'A importação de transcrição não roda na demonstração.' };
    },
    async cancelDoc() { return { canceled: false }; },
    async dockerStatus() {
      return { docker: true, image: false, version: '27.1', message: 'Imagem não construída (demonstração).' };
    },
    async buildImage() { return { started: false, message: 'Sem Docker na demonstração.' }; },

    // --- Projetos ---
    async listProjects() {
      return projects.map((p) => ({
        ...p,
        meetings: meetings.filter((m) => m.projectId === p.id).length,
        openTasks: tasks.filter((t) => t.projectId === p.id && t.status !== 'done').length,
      }));
    },
    async saveProject({ id, name, context, workdir }) {
      const nome = String(name || '').trim();
      if (!nome) return { ok: false, message: 'Dê um nome ao projeto.' };
      if (id) {
        const p = projects.find((x) => x.id === id);
        if (!p) return { ok: false, message: 'Projeto não encontrado.' };
        p.name = nome; p.context = context || ''; if (workdir !== undefined) p.workdir = workdir;
        return { ok: true, id };
      }
      const novo = { id: nid('p'), name: nome, context: context || '' };
      projects.push(novo);
      return { ok: true, id: novo.id };
    },
    async deleteProject(id) {
      projects = projects.filter((p) => p.id !== id);
      meetings.forEach((m) => { if (m.projectId === id) m.projectId = ''; });
      tasks = tasks.filter((t) => t.projectId !== id);
      return { ok: true };
    },

    // --- Reuniões ---
    async listMeetings(projectId) {
      const list = projectId ? meetings.filter((m) => m.projectId === projectId) : meetings;
      return list.slice().sort((a, b) => b.recordedAt - a.recordedAt).map(publicMeeting);
    },
    async getMeeting(id) {
      const m = meetings.find((x) => x.id === id);
      return m ? publicMeeting(m) : null;
    },
    async renameMeeting(id, name) {
      const nome = String(name || '').trim();
      if (!nome) return { ok: false, message: 'Dê um nome à reunião.' };
      const m = meetings.find((x) => x.id === id);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      m.name = nome;
      return { ok: true, id };
    },
    async renameMeetingWithAi(id) {
      const m = meetings.find((x) => x.id === id);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      // A demonstração não chama o Claude: a espera é o que ela imita.
      await new Promise((r) => setTimeout(r, 1200));
      m.name = 'Onboarding — ajustes no e-mail de confirmação';
      return { ok: true, id, name: m.name };
    },
    async deleteMeeting(id) {
      meetings = meetings.filter((x) => x.id !== id);
      tasks.forEach((t) => { if (t.meetingId === id) t.meetingId = ''; });
      return { ok: true };
    },
    async assignProject(meetingId, projectId) {
      const m = meetings.find((x) => x.id === meetingId);
      if (!m) return { ok: false, message: 'Reunião não encontrada.' };
      m.projectId = projectId || '';
      return { ok: true };
    },

    // --- Tarefas (Kanban) ---
    async tasksForMeeting(meetingId) {
      return tasks.filter((t) => t.meetingId === meetingId);
    },
    async listTasks(projectId) {
      return tasks.filter((t) => t.projectId === projectId)
        .map((t) => ({ ...t, meeting: meetings.find((m) => m.id === t.meetingId) || null }));
    },
    async saveTask(data) {
      const title = String(data.title || '').trim();
      if (!title) return { ok: false, message: 'Dê um título à tarefa.' };
      if (data.id) {
        const t = tasks.find((x) => x.id === data.id);
        if (!t) return { ok: false, message: 'Tarefa não encontrada.' };
        Object.assign(t, data, { title });
        return { ok: true, id: t.id };
      }
      const nova = { ...data, title, id: nid('t'), createdAt: Date.now() };
      tasks.push(nova);
      return { ok: true, id: nova.id };
    },
    async moveTask(id, status) {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = status;
      return { ok: true };
    },
    async deleteTask(id) {
      tasks = tasks.filter((t) => t.id !== id);
      return { ok: true };
    },

    // --- Pipeline: importação e gravação ---
    async startJob({ videoPath, name, projectId }) {
      return runPipeline({ name, projectId, source: videoPath.split(/[\\/]/).pop() });
    },
    async processRecording({ projectId, name, duration, autoName, recordedAt }) {
      return runPipeline({
        name, projectId, autoName, recordedAt, source: `gravacao-${Math.round(duration)}s.wav`, duration,
      });
    },
    async cancelJob() {
      clearJob();
      emit('job:event', { event: 'canceled' });
    },

    // --- Documentos ---
    async generateDoc({ meetingId, kinds = ['documento'] }) {
      const passos = ['lendo a transcrição', 'estruturando o documento', 'convertendo em PDF'];
      const fila = kinds.flatMap((kind) => passos.map((description) => ({ kind, description })));
      let i = 0;
      const timer = setInterval(() => {
        if (i < fila.length) emit('doc:progress', fila[i++]);
        else {
          clearInterval(timer);
          const m = meetings.find((x) => x.id === meetingId);
          if (m && kinds.includes('documento')) m.hasDocumento = true;
          emit('doc:done', { ok: true, kinds, meetingId });
        }
      }, 700);
      return { started: true };
    },

    // --- Prompts editáveis ---
    async listPrompts() {
      return Object.entries(mockPrompts).map(([kind, { label }]) => ({ kind, label }));
    },
    async getPrompt(kind) {
      const spec = mockPrompts[kind];
      return { kind, label: spec.label, text: spec.custom ?? spec.text, isCustom: spec.custom != null, placeholders: spec.placeholders, required: spec.required };
    },
    async savePrompt(kind, text) {
      const spec = mockPrompts[kind];
      if (!text.trim()) return { ok: false, message: 'O prompt não pode ficar vazio.' };
      const faltando = spec.required.filter((ph) => !text.includes(ph));
      if (faltando.length) return { ok: false, message: `O prompt precisa manter ${faltando.join(', ')}.` };
      spec.custom = text === spec.text ? null : text;
      return { ok: true, isCustom: spec.custom != null };
    },
    async resetPrompt(kind) { mockPrompts[kind].custom = null; return { ok: true, isCustom: false }; },

    // --- Fluxo depois da transcrição ---
    async listFlow() {
      return {
        steps: mockFlow,
        placeholders: {
          '{{TRANSCRICAO}}': 'caminho do arquivo da transcrição',
          '{{ANALISE}}': 'caminho do analise.json desta reunião',
          '{{ANTERIOR}}': 'caminho da saída da etapa anterior',
          '{{SAIDA}}': 'caminho onde esta etapa deve gravar',
          '{{CONTEXTO}}': 'o contexto escrito no projeto',
          '{{REUNIAO}}': 'nome da reunião',
          '{{PROJETO}}': 'nome do projeto',
        },
      };
    },
    async saveFlow(steps) {
      const sujas = (steps || []).filter((s) => s.id !== 'analise');
      const semNome = sujas.find((s) => !String(s.name || '').trim());
      if (semNome) return { ok: false, message: 'A etapa precisa de um nome.' };
      const semSaida = sujas.find((s) => s.output === 'arquivo' && !String(s.prompt || '').includes('{{SAIDA}}') && !s.skill);
      if (semSaida) return { ok: false, message: 'O prompt precisa dizer onde gravar: use {{SAIDA}} no texto.' };
      mockFlow = (steps || []).map((s) => ({
        ...s,
        id: s.id || nid('etapa'),
        builtin: s.id === 'analise',
        enabled: s.enabled !== false,
        fileName: s.fileName || 'saida.md',
        skill: s.skill || '',
        description: s.description || '',
      }));
      return { ok: true, steps: mockFlow };
    },
    async newFlowStep() {
      return {
        id: '', name: 'Nova etapa', description: '', prompt: '', input: 'transcricao',
        output: 'arquivo', fileName: 'saida.md', skill: '', enabled: true, builtin: false,
      };
    },

    // --- OBS Studio ---
    async obsStatus() {
      // Na demonstração o OBS não está no ar: o app grava sozinho, e a tela de
      // Configurações mostra o caminho para ligá-lo.
      return {
        ok: false,
        enabled: Boolean(settings.obs?.enabled),
        message: 'Não achei o OBS em 127.0.0.1:4455. Abra o OBS e ligue Ferramentas → Configurações do Servidor WebSocket → Ativar servidor WebSocket.',
      };
    },
    async obsStart() { return { ok: false, message: 'OBS indisponível na demonstração.' }; },
    async obsStop() { return { ok: false, message: 'OBS indisponível na demonstração.' }; },
    async obsRecordingStatus() { return { ok: false, message: 'OBS indisponível na demonstração.' }; },
    async obsPause() { return { ok: false, message: 'OBS indisponível na demonstração.' }; },
    async obsProcess() { return { started: false, message: 'OBS indisponível na demonstração.' }; },

    // --- Atualização do app ---
    async updateVersion() { return { ok: true, commit: 'mock123', date: new Date().toISOString(), subject: 'mock', branch: 'master' }; },
    async updateCheck() {
      await new Promise((r) => setTimeout(r, 600));
      return { ok: true, behind: 2, ahead: 0, dirty: false, changes: ['feat: minimizar a tela de processamento', 'fix: acento no nome'], message: '2 atualizações disponíveis.' };
    },
    async updateApply() {
      for (const linha of ['Trazendo 2 commit(s) de origin/master…', 'Atualizado: mock123 → mock456.']) {
        await new Promise((r) => setTimeout(r, 500));
        emit('update:log', linha);
      }
      return { ok: true, updated: true, message: 'Atualizado. Reinicie o Synapse para usar a nova versão.' };
    },
    async updateRestart() { window.location.reload(); },

    // --- Chat do projeto (Claude Code simulado) ---
    async chatHistory(projectId) { return chatLog.get(projectId) || []; },
    async chatSend({ projectId, text }) {
      const p = projects.find((x) => x.id === projectId);
      const log = chatLog.get(projectId) || [];
      log.push({ role: 'user', text, tools: [] });
      chatLog.set(projectId, log);
      const passos = [
        { kind: 'tool', label: 'lendo Weekly produto.md' },
        { kind: 'text', text: 'Olhei a última reunião do projeto.' },
        { kind: 'tool', label: p?.chatBypass ? 'executando: git status' : 'buscando "onboarding"' },
      ];
      (async () => {
        for (const ev of passos) { await new Promise((r) => setTimeout(r, 700)); emit('chat:event', { projectId, ...ev }); }
        await new Promise((r) => setTimeout(r, 700));
        const resposta = `Olhei a última reunião do projeto.\n\nSobre **${text}**: na reunião de 18/08 ficou combinado repetir o teste de onboarding na quinta. Há 1 tarefa aberta ligada a isso.`;
        log.push({ role: 'ai', text: resposta, tools: passos.filter((e) => e.kind === 'tool').map((e) => e.label), bypass: Boolean(p?.chatBypass) });
        emit('chat:event', { projectId, kind: 'done', ok: true, text: resposta });
      })();
      return { ok: true };
    },
    async chatStop() { return { stopped: true }; },
    async chatClear(projectId) { chatLog.delete(projectId); return { ok: true }; },
    async chatSetBypass({ projectId, enabled }) {
      const p = projects.find((x) => x.id === projectId);
      if (p) p.chatBypass = enabled;
      return { ok: true };
    },
    async pickWorkdir() { return 'C:\\Users\\voce\\code\\projeto'; },
    async ttsSpeak() { return { ok: false, fallback: true, message: '' }; },
    async ttsOptions() {
      return {
        voices: [{ id: 'pt-BR-FranciscaNeural', label: 'Francisca — feminina, natural' }, { id: 'pt-BR-AntonioNeural', label: 'Antônio — masculina, natural' }],
        rates: [{ id: '+0%', label: 'normal' }, { id: '+5%', label: 'um pouco mais rápido' }],
      };
    },
    async chatTranscribe() {
      await new Promise((r) => setTimeout(r, 900));
      return { ok: true, text: 'O que ficou decidido na última reunião?' };
    },
  };
})();
