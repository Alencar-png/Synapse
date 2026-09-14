'use strict';

/**
 * A voz do assistente: texto vira áudio com prosódia.
 *
 * A síntese do sistema (speechSynthesis, no renderer) funciona offline, mas
 * a voz "Maria" do Windows lê tudo no mesmo tom. Para uma conversa por voz
 * valer a pena, a resposta precisa soar falada — e as vozes neurais do Edge
 * (pt-BR Francisca, Antônio, Thalita) fazem isso de graça, sem chave, via o
 * pacote `edge-tts` no Python do app. A troca é precisar de internet na hora
 * de falar; sem ela, o renderer cai para a voz do sistema.
 *
 * O texto vai por arquivo (`--file`): como argumento, uma resposta longa com
 * aspas e quebras não sobrevive à linha de comando do Windows.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Vozes pt-BR do serviço, com o rótulo que a pessoa vê.
const VOICES = [
  { id: 'pt-BR-FranciscaNeural', label: 'Francisca — feminina, natural' },
  { id: 'pt-BR-AntonioNeural', label: 'Antônio — masculina, natural' },
  { id: 'pt-BR-ThalitaMultilingualNeural', label: 'Thalita — feminina, multilíngue' },
];

const RATES = [
  { id: '-10%', label: 'mais devagar' },
  { id: '+0%', label: 'normal' },
  { id: '+5%', label: 'um pouco mais rápido' },
  { id: '+15%', label: 'mais rápido' },
  { id: '+25%', label: 'bem mais rápido' },
];

// Dois motores:
// - neural: vozes do Edge (edge-tts), online, gratuitas.
// - system: a voz instalada no sistema, offline, sem prosódia.
// `systemVoice` é o nome de uma voz do sistema (a lista vem do renderer).
const ENGINES = ['neural', 'system'];
const DEFAULT_TTS = Object.freeze({
  engine: 'neural', voice: VOICES[0].id, rate: '+5%', systemVoice: '',
});

/** Completa o que falta e recusa voz ou velocidade que não existem. */
function normalizeTts(raw) {
  const tts = { ...DEFAULT_TTS };
  if (!raw || typeof raw !== 'object') return tts;
  if (ENGINES.includes(raw.engine)) tts.engine = raw.engine;
  if (VOICES.some((v) => v.id === raw.voice)) tts.voice = raw.voice;
  if (RATES.some((r) => r.id === raw.rate)) tts.rate = raw.rate;
  if (typeof raw.systemVoice === 'string') tts.systemVoice = raw.systemVoice.slice(0, 120);
  return tts;
}

/** "+5%" → 1.05, para a voz do sistema, que fala em multiplicador. */
function rateToMultiplier(rate) {
  const pct = Number(String(rate || '+0%').replace('%', ''));
  return Number.isFinite(pct) ? Math.min(2, Math.max(0.5, 1 + pct / 100)) : 1;
}

function buildEdgeTtsArgs({ textFile, voice, rate, outFile }) {
  return ['-m', 'edge_tts', '--voice', voice, `--rate=${rate}`, '--file', textFile, '--write-media', outFile];
}

/** O erro de quem não tem o pacote: a mensagem diz como instalar. */
function isModuleMissing(stderr) {
  return /No module named ['"]?edge_tts/i.test(String(stderr || ''));
}

/**
 * Sintetiza o texto e devolve o MP3 em memória. Os temporários somem no fim.
 * Falha vira `{ ok: false, fallback: true, message }` — o renderer lê com a
 * voz do sistema e avisa uma vez.
 */
async function synthesize({ text, voice, rate, python = 'python', run, tmpDir = os.tmpdir() }) {
  const limpo = String(text || '').trim();
  if (!limpo) return { ok: false, fallback: false, message: 'Nada para falar.' };

  const base = path.join(tmpDir, `synapse-fala-${Date.now()}-${process.pid}`);
  const textFile = `${base}.txt`;
  const outFile = `${base}.mp3`;
  try {
    fs.writeFileSync(textFile, limpo, 'utf-8');
    const r = await run(python, buildEdgeTtsArgs({ textFile, voice, rate, outFile }));
    if (r.code !== 0) {
      if (isModuleMissing(r.stderr)) {
        return { ok: false, fallback: true, message: 'Voz neural indisponível: instale com `pip install edge-tts`. Usando a voz do sistema.' };
      }
      const motivo = String(r.stderr || '').split('\n').filter(Boolean).pop() || 'sem detalhe';
      return { ok: false, fallback: true, message: `Voz neural indisponível agora (${motivo}). Usando a voz do sistema.` };
    }
    let audio;
    try {
      audio = fs.readFileSync(outFile);
    } catch {
      return { ok: false, fallback: true, message: 'A voz neural não gerou áudio. Usando a voz do sistema.' };
    }
    if (!audio.length) return { ok: false, fallback: true, message: 'A voz neural devolveu áudio vazio. Usando a voz do sistema.' };
    return { ok: true, audio, mimeType: 'audio/mpeg' };
  } finally {
    for (const f of [textFile, outFile]) {
      try { fs.unlinkSync(f); } catch { /* já removido ou nunca criado */ }
    }
  }
}

module.exports = {
  DEFAULT_TTS,
  ENGINES,
  RATES,
  VOICES,
  buildEdgeTtsArgs,
  isModuleMissing,
  normalizeTts,
  rateToMultiplier,
  synthesize,
};
