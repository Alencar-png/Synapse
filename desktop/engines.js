'use strict';

/**
 * Os dois motores de transcrição do app.
 *
 *   nativo  — Python do host + whisper.cpp com Vulkan. Usa a GPU, é o rápido.
 *   docker  — container CPU-only. Portátil, não depende de nada instalado.
 *
 * Ambos falam o mesmo protocolo (eventos JSONL no stdout), então o resto do
 * app não precisa saber qual está em uso.
 */

const fs = require('node:fs');
const path = require('node:path');

const { IMAGE_NAME, MODELS_VOLUME, buildDockerArgs, toHostPath } = require('./docker-args');

/** Onde o whisper.cpp e os modelos GGML ficam dentro do projeto. */
function nativePaths(projectRoot) {
  return {
    cliCandidates: [
      path.join(projectRoot, '.whisper-cpp', 'whisper-cli.exe'),
      path.join(projectRoot, '.whisper-cpp', 'whisper-cli'),
    ],
    pythonCandidates: [
      path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
      path.join(projectRoot, '.venv', 'bin', 'python'),
      'python',
    ],
    modelsDir: path.join(projectRoot, '.models'),
  };
}

/** Primeiro caminho que existe, ou o último candidato (resolvido pelo PATH). */
function firstExisting(candidates) {
  return candidates.find((c) => !c.includes(path.sep) || fs.existsSync(c)) || null;
}

/**
 * Ordem de preferência dos modelos, do melhor para o pior.
 *
 * Ordenar por tamanho não serve: o `large-v3-turbo` tem metade do peso do
 * `large-v3` e transcreve mais rápido, mas erra mais em português — nomes
 * próprios, números e o fim das frases. Numa reunião que vira tarefa e
 * documento, o custo de um erro é maior que o de esperar. Quem quiser o turbo
 * o escolhe em Configurações; o padrão é o mais fiel que estiver na máquina.
 */
const MODEL_PREFERENCE = [
  'large-v3', 'large-v3-turbo', 'large-v2', 'large',
  'medium', 'small', 'base', 'tiny',
];

/** Posição do modelo na preferência; o desconhecido vai para o fim. */
function modelRank(id) {
  // Sem o casamento exato primeiro, "large-v3" acharia "large-v3-turbo".
  const exato = MODEL_PREFERENCE.indexOf(id);
  if (exato >= 0) return exato;
  const prefixo = MODEL_PREFERENCE.findIndex((p) => id.startsWith(p));
  return prefixo >= 0 ? prefixo + 0.5 : MODEL_PREFERENCE.length;
}

/** Modelos GGML disponíveis, do mais fiel para o mais leve. */
function listNativeModels(projectRoot) {
  const dir = nativePaths(projectRoot).modelsDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    // O modelo de VAD (ggml-silero-*.bin) é .bin também, mas não transcreve:
    // não entra na lista de escolha.
    .filter((f) => f.endsWith('.bin') && !/silero|vad/i.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      return {
        // "ggml-large-v3-turbo.bin" vira "large-v3-turbo"
        id: f.replace(/^ggml-/, '').replace(/\.bin$/, ''),
        path: full,
        sizeMB: Math.round(fs.statSync(full).size / 1048576),
      };
    })
    // Empate (dois modelos fora da lista) desempata pelo maior, que costuma
    // ser o mais capaz. O primeiro da lista é o que o app usa sem ninguém
    // escolher nada.
    .sort((a, b) => modelRank(a.id) - modelRank(b.id) || b.sizeMB - a.sizeMB);
}

/** Estado do motor nativo: o que existe e o que falta. */
function nativeStatus(projectRoot) {
  const paths = nativePaths(projectRoot);
  const cli = paths.cliCandidates.find((c) => fs.existsSync(c)) || null;
  const models = listNativeModels(projectRoot);
  return {
    ok: Boolean(cli) && models.length > 0,
    cli,
    python: firstExisting(paths.pythonCandidates),
    models,
    message: !cli
      ? 'whisper-cli não encontrado em .whisper-cpp/'
      : models.length === 0
        ? 'nenhum modelo .bin em .models/'
        : '',
  };
}

/**
 * Argumentos do Python para transcrever no host.
 *
 * `recordedAt` é o início da gravação em ISO local, e só existe quando foi o
 * app que gravou: o arquivo de vídeo só ganha data quando é fechado, no fim da
 * reunião, e numa reunião longa a diferença é de horas. Vazio deixa o pipeline
 * descobrir a data pelo próprio arquivo, como na importação.
 */
function buildNativeArgs({ videoPath, outputDir, formats, name = '', recordedAt = '' }) {
  return [
    '-m', 'meeting_processor', 'transcribe', videoPath,
    '--output-dir', outputDir,
    '--formats', formats.join(','),
    ...(name ? ['--name', name] : []),
    ...(recordedAt ? ['--recorded-at', recordedAt] : []),
    '--json',
  ];
}

/**
 * Variáveis que apontam o pipeline para o whisper.cpp local.
 *
 * O modelo é escolhido por caminho (não por nome): no backend whisper.cpp o
 * que vale é o arquivo .bin, e é ele que a UI lista.
 */
function buildNativeEnv({ cli, modelPath, language, threads, diarize = false }) {
  return {
    MEETING_WHISPER_BACKEND: 'cpp',
    MEETING_WHISPER_CLI_PATH: cli,
    MEETING_WHISPER_MODEL_PATH: modelPath,
    MEETING_WHISPER_LANGUAGE: language,
    MEETING_WHISPER_DEVICE: 'auto', // deixa o whisper.cpp usar a GPU
    MEETING_WHISPER_THREADS: String(threads || 0),
    // Separar quem fala pelo canal do áudio: microfone à esquerda, som da
    // chamada à direita. O motor ignora o pedido quando a gravação é mono.
    MEETING_WHISPER_DIARIZE: diarize ? '1' : '0',
    // Sem isto o Python escreve o stdout no code page do Windows: o nome de
    // uma reunião acentuada chega corrompido e o caminho deixa de existir.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

/** Como montar o ambiente Python do motor, para a mensagem de erro. */
const VENV_SETUP = 'python -m venv .venv && .venv\\Scripts\\pip install -e .';
const VENV_REPAIR = '.venv\\Scripts\\pip install -e .';

/** O stderr do Python acusa um pacote que não está instalado? Devolve o nome. */
function missingModule(stderr) {
  const m = /No module named ['"]?([\w.]+)/i.exec(String(stderr || ''));
  return m ? m[1].split('.')[0] : '';
}

/**
 * Traduz a última linha do stderr do Python numa mensagem que aponta a saída.
 *
 * Um `ModuleNotFoundError` quase sempre significa que o app caiu no Python
 * global — não havia `.venv` na pasta do projeto — ou que o venv existe mas
 * está incompleto. O traceback cru não diz nada disso a quem usa o app.
 */
function explainNativeFailure(lastError, python, code) {
  const modulo = missingModule(lastError);
  if (modulo) {
    const noVenv = !/[\\/]\.venv[\\/]/.test(String(python || ''));
    return noVenv
      ? `O Python usado pelo motor (${python || 'python'}) não tem o pacote '${modulo}'. `
        + `Crie o ambiente do projeto na pasta do app: ${VENV_SETUP}`
      : `O ambiente .venv está incompleto (falta '${modulo}'). Na pasta do app, rode: ${VENV_REPAIR}`;
  }
  return lastError || `A transcrição terminou com erro (código ${code}).`;
}

module.exports = {
  IMAGE_NAME,
  MODEL_PREFERENCE,
  modelRank,
  MODELS_VOLUME,
  buildDockerArgs,
  toHostPath,
  buildNativeArgs,
  buildNativeEnv,
  explainNativeFailure,
  listNativeModels,
  missingModule,
  nativeStatus,
};
