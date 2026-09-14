'use strict';

/**
 * O que o Synapse pede ao OBS: gravar a reunião e devolver o arquivo.
 *
 * Duas coisas justificam usar o OBS em vez de gravar pelo navegador:
 *
 * 1. **Trilhas separadas.** O OBS grava o microfone e o áudio da área de
 *    trabalho em faixas distintas do mesmo arquivo. Isso é melhor do que
 *    misturar as duas fontes nos canais de um estéreo: não há vazamento de um
 *    lado para o outro, e a separação entre "eu" e "eles" na transcrição sai
 *    limpa. Para isso o perfil precisa estar no modo Avançado com mais de uma
 *    faixa ligada — `recordingTracks` conta o que está configurado, e o app
 *    avisa quando só há uma.
 *
 * 2. **Ele não depende da janela do app.** A gravação segue se o Synapse for
 *    minimizado, e sobrevive ao que acontecer com a interface.
 *
 * As funções aqui são a parte que fala com o OBS de verdade; o servidor MCP
 * apenas as expõe como ferramentas.
 */

const { withObs } = require('./obs-websocket');

// Bitmask das faixas de áudio gravadas, no perfil Avançado do OBS: bit 0 é a
// faixa 1, bit 1 a faixa 2, e assim por diante.
const TRACK_PARAMETER = { category: 'AdvOut', name: 'RecTracks' };
const OUTPUT_MODE_PARAMETER = { category: 'Output', name: 'Mode' };

/** Quantas faixas de áudio a bitmask do perfil liga. */
function countTracks(bitmask) {
  const n = Number.parseInt(String(bitmask ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n.toString(2).split('').filter((b) => b === '1').length;
}

/** Lê um parâmetro do perfil sem derrubar tudo quando ele não existe. */
async function readParameter(client, { category, name }) {
  try {
    const r = await client.request('GetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
    });
    return r.parameterValue ?? r.defaultParameterValue ?? '';
  } catch {
    return '';
  }
}

/**
 * Em que pé está o OBS: versão, se grava agora e como o áudio está separado.
 *
 * É o que a tela de Configurações mostra e o que a gravação consulta antes de
 * decidir se usa o OBS ou a captura do próprio app.
 */
async function status(options) {
  return withObs(options, async (client) => {
    const [version, record, modo, tracks, pasta] = await Promise.all([
      client.request('GetVersion'),
      client.request('GetRecordStatus'),
      readParameter(client, OUTPUT_MODE_PARAMETER),
      readParameter(client, TRACK_PARAMETER),
      client.request('GetRecordDirectory').catch(() => ({})),
    ]);

    const advanced = String(modo).toLowerCase() === 'advanced';
    const recordingTracks = advanced ? countTracks(tracks) : 1;
    return {
      connected: true,
      obsVersion: version.obsVersion,
      websocketVersion: version.obsWebSocketVersion,
      platform: version.platformDescription,
      recording: Boolean(record.outputActive),
      paused: Boolean(record.outputPaused),
      recordingTracks,
      // Uma faixa só significa tudo misturado — dá para gravar, mas não dá
      // para dizer quem falou. A interface transforma isso num aviso.
      separateAudioTracks: recordingTracks > 1,
      outputDirectory: pasta.recordDirectory || '',
    };
  });
}

async function startRecording(options) {
  return withObs(options, async (client) => {
    const atual = await client.request('GetRecordStatus');
    if (atual.outputActive) {
      // Assumir uma gravação que já estava rodando levaria o app a parar,
      // no fim, algo que ele não começou — e a entregar como reunião um
      // arquivo que era de outra coisa.
      throw new Error('O OBS já está gravando. Pare a gravação atual antes de começar pelo app.');
    }
    await client.request('StartRecord');
    return { started: true };
  });
}

/**
 * Encerra a gravação e devolve o caminho do arquivo.
 *
 * `StopRecord` responde com `outputPath` — é por ele que o Synapse encontra o
 * vídeo para transcrever, em vez de adivinhar pelo nome na pasta de saída.
 */
async function stopRecording(options) {
  return withObs(options, async (client) => {
    const atual = await client.request('GetRecordStatus');
    if (!atual.outputActive) throw new Error('O OBS não está gravando.');
    const r = await client.request('StopRecord');
    return {
      stopped: true,
      outputPath: r.outputPath || '',
      durationSeconds: Math.round((atual.outputDuration || 0) / 1000),
    };
  });
}

async function recordingStatus(options) {
  return withObs(options, async (client) => {
    const r = await client.request('GetRecordStatus');
    return {
      recording: Boolean(r.outputActive),
      paused: Boolean(r.outputPaused),
      durationSeconds: Math.round((r.outputDuration || 0) / 1000),
      sizeBytes: r.outputBytes || 0,
    };
  });
}

/** Pausa ou retoma — o que falta na gravação do próprio app (REC-02). */
async function pauseRecording(options, { resume = false } = {}) {
  return withObs(options, async (client) => {
    await client.request(resume ? 'ResumeRecord' : 'PauseRecord');
    return { paused: !resume };
  });
}

module.exports = {
  OUTPUT_MODE_PARAMETER,
  TRACK_PARAMETER,
  countTracks,
  pauseRecording,
  recordingStatus,
  startRecording,
  status,
  stopRecording,
};
