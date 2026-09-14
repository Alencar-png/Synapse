'use strict';

/**
 * A voz neural do assistente sai do `edge-tts` no Python do app. Aqui o
 * Python é de mentira: o que se fixa é a linha de comando, a leitura do MP3,
 * a queda para a voz do sistema quando algo falta e a limpeza dos temporários.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  DEFAULT_TTS, RATES, VOICES, buildEdgeTtsArgs, isModuleMissing, normalizeTts, rateToMultiplier, synthesize,
} = require('../tts');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-tts-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('normalizeTts completa e recusa voz ou velocidade desconhecida', () => {
  assert.deepStrictEqual(normalizeTts(undefined), DEFAULT_TTS);
  assert.deepStrictEqual(normalizeTts({ engine: 'system' }), { ...DEFAULT_TTS, engine: 'system' });
  assert.deepStrictEqual(normalizeTts({ voice: 'pt-BR-AntonioNeural', rate: '+15%' }), { ...DEFAULT_TTS, voice: 'pt-BR-AntonioNeural', rate: '+15%' });
  assert.deepStrictEqual(normalizeTts({ engine: 'robô', voice: 'inventada', rate: '+300%' }), DEFAULT_TTS);
  assert.strictEqual(normalizeTts({ systemVoice: 'Microsoft Maria Desktop' }).systemVoice, 'Microsoft Maria Desktop');
  assert.strictEqual(normalizeTts({ systemVoice: 42 }).systemVoice, '');
  // Motor que já não existe no app: cai para o padrão, e o resto é descartado.
  assert.deepStrictEqual(normalizeTts({ engine: 'chatterbox', refVoice: 'C:\\vozes\\eu.wav', exaggeration: 0.7 }), DEFAULT_TTS);
  assert.ok(VOICES.some((v) => v.id === DEFAULT_TTS.voice));
  assert.ok(RATES.some((r) => r.id === DEFAULT_TTS.rate));
});

test('rateToMultiplier traduz o percentual para a voz do sistema', () => {
  assert.strictEqual(rateToMultiplier('+5%'), 1.05);
  assert.strictEqual(rateToMultiplier('-10%'), 0.9);
  assert.strictEqual(rateToMultiplier('+0%'), 1);
  assert.strictEqual(rateToMultiplier('lixo'), 1);
  assert.strictEqual(rateToMultiplier('+500%'), 2);
});

test('o texto vai por arquivo, não por argumento', () => {
  const args = buildEdgeTtsArgs({ textFile: 'C:\\t\\fala.txt', voice: 'pt-BR-FranciscaNeural', rate: '+5%', outFile: 'C:\\t\\fala.mp3' });
  assert.deepStrictEqual(args.slice(0, 2), ['-m', 'edge_tts']);
  assert.strictEqual(args[args.indexOf('--file') + 1], 'C:\\t\\fala.txt');
  assert.strictEqual(args[args.indexOf('--write-media') + 1], 'C:\\t\\fala.mp3');
  assert.ok(args.includes('--rate=+5%'));
  assert.ok(!args.includes('--text'));
});

test('isModuleMissing reconhece o Python sem o pacote', () => {
  assert.strictEqual(isModuleMissing("C:\\Python\\python.exe: No module named edge_tts"), true);
  assert.strictEqual(isModuleMissing('ConnectionError: [Errno 11001]'), false);
});

test('synthesize devolve o MP3 e limpa txt e mp3 temporários', async () => {
  const run = async (python, args) => {
    assert.strictEqual(python, 'python');
    const textFile = args[args.indexOf('--file') + 1];
    assert.strictEqual(fs.readFileSync(textFile, 'utf-8'), 'Olá, tudo bem?');
    fs.writeFileSync(args[args.indexOf('--write-media') + 1], Buffer.from([0xff, 0xfb, 0x90]));
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await synthesize({ text: '  Olá, tudo bem?  ', voice: 'pt-BR-FranciscaNeural', rate: '+5%', run, tmpDir: tmp });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mimeType, 'audio/mpeg');
  assert.strictEqual(r.audio.length, 3);
  assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('synapse-fala-')), []);
});

test('sem o pacote: cai para a voz do sistema com instrução de instalação', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: "python.exe: No module named edge_tts" });
  const r = await synthesize({ text: 'x', voice: 'v', rate: '+0%', run, tmpDir: tmp });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fallback, true);
  assert.match(r.message, /pip install edge-tts/);
});

test('sem internet (ou outro erro): cai para a voz do sistema com o motivo', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'aiohttp.client_exceptions.ClientConnectorError: Cannot connect' });
  const r = await synthesize({ text: 'x', voice: 'v', rate: '+0%', run, tmpDir: tmp });
  assert.strictEqual(r.fallback, true);
  assert.match(r.message, /Cannot connect/);
});

test('texto vazio não chama nada', async () => {
  let chamado = false;
  const r = await synthesize({ text: '   ', voice: 'v', rate: '+0%', run: async () => { chamado = true; }, tmpDir: tmp });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fallback, false);
  assert.strictEqual(chamado, false);
});
