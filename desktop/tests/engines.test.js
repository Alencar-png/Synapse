'use strict';

/**
 * O motor nativo roda o Python do projeto. Quando o `.venv` não existe, o app
 * cai no Python do PATH, que não tem as dependências, e o pipeline morre com
 * um `ModuleNotFoundError`. O que se fixa aqui é que essa falha chega à janela
 * como uma instrução de conserto, não como traceback.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  buildNativeEnv, explainNativeFailure, listNativeModels, missingModule, modelRank,
  nativeStatus,
} = require('../engines');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-engines-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('missingModule extrai o pacote do traceback e ignora outros erros', () => {
  assert.strictEqual(missingModule("ModuleNotFoundError: No module named 'yaml'"), 'yaml');
  assert.strictEqual(missingModule('No module named edge_tts'), 'edge_tts');
  assert.strictEqual(missingModule("No module named 'pydantic.fields'"), 'pydantic');
  assert.strictEqual(missingModule('RuntimeError: ffmpeg not found'), '');
  assert.strictEqual(missingModule(''), '');
  assert.strictEqual(missingModule(undefined), '');
});

test('sem .venv, a falta de pacote manda criar o ambiente do projeto', () => {
  const msg = explainNativeFailure(
    "ModuleNotFoundError: No module named 'yaml'",
    'C:\\Python312\\python.exe',
    1,
  );
  assert.match(msg, /C:\\Python312\\python\.exe/);
  assert.match(msg, /'yaml'/);
  assert.match(msg, /python -m venv \.venv/);
  assert.match(msg, /pip install -e \./);
});

test('com .venv, a falta de pacote manda só reinstalar', () => {
  const win = explainNativeFailure('No module named yaml', 'C:\\app\\.venv\\Scripts\\python.exe', 1);
  assert.match(win, /\.venv está incompleto/);
  assert.doesNotMatch(win, /python -m venv/);

  const posix = explainNativeFailure('No module named yaml', '/app/.venv/bin/python', 1);
  assert.match(posix, /\.venv está incompleto/);
});

test('outros erros passam como vieram; sem detalhe, vai o código de saída', () => {
  assert.strictEqual(explainNativeFailure('RuntimeError: sem áudio', 'python', 1), 'RuntimeError: sem áudio');
  assert.strictEqual(explainNativeFailure('', 'python', 3), 'A transcrição terminou com erro (código 3).');
});

test('nativeStatus prefere o .venv do projeto e cai no python do PATH sem ele', () => {
  assert.strictEqual(nativeStatus(tmp).python, 'python');

  const venvPython = path.join(tmp, '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, '');
  assert.strictEqual(nativeStatus(tmp).python, venvPython);
});

/**
 * Qual modelo o app usa quando ninguém escolhe nenhum.
 *
 * A pergunta importa porque a resposta errada é silenciosa: a transcrição sai
 * do mesmo jeito, só com mais erro de nome e de número — e é dela que saem as
 * tarefas e o documento. Ordem alfabética e ordem por tamanho dão as duas
 * respostas erradas, cada uma à sua maneira.
 */
test('a lista de modelos vem do mais fiel para o mais leve', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'modelos-'));
  fs.mkdirSync(path.join(dir, '.models'));
  const escrever = (nome, mb) =>
    fs.writeFileSync(path.join(dir, '.models', nome), Buffer.alloc(mb * 1048576));

  escrever('ggml-large-v3-turbo.bin', 3);  // menor e alfabeticamente antes
  escrever('ggml-large-v3.bin', 6);
  escrever('ggml-small.bin', 1);
  escrever('ggml-silero-v5.1.2.bin', 1);   // VAD: não transcreve, não conta

  const ids = listNativeModels(dir).map((m) => m.id);
  assert.deepStrictEqual(ids, ['large-v3', 'large-v3-turbo', 'small']);
});

test('modelRank põe large-v3 na frente do turbo e o desconhecido no fim', () => {
  assert.ok(modelRank('large-v3') < modelRank('large-v3-turbo'));
  assert.ok(modelRank('large-v3-turbo') < modelRank('medium'));
  assert.ok(modelRank('medium') < modelRank('tiny'));
  assert.ok(modelRank('tiny') < modelRank('modelo-caseiro'));
  // Uma variante não listada fica junto da família, não no fim do mundo.
  assert.ok(modelRank('large-v3-q5_0') < modelRank('modelo-caseiro'));
});

test('buildNativeEnv leva o pedido de marcar quem fala ao motor', () => {
  const base = { cli: 'C:\w\whisper-cli.exe', modelPath: 'C:\m\ggml-large-v3.bin', language: 'pt' };

  assert.strictEqual(buildNativeEnv({ ...base, diarize: true }).MEETING_WHISPER_DIARIZE, '1');
  assert.strictEqual(buildNativeEnv({ ...base, diarize: false }).MEETING_WHISPER_DIARIZE, '0');
  // Sem dizer nada, não marca: a opção é uma escolha, não um efeito colateral.
  assert.strictEqual(buildNativeEnv(base).MEETING_WHISPER_DIARIZE, '0');
});
