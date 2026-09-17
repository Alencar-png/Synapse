'use strict';

/**
 * Processo principal do app desktop.
 *
 * O trabalho pesado (ffmpeg + Whisper) roda fora daqui: no motor nativo
 * (Python do host + whisper.cpp com GPU) ou no container Docker (CPU). Este
 * processo só faz o spawn, lê os eventos JSONL do stdout e repassa à janela.
 */

const {
  app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell,
} = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  IMAGE_NAME,
  buildDockerArgs,
  buildNativeArgs,
  buildNativeEnv,
  explainNativeFailure,
  nativeStatus,
  toHostPath,
} = require('./engines');
const {
  analysisTmpPathFor,
  buildAnalysisPrompt,
  buildClaudeArgs,
  describeEvent,
  documentPdfPath,
  findClaude,
} = require('./claude-jobs');
const { analysisPath, normalizeAnalysis, readAnalysis, writeAnalysis } = require('./analysis');
const { renderDocumentHtml } = require('./document-html');
const library = require('./library');
const db = require('./db');
const projects = require('./projects');
const tasks = require('./tasks');
const workspace = require('./workspace');
const transcriptImport = require('./transcript-import');
const { readFileTolerant, unlinkTolerant } = require('./unicode-path');
const { dockerRemove, killTree } = require('./process-kill');
const { describeCancellation, planWorkCancellation } = require('./meeting-work');
const obs = require('./obs');
const flows = require('./flows');
const flowRunner = require('./flow-runner');
const promptsStore = require('./prompts-store');
const { createUpdater } = require('./updater');
const chatMessages = require('./chat-messages');
const voice = require('./voice');
const tts = require('./tts');
const {
  buildChatArgs, buildChatSystemPrompt, describeChatEvent, isMissingSession,
} = require('./project-chat');
const {
  DEFAULT_STEPS, DOC_KINDS, normalizeSteps, pendingDocKinds, planAfterTranscription,
} = require('./pipeline-steps');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Uma pasta de dados alternativa (testes de ponta a ponta): o app roda inteiro
// sem tocar nas configurações nem no banco de quem usa a máquina.
if (process.env.SYNAPSE_USER_DATA) app.setPath('userData', process.env.SYNAPSE_USER_DATA);

// Duas instâncias abririam dois handles no mesmo synapse.db e dois jobs
// disputariam a mesma pasta. A segunda só traz a primeira para a frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// Extensões aceitas no drop. Áudio também vale: o ffmpeg trata os dois.
const MEDIA_EXTENSIONS = [
  'mkv', 'mp4', 'mov', 'webm', 'avi', 'm4v', 'wmv', 'flv',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac',
];

const DEFAULT_SETTINGS = {
  outputDir: path.join(app.getPath('documents'), 'Transcricoes'),
  engine: 'native',    // 'native' (GPU) ou 'docker' (CPU)
  model: 'large-v3',   // modelo do motor docker — o mais fiel, não o mais rápido
  nativeModel: '',     // caminho do .bin escolhido no motor nativo
  language: 'pt',
  formats: ['md', 'txt'],
  // Marcar quem falou na transcrição, separando pelo canal do áudio: o
  // microfone desta máquina de um lado, o som da chamada do outro.
  diarize: true,
  // Gravação pelo OBS Studio, via o servidor MCP em mcp-obs/.
  obs: { ...obs.DEFAULT_OBS },
  // O que roda depois da transcrição; cada etapa liga e desliga sozinha.
  steps: { ...DEFAULT_STEPS },
  // A voz do assistente no chat: neural (Edge, online) ou a do sistema.
  tts: { ...tts.DEFAULT_TTS },
};

let mainWindow = null;
let currentJob = null;    // transcrição em andamento
let currentDocJob = null; // geração de PDF em andamento
let currentExtraction = null; // análise da reunião em andamento (fim do pipeline)
let currentChat = null;       // rodada do chat de projeto em andamento

// --- Configurações persistidas ---------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Prompts editados em Configurações. O padrão fica no app; o que a pessoa
// mudou fica aqui e vale por cima.
function userPromptsDir() {
  return path.join(app.getPath('userData'), 'prompts');
}

/**
 * O fluxo depois da transcrição, como a pessoa montou.
 *
 * Fica na pasta de dados do usuário, e não junto do app: atualizar o Synapse
 * nunca pode apagar as etapas que alguém escreveu. O prompt da análise não é
 * guardado aqui — ele mora em `prompts/analise.md` (e na edição feita em
 * Configurações), para não existir em duas versões.
 */
function flowPath() {
  return path.join(app.getPath('userData'), 'flows.json');
}

function loadFlow() {
  const analysisPrompt = promptsStore.readPrompt('analise', { userDir: userPromptsDir() }).text;
  try {
    return flows.normalizeFlow(JSON.parse(fs.readFileSync(flowPath(), 'utf-8')), { analysisPrompt });
  } catch {
    return flows.normalizeFlow(null, { analysisPrompt });   // ainda sem fluxo próprio
  }
}

function saveFlow(lista) {
  const analysisPrompt = promptsStore.readPrompt('analise', { userDir: userPromptsDir() }).text;
  const normalizado = flows.normalizeFlow(lista, { analysisPrompt });
  fs.mkdirSync(path.dirname(flowPath()), { recursive: true });
  // O prompt da análise sai antes de gravar: ele tem dono em outro arquivo.
  const paraGravar = normalizado.map((s) => (s.builtin ? { ...s, prompt: '' } : s));
  fs.writeFileSync(flowPath(), JSON.stringify(paraGravar, null, 2), 'utf-8');
  return normalizado;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const saved = JSON.parse(raw);
    // Uma etapa nova entra ligada mesmo em configurações gravadas antes dela.
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      steps: normalizeSteps(saved.steps),
      tts: tts.normalizeTts(saved.tts),
      obs: obs.normalizeObs(saved.obs),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

// --- Helpers de processo ----------------------------------------------------

/** Roda um comando e resolve com { code, stdout, stderr }. Nunca rejeita. */
function run(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function dockerStatus() {
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) {
    return {
      docker: false,
      image: false,
      message: 'Docker não está acessível. Abra o Docker Desktop e tente de novo.',
    };
  }
  const image = await run('docker', ['image', 'inspect', IMAGE_NAME, '--format', '{{.Id}}']);
  return {
    docker: true,
    image: image.code === 0,
    version: version.stdout,
    message: image.code === 0 ? '' : 'A imagem de transcrição ainda não foi construída.',
  };
}

/** Situação dos dois motores e qual deles pode rodar agora. */
async function enginesStatus() {
  const docker = await dockerStatus();
  const native = nativeStatus(PROJECT_ROOT);
  const settings = loadSettings();

  // Um motor indisponível não deve travar o app: se o escolhido não pode
  // rodar e o outro pode, o app usa o que funciona e diz isso na barra.
  const dockerOk = docker.docker && docker.image;
  let active = settings.engine;
  if (active === 'native' && !native.ok) active = dockerOk ? 'docker' : 'native';
  if (active === 'docker' && !dockerOk) active = native.ok ? 'native' : 'docker';

  return {
    active,
    chosen: settings.engine,
    native: { ...native, label: 'GPU (whisper.cpp)' },
    docker: { ...docker, ok: dockerOk, label: 'Docker (CPU)' },
    platform: process.platform,
    // Capturar o áudio que sai pelos alto-falantes é o que traz o outro lado
    // de uma chamada, e no Electron isso só existe no Windows. Fora dele a
    // janela ainda grava, mas só o microfone — e é o OBS que fecha a lacuna.
    systemAudio: process.platform === 'win32',
  };
}

// --- Janela -----------------------------------------------------------------

/**
 * Autoriza a janela a capturar o áudio que sai pelos alto-falantes.
 *
 * Numa reunião online o microfone só pega o nosso lado; o que a outra parte
 * fala vem pelo loopback do sistema. Pedimos a tela só porque o Chromium exige
 * uma fonte de vídeo junto — o renderer descarta essa trilha e grava só áudio.
 */
function enableSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback({});   // sem loopback: o renderer segue só com o microfone
    }
  }, { useSystemPicker: false });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 660,
    backgroundColor: '#070A14',
    title: 'Synapse',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Abre links externos no navegador do sistema, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --- Transcrição ------------------------------------------------------------

/**
 * Timestamp do renderer em ISO 8601 **local**, do jeito que o pipeline lê.
 *
 * Sem o `Z` e sem fuso de propósito: o `meeting.json` guarda a data local, e é
 * ela que a janela mostra. `toISOString()` daria UTC, e a reunião apareceria
 * três horas fora do lugar.
 */
function localIso(ms) {
  const data = new Date(Number(ms) || 0);
  if (!ms || Number.isNaN(data.getTime())) return '';
  const dois = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`
    + `T${dois(data.getHours())}:${dois(data.getMinutes())}:${dois(data.getSeconds())}`;
}

function startJob(payload) {
  if (currentJob) {
    return { started: false, message: 'Já existe uma transcrição em andamento.' };
  }

  const videoPath = payload.videoPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { started: false, message: 'Arquivo não encontrado.' };
  }
  const ext = path.extname(videoPath).slice(1).toLowerCase();
  if (!MEDIA_EXTENSIONS.includes(ext)) {
    return { started: false, message: `Formato .${ext} não é vídeo nem áudio.` };
  }

  const settings = loadSettings();
  // As reuniões de um projeto com pasta de trabalho nascem dentro dela; as
  // outras, na pasta de saída. O banco fica sempre na pasta de saída.
  const project = projects.getProject(settings.outputDir, payload.projectId || '');
  const outputDir = payload.outputDir || library.meetingsRootFor(settings.outputDir, project);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return { started: false, message: `Não foi possível usar a pasta de saída: ${err.message}` };
  }

  const language = payload.language || settings.language;
  const formats = payload.formats || settings.formats;
  const engine = payload.engine || settings.engine;
  const name = (payload.name || '').trim();
  // Só a gravação feita pelo app sabe a hora em que a reunião começou; um
  // vídeo importado não traz esse dado, e aí o pipeline lê o próprio arquivo.
  const recordedAt = localIso(payload.recordedAt);

  let child;
  let containerName = null;

  if (engine === 'native') {
    const native = nativeStatus(PROJECT_ROOT);
    const modelPath = payload.nativeModel || settings.nativeModel || native.models[0]?.path;
    if (!native.cli || !modelPath) {
      return { started: false, message: native.message || 'Motor nativo indisponível.' };
    }
    child = spawn(
      native.python,
      buildNativeArgs({ videoPath, outputDir, formats, name, recordedAt }),
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: {
          ...process.env,
          ...buildNativeEnv({
            cli: native.cli, modelPath, language, threads: 0, diarize: settings.diarize,
          }),
        },
      },
    );
  } else {
    containerName = `mp-transcribe-${Date.now()}`;
    child = spawn(
      'docker',
      buildDockerArgs({
        videoPath,
        outputDir,
        model: payload.model || settings.model,
        language,
        formats,
        containerName,
        name,
        recordedAt,
      }),
      { windowsHide: true },
    );
  }

  currentJob = {
    child, containerName, canceled: false, outputDir, engine,
    projectId: payload.projectId || '',
    autoName: Boolean(payload.autoName),   // deixa a IA nomear pelo conteúdo
    cleanup: payload.cleanup || '',        // gravação temporária, apagada no fim
  };

  let stdoutBuffer = '';
  let lastError = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // guarda a linha incompleta para o próximo chunk
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.event === 'done' && Array.isArray(event.files)) {
          event.files = event.files.map((f) => toHostPath(f, outputDir));
          const dir = loadSettings().outputDir;
          const projectId = currentJob?.projectId || '';
          // A reunião acabou de nascer: o id é a pasta que recebeu os arquivos,
          // com o projeto na frente quando nasceu na raiz dele.
          const pasta = workspace.meetingIdFromFiles(outputDir, event.files);
          const naRaizDoProjeto = path.resolve(outputDir) !== path.resolve(dir);
          event.meetingId = pasta ? library.meetingId(naRaizDoProjeto ? projectId : '', pasta) : '';
          if (event.meetingId && projectId) {
            projects.assignMeeting(dir, event.meetingId, projectId);
          }
          finishJob(event, dir, projectId, currentJob?.autoName);
          continue;   // o done é anunciado depois da análise
        }
        if (event.event === 'error') lastError = event.message;
        send('job:event', event);
      } catch {
        // Linha não-JSON no stdout: ignora em vez de derrubar o job.
      }
    }
  });

  // O log do Python vai para stderr; guardamos a última linha útil para o caso
  // de o processo morrer sem emitir um evento de erro.
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      lastError = text.split('\n').filter(Boolean).pop() || lastError;
      send('job:log', text);
    }
  });

  child.on('error', (err) => {
    currentJob = null;
    const alvo = engine === 'native' ? `o Python (${child.spawnfile})` : 'o Docker';
    send('job:event', { event: 'error', message: `Falha ao executar ${alvo}: ${err.message}` });
  });

  child.on('close', (code) => {
    const wasCanceled = currentJob?.canceled;
    const temporario = currentJob?.cleanup;
    currentJob = null;
    // A gravação bruta já virou transcrição: não precisa ocupar disco.
    if (temporario) {
      try { fs.unlinkSync(temporario); } catch { /* já removido */ }
    }
    if (wasCanceled) {
      send('job:event', { event: 'canceled' });
    } else if (code !== 0) {
      send('job:event', {
        event: 'error',
        message: engine === 'native'
          ? explainNativeFailure(lastError, child.spawnfile, code)
          : lastError || `A transcrição terminou com erro (código ${code}).`,
      });
    }
    send('job:closed', { code });
  });

  return { started: true, containerName };
}

/**
 * Importa uma transcrição já pronta (texto ou legenda).
 *
 * Não há áudio para extrair nem nada para transcrever: o arquivo vira reunião
 * direto e segue para a análise como qualquer outra. Os eventos são os mesmos do pipeline para a janela não precisar de um
 * segundo caminho de progresso.
 */
async function importTranscriptJob({ filePath, name, projectId, autoName = false }) {
  if (currentJob || currentExtraction) {
    return { ok: false, message: 'Espere o processamento em andamento terminar.' };
  }

  const settings = loadSettings();
  const outputDir = settings.outputDir;
  const project = projects.getProject(outputDir, projectId || '');
  const root = library.meetingsRootFor(outputDir, project);
  const resultado = transcriptImport.importTranscript({
    filePath,
    outputDir: root,
    name,
    language: settings.language,
  });
  if (!resultado.ok) return resultado;

  const naRaizDoProjeto = path.resolve(root) !== path.resolve(outputDir);
  const meetingId = library.meetingId(naRaizDoProjeto ? projectId : '', resultado.id);
  if (projectId) projects.assignMeeting(outputDir, meetingId, projectId);

  send('job:event', {
    event: 'stage',
    key: 'export',
    progress: 100,
    detail: `${resultado.segments} fala(s) importada(s)`,
  });

  const evento = {
    event: 'done',
    files: [resultado.transcriptPath],
    segments: resultado.segments,
    duration: resultado.duration,
    elapsed: 0,
    meetingId,
  };
  await finishJob(evento, outputDir, projectId, autoName);
  return { ok: true, meetingId: evento.meetingId };
}

/**
 * Renomeia a reunião e leva junto os vínculos.
 *
 * O id é o nome da pasta: renomear muda o id, e projeto e tarefas precisam
 * acompanhar para não virarem órfãos.
 */
function renameMeetingEverywhere(dir, id, novoNome) {
  const result = library.renameMeeting(dir, id, novoNome);
  if (result.ok && result.id && result.id !== id) {
    projects.renameMeeting(dir, id, result.id);
    tasks.renameMeeting(dir, id, result.id);
  }
  return result;
}

/**
 * O título da análise virando nome de pasta.
 *
 * O prompt já pede um título sem `< > : " / \ | ? *`, mas o modelo escorrega — e
 * um dois-pontos num título é o escorregão natural ("Onboarding: ajustes"). Sem
 * esta troca, o nome seria recusado pela validação e a reunião ficaria com o
 * nome provisório, ou o botão devolveria um erro que quem clicou não tem como
 * consertar. É a mesma substituição que o exportador faz do lado do Python.
 */
function tituloParaNome(title) {
  return (title || '').replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Deixa a IA nomear uma reunião que já existe.
 *
 * É o mesmo título que sai sozinho ao fim de uma gravação sem nome — aqui
 * pedido à mão, para a reunião que foi importada com o nome do arquivo ou
 * batizada às pressas. Quando a análise já está no disco, o título já está
 * lá dentro e nada precisa ser lido de novo; senão, o Claude lê a transcrição
 * agora e a análise fica guardada, aproveitada depois pelo documento.
 */
async function renameMeetingWithAi(dir, id) {
  if (isBusy()) {
    return { ok: false, message: 'Espere o processamento em andamento terminar.' };
  }

  const meeting = library.getMeeting(dir, id);
  if (!meeting) return { ok: false, message: 'Reunião não encontrada.' };
  if (!meeting.transcript) {
    return { ok: false, message: 'Esta reunião não tem transcrição para a IA ler.' };
  }

  const savePath = analysisPath(meeting.dir, meeting.legacy);
  let analysis = readAnalysis(savePath);

  if (!analysis?.title) {
    const r = await analyzeMeeting({
      transcriptPath: meeting.transcript,
      context: meeting.project?.context || '',
      savePath,
      register: (child) => { currentExtraction = { child, meetingId: id }; },
      onProgress: ({ detail }) => send('job:log', `Nome pela IA: ${detail}`),
    });
    currentExtraction = null;
    analysis = r.analysis;
    if (r.message) return { ok: false, message: `A IA não conseguiu ler a reunião: ${r.message}` };
  }

  if (!analysis?.title) {
    return { ok: false, message: 'A IA não sugeriu um nome para esta reunião.' };
  }

  const nome = tituloParaNome(analysis.title);
  const resultado = renameMeetingEverywhere(dir, id, nome);
  return resultado.ok ? { ...resultado, name: nome } : resultado;
}

/** A pasta da reunião vai para a Lixeira, não para o vazio: um clique errado dá para desfazer. */
async function trashMeeting(meeting) {
  await shell.trashItem(meeting.dir);
  return { ok: true, deleted: meeting.files.length, trashed: true };
}

/**
 * Exclui a reunião e tudo o que é dela: a pasta (transcrição, análise, PDF),
 * o vínculo com o projeto e as tarefas que nasceram dela.
 */
/**
 * Para tudo o que ainda corre por uma reunião.
 *
 * Chamado **antes** de apagar, e não depois: o `claude -p` da análise grava o
 * arquivo quando termina, e um que termine no meio da exclusão recria a pasta
 * que acabou de ir para a Lixeira — com um `analise.json` órfão dentro, que
 * ninguém vê e ninguém limpa.
 */
function stopWorkForMeeting(meetingId) {
  const plano = planWorkCancellation({
    meetingId,
    docQueue,
    docJob: currentDocJob,
    extraction: currentExtraction,
  });

  // A fila é a mesma referência que `runDocQueue` consome: mexer no conteúdo,
  // e não trocar o array, é o que faz o laço enxergar a mudança.
  docQueue.splice(0, docQueue.length, ...plano.queue);

  if (plano.cancelExtraction) {
    killTree(currentExtraction.child);
    currentExtraction = null;
  }
  if (plano.cancelDocJob) {
    currentDocJob.canceled = true;
    killTree(currentDocJob.child);
  }

  const aviso = describeCancellation(plano);
  if (aviso) {
    send('job:log', aviso);
    // A tela de documentos fica esperando um fim que não vem mais.
    if (plano.cancelDocJob) send('doc:done', { ok: false, canceled: true, meetingId });
  }
  return plano;
}

async function deleteMeetingEverywhere(dir, id, files = null) {
  // Só a exclusão da reunião inteira derruba trabalho; apagar arquivos
  // avulsos escolhidos na tela não é motivo para cancelar nada.
  if (!files) stopWorkForMeeting(id);

  // O caminho da transcrição precisa ser lido agora: depois de apagar, a
  // reunião não responde mais, e o temporário da análise ficaria para trás.
  const transcript = files ? '' : library.getMeeting(dir, id)?.transcript || '';

  const result = await library.deleteMeeting(dir, id, files, trashMeeting);
  if (result.ok && !files) {
    projects.forgetMeeting(dir, id);
    tasks.deleteByMeeting(dir, id);
    // O JSON temporário da análise nasce em %TEMP%, fora da pasta da reunião,
    // e sobreviveria a ela.
    if (transcript) unlinkTolerant(analysisTmpPathFor(transcript));
  }
  return result;
}

/**
 * Exclui o projeto e tudo o que é dele: cada reunião (para a Lixeira), a pasta
 * `synapse` que as guardava, as tarefas, o histórico do chat e os vínculos.
 * Uma reunião que não pôde ir é relatada; o resto segue.
 */
async function deleteProjectEverywhere(dir, projectId) {
  const p = projects.getProject(dir, projectId);
  if (!p) return { ok: false, message: 'Projeto não encontrado.' };

  const falhas = [];
  for (const m of workspace.listMeetings(dir, projectId)) {
    const r = await deleteMeetingEverywhere(dir, m.id);
    if (!r.ok) falhas.push(r.message);
  }
  const root = library.meetingsRootFor(dir, p);
  if (p.workdir && fs.existsSync(root)) {
    // Só a pasta `synapse`, e só se ficou vazia: o resto da pasta de trabalho
    // é da pessoa, não do Synapse.
    try { fs.rmdirSync(root); } catch { /* ficou algo lá: não é nosso */ }
  }

  const r = projects.deleteProject(dir, projectId);
  return falhas.length ? { ...r, warning: falhas.join(' ') } : r;
}

/**
 * Leva as reuniões do projeto para a raiz certa.
 *
 * A pasta de trabalho ganhou valor, mudou ou foi limpa — e o que é do projeto
 * vai junto, senão a biblioteca mostraria a reunião num lugar e o disco a
 * teria em outro. Vínculos e tarefas acompanham o id novo. Uma reunião que
 * não pôde ir fica onde está e é relatada; as outras seguem.
 */
function relocateProjectMeetings(dir, projectId, toRoot, toProjectId) {
  let moved = 0;
  const failures = [];
  for (const m of workspace.listMeetings(dir, projectId)) {
    const r = library.relocateMeeting(dir, m.id, toRoot, toProjectId);
    if (!r.ok) { failures.push(r.message); continue; }
    if (r.id !== m.id) {
      projects.renameMeeting(dir, m.id, r.id);
      tasks.renameMeeting(dir, m.id, r.id);
    }
    projects.assignMeeting(dir, r.id, projectId);
    if (r.moved) moved += 1;
  }
  return { moved, failures };
}

async function finishJob(event, outputDir, projectId, autoName = false) {
  const transcricao = event.files.find((f) => f.toLowerCase().endsWith('.md'));
  const fluxo = loadFlow();
  const analise = fluxo.find((s) => s.id === flows.ANALYSIS_STEP_ID);
  const plan = planAfterTranscription({
    steps: loadSettings().steps,
    projectId,
    autoName,
    hasTranscript: Boolean(transcricao),
    analysisEnabled: analise?.enabled !== false,
  });

  event.tasksCreated = 0;
  if (plan.analyze) {
    // Uma leitura só do modelo: dela saem o título, os cards e o documento.
    const meeting = library.getMeeting(outputDir, event.meetingId);
    const { analysis, message } = await analyzeMeeting({
      transcriptPath: transcricao,
      context: projectId ? projects.getProject(outputDir, projectId)?.context || '' : '',
      savePath: meeting ? analysisPath(meeting.dir, meeting.legacy) : null,
      register: (child) => { currentExtraction = { child, meetingId: event.meetingId }; },
      onProgress: ({ progress, detail }) =>
        send('job:event', { event: 'stage', key: 'analyze', progress, detail }),
    });
    currentExtraction = null;
    if (message) send('job:log', `Análise: ${message}`);

    if (analysis && plan.saveTasks) {
      const { created } = tasks.createFromExtraction(outputDir, {
        projectId, meetingId: event.meetingId, items: analysis.tasks,
      });
      event.tasksCreated = created;
      // Analisou tarefas mas nenhuma entrou no Kanban: sem isto o silêncio se
      // parece com "a reunião não gerou tarefas", e o trabalho se perde.
      if (analysis.tasks.length && !created) {
        send('job:log', `Análise: ${analysis.tasks.length} tarefa(s) não puderam ser gravadas no Kanban.`);
      }
    }

    if (autoName && analysis?.title) {
      const renomeada = renameMeetingEverywhere(
        outputDir, event.meetingId, tituloParaNome(analysis.title),
      );
      if (renomeada.ok && renomeada.id) {
        event.meetingId = renomeada.id;
        event.renamedTo = renomeada.id;
        // Os caminhos antigos não existem mais depois do rename.
        event.files = library.getMeeting(outputDir, renomeada.id)?.files.map((f) => f.path)
          || event.files;
      } else if (renomeada.message) {
        send('job:log', `Nome sugerido não pôde ser aplicado: ${renomeada.message}`);
      }
    }
  }

  // As etapas que a pessoa escreveu rodam depois da análise, na ordem dela, e
  // cada uma pode ler o que a anterior gravou.
  if (transcricao) {
    event.stepFiles = await runFlowSteps({
      fluxo, outputDir, meetingId: event.meetingId, transcriptPath: transcricao, projectId,
    });
  }

  // A janela precisa saber se ainda vem documento: com a lista vazia, a
  // reunião está pronta aqui mesmo.
  event.docs = event.meetingId ? plan.docs : [];
  send('job:event', event);

  // O documento ligado em Configurações sai sozinho. Fora do caminho do aviso
  // de pronto: a transcrição já está na tela enquanto o PDF é montado.
  if (event.docs.length) enqueueDocs(event.meetingId, event.docs);
}

/**
 * Roda as etapas que a pessoa escreveu, depois da análise.
 *
 * Uma etapa que falha não derruba as outras nem a reunião: a transcrição já
 * está no disco, e o que se perde é aquele arquivo. O motivo vai para o log da
 * janela com o nome da etapa na frente, porque "falhou" sem dizer qual não
 * ajuda ninguém a consertar o prompt.
 *
 * Devolve os arquivos que nasceram aqui, para o painel da reunião listá-los.
 */
async function runFlowSteps({ fluxo, outputDir, meetingId, transcriptPath, projectId }) {
  const extras = fluxo.filter((s) => s.id !== flows.ANALYSIS_STEP_ID && s.enabled);
  if (!extras.length) return [];

  const meeting = library.getMeeting(outputDir, meetingId);
  const project = projectId ? projects.getProject(outputDir, projectId) : null;
  const plano = flowRunner.planSteps(fluxo, {
    meetingDir: meeting?.dir || '',
    analysisPath: meeting ? analysisPath(meeting.dir, meeting.legacy) : '',
    transcriptPath,
    context: project?.context || '',
    meetingName: meeting?.name || '',
    projectName: project?.name || '',
  }).filter((item) => item.step.id !== flows.ANALYSIS_STEP_ID);

  const gerados = [];
  for (const [i, item] of plano.entries()) {
    const rótulo = flowRunner.describeStepProgress(item.step, i, plano.length);
    send('job:event', {
      event: 'stage',
      key: 'analyze',
      progress: Math.round(((i + 1) / (plano.length + 1)) * 100),
      detail: rótulo,
    });

    const { ok, message } = await runClaudeStep({ ...item, meetingId });
    if (!ok) {
      send('job:log', `Etapa "${item.step.name}": ${message}`);
      continue;
    }
    if (item.outputPath && fs.existsSync(item.outputPath)) gerados.push(item.outputPath);
    else if (item.outputPath) {
      send('job:log', `Etapa "${item.step.name}": terminou sem gravar ${path.basename(item.outputPath)}.`);
    }
  }
  return gerados;
}

/** Um `claude -p` para uma etapa do fluxo. Nunca lança: devolve o motivo. */
function runClaudeStep({ step, prompt, args, meetingId = '' }) {
  return new Promise((resolve) => {
    const child = spawn(findClaude(), args, { cwd: PROJECT_ROOT, windowsHide: true });
    currentExtraction = { child, meetingId };
    child.stdin.write(prompt);
    child.stdin.end();

    let erro = '';
    child.stderr.on('data', (d) => { erro = (erro + d.toString()).slice(-1000); });
    child.on('error', (err) => {
      currentExtraction = null;
      resolve({ ok: false, message: `não foi possível executar o Claude Code (${err.code || err.message}).` });
    });
    child.on('close', (code) => {
      currentExtraction = null;
      if (code === 0) { resolve({ ok: true, message: '' }); return; }
      const ultima = erro.split('\n').filter(Boolean).pop() || `código ${code}`;
      resolve({ ok: false, message: `${step.skill ? `a skill ${step.skill} ` : ''}terminou com erro (${ultima}).` });
    });
  });
}

/**
 * A análise da reunião (AI-01): o Claude lê a transcrição e grava um JSON com
 * título, visão geral, decisões e as ações combinadas. É a única chamada ao
 * modelo por reunião — Kanban e documento nascem do que sai daqui.
 *
 * Falha aqui não derruba o job: a transcrição já está no disco, e uma análise
 * que não veio é um kanban vazio e um PDF que não saiu, não uma reunião perdida.
 *
 * `register` recebe o processo para quem precisar cancelá-lo; `onProgress`
 * recebe { progress, detail } para a barra que estiver na tela.
 */
function analyzeMeeting({ transcriptPath, context, savePath, register = () => {}, onProgress = () => {} }) {
  return new Promise((resolve) => {
    const jsonPath = analysisTmpPathFor(transcriptPath);
    unlinkTolerant(jsonPath);   // sobra de uma tentativa anterior

    let prompt;
    try {
      prompt = buildAnalysisPrompt({ transcriptPath, jsonPath, context, userPromptsDir: userPromptsDir() });
    } catch (err) {
      resolve({ analysis: null, message: err.message });
      return;
    }

    onProgress({ progress: 20, detail: 'lendo a transcrição' });
    const child = spawn(findClaude(), buildClaudeArgs(), {
      cwd: path.dirname(transcriptPath),
      windowsHide: true,
    });
    // O prompt vai por stdin: como argumento, o shell do Windows o corrompe.
    child.stdin.write(prompt);
    child.stdin.end();
    register(child);

    let progresso = 45;
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const detail = describeEvent(JSON.parse(line));
          if (!detail) continue;
          progresso = Math.min(90, progresso + 8);
          onProgress({ progress: progresso, detail });
        } catch { /* linha parcial do stream */ }
      }
    });

    child.on('error', (err) => resolve({
      analysis: null,
      message: `não foi possível executar o Claude Code (${err.code || err.message}).`,
    }));

    child.on('close', () => {
      let dados;
      try {
        // Tolerante à normalização do Unicode: o Claude grava o nome em NFC
        // mesmo quando recebeu o caminho em NFD, e aí o arquivo "desaparece"
        // para quem procura exatamente a forma que enviou.
        dados = JSON.parse(readFileTolerant(jsonPath));
      } catch (err) {
        resolve({ analysis: null, message: `a análise não devolveu um JSON legível (${err.message}).` });
        return;
      }
      unlinkTolerant(jsonPath);

      const analysis = normalizeAnalysis(dados);
      if (savePath) {
        try {
          writeAnalysis(savePath, analysis);
        } catch (err) {
          send('job:log', `Não deu para guardar a análise: ${err.message}`);
        }
      }
      resolve({ analysis, message: '' });
    });
  });
}

/**
 * Gravação feita dentro do app (REC-04): o áudio capturado na janela chega
 * como bytes, vira um arquivo e entra no mesmo pipeline da importação. A
 * origem muda; o processamento é o de sempre.
 *
 * `autoName` chega ligado quando ninguém escreveu um nome na tela de gravação:
 * o nome provisório serve só para a barra de progresso ter o que mostrar, e a
 * análise o substitui pelo título que leu da conversa. `recordedAt` é o
 * instante em que o botão de gravar foi apertado.
 */
function startRecordingJob({
  projectId, name, audio, mimeType = 'audio/webm', autoName = false, recordedAt = 0,
}) {
  if (currentJob) {
    return { started: false, message: 'Já existe uma transcrição em andamento.' };
  }
  if (!audio || !audio.byteLength) {
    return { started: false, message: 'A gravação saiu vazia. Confira o microfone e tente de novo.' };
  }

  const settings = loadSettings();
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const temporario = path.join(
    app.getPath('temp'),
    `synapse-gravacao-${Date.now()}.${ext}`,
  );

  try {
    fs.writeFileSync(temporario, Buffer.from(audio));
  } catch (err) {
    return { started: false, message: `Não foi possível salvar a gravação: ${err.message}` };
  }

  return startJob({
    videoPath: temporario,
    name: name || 'Gravação',
    projectId,
    autoName,
    recordedAt,
    cleanup: temporario,
  });
}

async function cancelJob() {
  // A extração roda depois do pipeline: cancelar durante ela também vale.
  if (currentExtraction) {
    killTree(currentExtraction.child);
    currentExtraction = null;
    send('job:event', { event: 'canceled' });
    return { canceled: true };
  }
  if (!currentJob) return { canceled: false };
  currentJob.canceled = true;

  if (currentJob.containerName) {
    // Matar o cliente `docker run` não para o container: removemos pelo nome.
    await run('docker', ['rm', '-f', currentJob.containerName]);
  } else if (process.platform === 'win32') {
    // No motor nativo o Python tem o whisper-cli como filho, e matar só o pai
    // deixaria a transcrição consumindo a GPU até o fim.
    await run('taskkill', ['/pid', String(currentJob.child.pid), '/t', '/f']);
  }
  currentJob.child.kill();
  return { canceled: true };
}

// --- Documento da reunião ----------------------------------------------------

/**
 * Imprime o HTML em PDF pelo próprio Electron.
 *
 * O Chromium que desenha esta janela é o mesmo que o Edge usaria: não há
 * motivo para procurar um navegador instalado, e procurar custava caro — os
 * caminhos eram `C:\Program Files\...`, então fora do Windows o documento
 * simplesmente não saía, e dentro dele quebrava em quem não tem Edge nem
 * Chrome. Uma janela escondida carrega o HTML, imprime e morre.
 *
 * `preferCSSPageSize` respeita o `@page { size: A4; margin: 2cm }` que o
 * documento declara, em vez de reimprimir tudo em Letter.
 *
 * O veredito é o arquivo no disco: uma promessa resolvida com PDF vazio não
 * conta.
 */
async function printToPdf(html, pdfPath) {
  const htmlTmp = path.join(app.getPath('temp'), `synapse-documento-${Date.now()}.html`);
  fs.writeFileSync(htmlTmp, html, 'utf-8');

  // Sem preload, sem Node e sem janela visível: esta só renderiza o HTML que
  // o próprio app acabou de montar.
  const impressora = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  try {
    unlinkTolerant(pdfPath);   // um PDF antigo não pode passar por resultado novo
    await impressora.loadFile(htmlTmp);
    const pdf = await impressora.webContents.printToPDF({
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
    });
    fs.writeFileSync(pdfPath, pdf);

    const ok = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0;
    return ok ? { ok: true } : { ok: false, message: 'O PDF saiu vazio.' };
  } catch (err) {
    return { ok: false, message: `Não foi possível gerar o PDF: ${err.message}` };
  } finally {
    impressora.destroy();
    try { fs.unlinkSync(htmlTmp); } catch { /* já removido */ }
  }
}

/**
 * Fila de documentos.
 *
 * A geração acontece sozinha ao fim de cada reunião, e duas importações
 * seguidas chegariam juntas aqui. Em vez de recusar a segunda, ela espera a
 * vez — o Claude, quando precisa entrar, só roda um de cada vez.
 */
const docQueue = [];

function enqueueDocs(meetingId, kinds = DOC_KINDS) {
  // O que a fila já promete para esta reunião não entra de novo; o que falta
  // entra como item próprio — descartar o pedido seria dizer "feito" e não fazer.
  const missing = pendingDocKinds(docQueue, meetingId, kinds);
  if (!missing.length) return { started: true, queued: true };
  docQueue.push({ meetingId, kinds: missing });
  if (docQueue.length === 1) runDocQueue();
  return { started: true, queued: docQueue.length > 1 };
}

async function runDocQueue() {
  while (docQueue.length) {
    await generateDocs(docQueue[0]);
    docQueue.shift();
  }
}

/**
 * O documento da reunião, a partir da análise gravada.
 *
 * Reunião de antes da análise existir (ou pedido à mão numa que ficou sem):
 * o Claude lê agora, e a análise fica guardada para a próxima vez. A tabela
 * de tarefas do PDF é a mesma lista que virou cards — por construção.
 */
async function generateDocs({ meetingId }) {
  const dir = outDir();
  const meeting = library.getMeeting(dir, meetingId);
  if (!meeting || !meeting.transcript) {
    return { started: false, message: 'Transcrição não encontrada.' };
  }

  currentDocJob = { child: null, kind: 'documento', canceled: false, meetingId };
  const progress = (description) => send('doc:progress', { kind: 'documento', description });
  progress('lendo a análise');

  const savePath = analysisPath(meeting.dir, meeting.legacy);
  let analysis = readAnalysis(savePath);
  let message = '';
  if (!analysis) {
    const r = await analyzeMeeting({
      transcriptPath: meeting.transcript,
      context: meeting.project?.context || '',
      savePath,
      register: (child) => { if (currentDocJob) currentDocJob.child = child; },
      onProgress: ({ detail }) => progress(detail),
    });
    analysis = r.analysis;
    message = r.message;
  }

  let ok = false;
  if (analysis && !currentDocJob?.canceled) {
    progress('montando o documento');
    const html = renderDocumentHtml({ meeting: workspace.toMeeting(meeting, meeting.project), analysis });
    progress('convertendo para PDF');
    const r = await printToPdf(html, documentPdfPath(meeting.transcript));
    ok = r.ok;
    if (!ok) message = r.message;
  }

  const canceled = Boolean(currentDocJob?.canceled);
  currentDocJob = null;
  send('doc:done', {
    meetingId,
    ok: ok && !canceled,
    canceled,
    kinds: ok && !canceled ? ['documento'] : [],
    message: ok ? '' : (message || 'O documento não foi gerado.'),
  });
  return { started: true };
}

function cancelDocJob() {
  if (!currentDocJob) return { canceled: false };
  currentDocJob.canceled = true;
  const child = currentDocJob.child;
  if (!child) return { canceled: true };
  killTree(child);
  return { canceled: true };
}

function buildImage() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['build', '-t', IMAGE_NAME, '.'], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
    });
    const forward = (chunk) => {
      const text = chunk.toString().trim();
      if (text) send('build:log', text);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => resolve({ ok: false, message: String(err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

// --- IPC --------------------------------------------------------------------

const outDir = () => loadSettings().outputDir;

// Configurações e motores.
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));
ipcMain.handle('engines:status', () => enginesStatus());
ipcMain.handle('docker:status', () => dockerStatus());
ipcMain.handle('docker:build', () => buildImage());

// Projetos — o grupo do disco visto como projeto do workspace.
ipcMain.handle('projects:list', () => workspace.listProjects(outDir()));
ipcMain.handle('projects:save', (_e, project) => {
  const dir = outDir();
  const antes = project.id ? projects.getProject(dir, project.id) : null;
  const r = projects.saveProject(dir, project);
  if (!r.ok) return r;

  const depois = projects.getProject(dir, r.id);
  const root = library.meetingsRootFor(dir, depois);
  if (depois.workdir) {
    // A pasta `synapse` nasce já na criação: é o sinal, no disco, de que
    // aquela pasta virou casa de um projeto.
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      return { ...r, warning: `A pasta ${root} não pôde ser criada: ${err.message}` };
    }
  }
  if (antes && antes.workdir !== depois.workdir) {
    const { moved, failures } = relocateProjectMeetings(dir, r.id, root, depois.workdir ? r.id : '');
    return { ...r, moved, warning: failures.join(' ') };
  }
  return r;
});
ipcMain.handle('projects:delete', (_e, projectId) => deleteProjectEverywhere(outDir(), projectId));

// Reuniões (a pasta de saída é a fonte da verdade).
ipcMain.handle('meetings:list', (_e, projectId) => workspace.listMeetings(outDir(), projectId));
ipcMain.handle('meetings:get', (_e, id) => workspace.getMeeting(outDir(), id));
ipcMain.handle('meetings:rename', (_e, { id, name }) =>
  renameMeetingEverywhere(outDir(), id, name));
ipcMain.handle('meetings:renameWithAi', (_e, { id }) => renameMeetingWithAi(outDir(), id));
ipcMain.handle('meetings:delete', (_e, { id, files }) => deleteMeetingEverywhere(outDir(), id, files));
ipcMain.handle('meetings:assign', (_e, { meetingId, projectId }) =>
  projects.assignMeeting(outDir(), meetingId, projectId));
ipcMain.handle('meetings:read', (_e, filePath) => library.readText(filePath));

// Tarefas do Kanban.
ipcMain.handle('tasks:list', (_e, projectId) => workspace.listTasks(outDir(), projectId));
ipcMain.handle('tasks:forMeeting', (_e, meetingId) => workspace.listTasksForMeeting(outDir(), meetingId));
ipcMain.handle('tasks:save', (_e, task) => tasks.saveTask(outDir(), task));
ipcMain.handle('tasks:move', (_e, { id, status }) => tasks.moveTask(outDir(), id, status));
ipcMain.handle('tasks:delete', (_e, id) => tasks.deleteTask(outDir(), id));

// Pipeline.
ipcMain.handle('job:start', (_e, payload) => startJob(payload));
ipcMain.handle('job:recording', (_e, payload) => startRecordingJob(payload));
ipcMain.handle('job:cancel', () => cancelJob());

// Gravação pelo OBS Studio. Tudo passa pelo servidor MCP em mcp-obs/ — o
// mesmo que o assistente do projeto pode usar no chat.
ipcMain.handle('obs:status', () => obs.status(loadSettings().obs));
ipcMain.handle('obs:start', () => obs.startRecording(loadSettings().obs));
ipcMain.handle('obs:stop', () => obs.stopRecording(loadSettings().obs));
ipcMain.handle('obs:recordingStatus', () => obs.recordingStatus(loadSettings().obs));
ipcMain.handle('obs:pause', (_e, { resume = false } = {}) =>
  obs.pauseRecording(loadSettings().obs, resume));
/**
 * A gravação do OBS entra no pipeline como qualquer vídeo solto na janela.
 *
 * Sem `cleanup`: o arquivo é do OBS, está na pasta de vídeos de quem gravou, e
 * apagá-lo depois de transcrever seria apagar material que não é nosso.
 */
ipcMain.handle('obs:process', (_e, { videoPath, name, projectId, autoName, recordedAt }) =>
  startJob({ videoPath, name, projectId, autoName, recordedAt }));
ipcMain.handle('transcript:import', (_e, payload) => importTranscriptJob(payload));

// Documentos: o front manda o id da reunião; aqui viram caminho e contexto.
ipcMain.handle('doc:generate', (_e, { meetingId }) => enqueueDocs(meetingId));
ipcMain.handle('doc:cancel', () => cancelDocJob());

// Atualização do app: git pull no clone e reinício do Electron.
const updater = createUpdater({
  root: PROJECT_ROOT,
  run,
  log: (line) => send('update:log', line),
});
const isBusy = () => Boolean(currentJob || currentExtraction || currentDocJob);
ipcMain.handle('update:version', () => updater.currentVersion());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:apply', () => (isBusy()
  ? { ok: false, message: 'Espere o processamento em andamento terminar antes de atualizar.' }
  : updater.update()));
ipcMain.handle('update:restart', () => {
  // Reabre o mesmo Electron com os mesmos argumentos: o código novo já está
  // no disco, só falta carregá-lo.
  app.relaunch();
  app.exit(0);
});

// Prompts: ver, editar e restaurar as instruções de cada etapa.
ipcMain.handle('prompt:list', () => promptsStore.listPrompts());
ipcMain.handle('prompt:get', (_e, kind) => promptsStore.readPrompt(kind, { userDir: userPromptsDir() }));
ipcMain.handle('prompt:save', (_e, { kind, text }) =>
  promptsStore.savePrompt(kind, text, { userDir: userPromptsDir() }));
ipcMain.handle('prompt:reset', (_e, kind) => promptsStore.resetPrompt(kind, { userDir: userPromptsDir() }));

// Fluxo depois da transcrição: as etapas que a pessoa escreveu.
ipcMain.handle('flow:list', () => ({
  steps: loadFlow(),
  placeholders: flows.PLACEHOLDERS,
  inputs: flows.INPUTS,
  outputs: flows.OUTPUTS,
}));
ipcMain.handle('flow:save', (_e, steps) => {
  const inválida = (steps || []).find((s) => s.id !== flows.ANALYSIS_STEP_ID && flows.validateStep(s));
  if (inválida) return { ok: false, message: flows.validateStep(inválida) };
  return { ok: true, steps: saveFlow(steps) };
});
ipcMain.handle('flow:new', () => flows.newStep());

// Chat por projeto — o RAG entra no M3 (embeddings + Vector DB).
// --- Chat do projeto --------------------------------------------------------

/**
 * As reuniões do projeto como o Claude precisa vê-las: nome, data e os
 * caminhos que ele pode abrir com Read.
 */
function chatMeetings(dir, projectId) {
  return workspace.listMeetings(dir, projectId).map((m) => {
    const analise = m.dir && path.resolve(m.dir) !== path.resolve(dir) ? analysisPath(m.dir, false) : null;
    return {
      // A pasta própria da reunião é o que o chat libera para leitura, uma a
      // uma. Reunião do formato antigo (arquivos soltos na raiz de saída) não
      // tem pasta só dela e fica sem liberação: a raiz é de todo mundo.
      dir: m.dir && path.resolve(m.dir) !== path.resolve(dir) ? m.dir : '',
      name: m.name,
      recordedAt: m.recordedAt,
      transcriptPath: m.transcriptPath,
      analysisPath: analise && fs.existsSync(analise) ? analise : '',
      documentPath: (m.files || []).find((f) => f.name.includes(' - Documento.'))?.path || '',
    };
  });
}

/**
 * A pasta onde o chat do projeto roda.
 *
 * Com pasta de trabalho, é ela: o assistente trabalha no repositório ou na
 * pasta de documentos que a pessoa deu ao projeto. Sem ela, o chat ganha uma
 * pasta só sua dentro dos dados do app — e **não** a pasta de saída, que
 * guarda o material de todos os projetos. O diretório de trabalho do processo
 * é lido sem precisar de liberação nenhuma; apontá-lo para a raiz comum daria
 * ao assistente de um projeto o arquivo de outro de graça.
 */
function chatWorkdir(project, projectId) {
  if (project.workdir && fs.existsSync(project.workdir)) return project.workdir;
  const propria = path.join(app.getPath('userData'), 'chats', projectId);
  fs.mkdirSync(propria, { recursive: true });
  return propria;
}

/**
 * As pastas que o chat pode ler além da sua.
 *
 * Com pasta de trabalho, as reuniões do projeto moram todas em `synapse/`
 * dentro dela, e liberar essa pasta basta. Sem ela, as reuniões estão na raiz
 * de saída misturadas com as dos outros projetos: aí vai cada pasta de reunião
 * deste projeto, uma a uma, em vez da raiz inteira.
 */
function chatAddDirs({ dir, project, workdir, meetingsDir, meetings = [] }) {
  const raiz = path.resolve(dir);
  const casa = path.resolve(workdir);
  const candidatos = project.workdir
    ? [meetingsDir]
    : meetings.map((m) => m.dir).filter(Boolean);
  return [...new Set(candidatos.map((d) => path.resolve(d)))]
    .filter((d) => d !== casa && d !== raiz);
}

/** Uma rodada do chat: um `claude -p`, do envio da mensagem ao result. */
function runChatTurn({ projectId, message, sessionId, resume, bypass, workdir, promptFile, addDirs }) {
  return new Promise((resolve) => {
    const args = buildChatArgs({ sessionId, resume, bypass, systemPromptFile: promptFile, addDirs });
    const child = spawn(findClaude(), args, { cwd: workdir, windowsHide: true });
    currentChat = { child, projectId, canceled: false };
    child.stdin.write(message);
    child.stdin.end();

    let buffer = '';
    let stderr = '';
    const tools = [];
    const textos = [];
    let resultado = null;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        let eventos;
        try { eventos = describeChatEvent(JSON.parse(line)); } catch { continue; }
        for (const ev of eventos || []) {
          if (ev.kind === 'tool') {
            tools.push(ev.label);
            send('chat:event', { projectId, kind: 'tool', label: ev.label });
          } else if (ev.kind === 'text') {
            textos.push(ev.text);
            send('chat:event', { projectId, kind: 'text', text: ev.text });
          } else if (ev.kind === 'result') {
            resultado = ev;
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      currentChat = null;
      resolve({ ok: false, tools, message: `não foi possível executar o Claude Code (${err.code || err.message}).` });
    });

    child.on('close', (code) => {
      const canceled = Boolean(currentChat?.canceled);
      currentChat = null;
      if (canceled) { resolve({ ok: false, canceled: true, tools, text: textos.join('\n\n'), message: 'Interrompido.' }); return; }
      if (resultado && !resultado.isError) {
        // Todos os trechos de texto, na ordem: é a narrativa da rodada, não só a última frase.
        resolve({ ok: true, tools, text: textos.join('\n\n') || resultado.text });
        return;
      }
      if (isMissingSession(stderr)) { resolve({ ok: false, missingSession: true, tools, message: stderr }); return; }
      const motivo = resultado?.text || stderr.split('\n').filter(Boolean).pop() || `o Claude terminou com código ${code}`;
      resolve({ ok: false, tools, message: `Não deu para responder: ${motivo}` });
    });
  });
}

/**
 * Manda uma mensagem ao Claude no contexto do projeto.
 *
 * A pergunta entra no histórico antes de rodar; a resposta, depois. A sessão
 * do Claude Code é criada na primeira mensagem e retomada nas seguintes — se
 * ela sumiu (limpeza do ~/.claude, por exemplo), começa outra e segue.
 */
async function sendChat({ projectId, text }) {
  if (currentChat) return { ok: false, message: 'O assistente ainda está respondendo.' };
  const dir = outDir();
  const project = projects.getProject(dir, projectId);
  if (!project) return { ok: false, message: 'Projeto não encontrado.' };
  const message = String(text || '').trim();
  if (!message) return { ok: false, message: 'Escreva algo.' };

  const workdir = chatWorkdir(project, projectId);
  const meetingsDir = library.meetingsRootFor(dir, project);
  const bypass = Boolean(project.chatBypass);
  chatMessages.addMessage(dir, { projectId, role: 'user', text: message });

  const reunioes = chatMeetings(dir, projectId);
  const systemPrompt = buildChatSystemPrompt({
    project,
    meetings: reunioes,
    tasks: workspace.listTasks(dir, projectId),
    meetingsDir,
    workdir,
    bypass,
  });
  // Por arquivo: como argumento, um texto grande não sobrevive à linha de
  // comando do Windows.
  const promptFile = path.join(app.getPath('temp'), `synapse-chat-${Date.now()}.md`);
  fs.writeFileSync(promptFile, systemPrompt, 'utf-8');

  let sessionId = project.chatSessionId;
  let resume = Boolean(sessionId);
  if (!sessionId) {
    sessionId = randomUUID();
    projects.setChatSession(dir, projectId, sessionId);
  }
  const addDirs = chatAddDirs({ dir, project, workdir, meetingsDir, meetings: reunioes });
  const rodar = () => runChatTurn({ projectId, message, sessionId, resume, bypass, workdir, promptFile, addDirs });

  let rodada = await rodar();
  if (!rodada.ok && rodada.missingSession && resume) {
    sessionId = randomUUID();
    projects.setChatSession(dir, projectId, sessionId);
    resume = false;
    rodada = await rodar();
  }
  try { fs.unlinkSync(promptFile); } catch { /* já removido */ }

  const resposta = rodada.text || rodada.message || '';
  chatMessages.addMessage(dir, {
    projectId, role: 'ai', text: resposta, tools: rodada.tools, bypass, error: !rodada.ok,
  });
  send('chat:event', {
    projectId, kind: 'done', ok: rodada.ok, canceled: Boolean(rodada.canceled), text: resposta, tools: rodada.tools, bypass,
  });
  return { ok: true };
}

function stopChat() {
  if (!currentChat) return { stopped: false };
  currentChat.canceled = true;
  // O claude pode ter filhos (um comando em execução): derruba a árvore.
  killTree(currentChat.child);
  return { stopped: true };
}

ipcMain.handle('chat:history', (_e, projectId) => chatMessages.listMessages(outDir(), projectId));
ipcMain.handle('chat:send', (_e, payload) => sendChat(payload));
ipcMain.handle('chat:stop', () => stopChat());
ipcMain.handle('chat:clear', (_e, projectId) => {
  // Recomeçar é apagar o que a tela mostra e soltar a sessão: a próxima
  // mensagem abre uma conversa nova no Claude Code.
  if (currentChat?.projectId === projectId) return { ok: false, message: 'Espere a resposta terminar.' };
  const dir = outDir();
  chatMessages.clearMessages(dir, projectId);
  projects.setChatSession(dir, projectId, '');
  return { ok: true };
});
ipcMain.handle('chat:setBypass', (_e, { projectId, enabled }) =>
  projects.setChatBypass(outDir(), projectId, Boolean(enabled)));

/**
 * A resposta vira áudio com a voz neural. Falha devolve `fallback: true` e o
 * renderer lê com a voz do sistema — a conversa não para por falta de internet.
 */
ipcMain.handle('tts:speak', (_e, { text }) => {
  const settings = loadSettings();
  if (settings.tts.engine !== 'neural') return { ok: false, fallback: true, message: '' };
  const native = nativeStatus(PROJECT_ROOT);
  return tts.synthesize({
    text,
    voice: settings.tts.voice,
    rate: settings.tts.rate,
    python: native.python || 'python',
    run,
    tmpDir: app.getPath('temp'),
  });
});
ipcMain.handle('tts:options', () => ({ voices: tts.VOICES, rates: tts.RATES }));

/**
 * Recado de voz do chat vira texto — com o mesmo whisper.cpp das reuniões,
 * na GPU. Precisa do motor nativo; o container não compensa para dez
 * segundos de áudio.
 */
ipcMain.handle('chat:transcribe', async (_e, { audio, mimeType = 'audio/webm' }) => {
  if (!audio || !audio.byteLength) return { ok: false, message: 'O recado saiu vazio.' };
  const settings = loadSettings();
  const native = nativeStatus(PROJECT_ROOT);
  const modelPath = settings.nativeModel || native.models[0]?.path;
  if (!native.cli || !modelPath) {
    return { ok: false, message: 'Falar com o chat precisa do motor GPU (whisper.cpp) — veja Configurações.' };
  }
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const clipPath = path.join(app.getPath('temp'), `synapse-recado-${Date.now()}.${ext}`);
  fs.writeFileSync(clipPath, Buffer.from(audio));
  try {
    return await voice.transcribeClip({
      clipPath,
      cli: native.cli,
      modelPath,
      vadModel: voice.findVadModel(PROJECT_ROOT),
      language: settings.language,
      threads: os.cpus().length,
      run,
      tmpDir: app.getPath('temp'),
    });
  } finally {
    try { fs.unlinkSync(clipPath); } catch { /* já removido */ }
  }
});

ipcMain.handle('dialog:pickWorkdir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Pasta de trabalho do projeto',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

/** Salva uma cópia de um arquivo da reunião onde o usuário escolher. */
ipcMain.handle('meetings:download', async (_e, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, message: 'Arquivo não encontrado.' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar cópia',
    defaultPath: path.join(app.getPath('downloads'), path.basename(filePath)),
    filters: [{ name: path.extname(filePath).slice(1).toUpperCase(), extensions: [path.extname(filePath).slice(1)] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    fs.copyFileSync(filePath, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, message: `Não foi possível salvar: ${err.message}` };
  }
});

ipcMain.handle('dialog:pickOutputDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher pasta de saída',
    defaultPath: loadSettings().outputDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return saveSettings({ outputDir: result.filePaths[0] }).outputDir;
});

ipcMain.handle('dialog:pickTranscript', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher transcrição',
    properties: ['openFile'],
    filters: [{ name: 'Transcrição e legenda', extensions: transcriptImport.EXTENSIONS }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:pickVideo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolher vídeo',
    properties: ['openFile'],
    filters: [{ name: 'Vídeo e áudio', extensions: MEDIA_EXTENSIONS }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:showInFolder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openPath', (_e, filePath) => shell.openPath(filePath));

// --- Ciclo de vida ----------------------------------------------------------

app.whenReady().then(() => {
  enableSystemAudioCapture();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  db.closeAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Trabalho órfão nunca: se a janela fecha no meio, derruba o job — e o chat.
app.on('before-quit', () => {
  if (currentChat) stopChat();
  // O servidor MCP do OBS é filho deste processo: sem isto ele ficaria de pé
  // depois de o app sumir da tela.
  obs.shutdown();
  if (!currentJob) return;
  currentJob.canceled = true;
  if (currentJob.containerName) {
    dockerRemove(currentJob.containerName);
  } else {
    killTree(currentJob.child);
  }
});
