'use strict';

/**
 * Cliente do obs-websocket v5 — o protocolo que o OBS Studio fala desde a
 * versão 28, embutido, sem plugin.
 *
 * Escrito à mão, sobre o WebSocket que o Node 22 já traz, para o servidor MCP
 * não arrastar dependência nenhuma: o app roda na máquina de quem usa, e cada
 * pacote a mais é código de terceiro rodando junto do áudio das reuniões.
 *
 * O aperto de mão tem três passos:
 *   1. o OBS manda `Hello` (op 0), com o desafio quando exige senha;
 *   2. o cliente responde `Identify` (op 1) com a prova do desafio;
 *   3. o OBS confirma com `Identified` (op 2) e a sessão está aberta.
 *
 * A prova é `base64(sha256(base64(sha256(senha + salt)) + challenge))` — a
 * senha nunca trafega.
 */

const { createHash } = require('node:crypto');

// Códigos de operação do protocolo (os que usamos).
const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, EVENT: 5, REQUEST: 6, RESPONSE: 7 };

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4455;
// O OBS responde na hora quando está aberto. Este tempo existe para o caso de
// ele não estar: sem limite, a janela do app ficaria esperando para sempre.
const CONNECT_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 15000;

const sha256b64 = (texto) => createHash('sha256').update(texto).digest('base64');

/** A resposta ao desafio do OBS. Sem senha configurada, não há prova a dar. */
function authenticationString(password, { challenge, salt }) {
  return sha256b64(sha256b64(String(password) + salt) + challenge);
}

/**
 * Traduz a falha de conexão em algo que se possa agir.
 *
 * "ECONNREFUSED" não diz a ninguém que falta marcar uma caixa em
 * Ferramentas → Servidor WebSocket, dentro do OBS.
 */
function explainConnectionError(err, { host, port }) {
  const texto = String(err?.message || err || '');
  if (/timeout/i.test(texto)) {
    return `O OBS em ${host}:${port} não respondeu a tempo. Ele está aberto?`;
  }
  // Qualquer outra falha de conexão — "ECONNREFUSED", "Received network error
  // or non-101 status code", o que o WebSocket do Node resolver dizer — tem a
  // mesma causa prática e a mesma saída. Repassar o texto cru não ajudaria
  // ninguém a ligar a caixa que falta.
  return `Não achei o OBS em ${host}:${port}. Abra o OBS e ligue `
    + 'Ferramentas → Configurações do Servidor WebSocket → Ativar servidor WebSocket'
    + (texto ? ` (${texto})` : '');
}

/**
 * Uma sessão com o OBS. Abre, conversa, fecha.
 *
 * Deliberadamente sem reconexão automática: cada operação do app é curta
 * (começar a gravar, parar de gravar) e uma conexão pendurada segurando o OBS
 * é pior do que abrir outra quando precisar.
 */
class ObsClient {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, password = '' } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  get url() {
    return `ws://${this.host}:${this.port}`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        reject(new Error(explainConnectionError(err, this)));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(explainConnectionError(new Error('timeout'), this)));
      }, CONNECT_TIMEOUT_MS);

      const fechar = (motivo) => {
        clearTimeout(timer);
        // Quem estava esperando resposta precisa saber que a linha caiu, em
        // vez de ficar pendurado até o timeout de cada pedido.
        for (const { reject: falhar } of this.pending.values()) falhar(new Error(motivo));
        this.pending.clear();
      };

      socket.addEventListener('error', (ev) => {
        fechar(explainConnectionError(ev?.error || ev?.message, this));
        reject(new Error(explainConnectionError(ev?.error || ev?.message, this)));
      });
      socket.addEventListener('close', () => fechar('A conexão com o OBS foi encerrada.'));

      socket.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;   // quadro que não é JSON: não é conversa nossa
        }
        const { op, d } = msg;

        if (op === OP.HELLO) {
          const identify = { rpcVersion: 1 };
          if (d.authentication) {
            if (!this.password) {
              clearTimeout(timer);
              socket.close();
              reject(new Error(
                'O OBS está pedindo senha. Copie a senha em Ferramentas → '
                + 'Configurações do Servidor WebSocket e informe ao app.',
              ));
              return;
            }
            identify.authentication = authenticationString(this.password, d.authentication);
          }
          socket.send(JSON.stringify({ op: OP.IDENTIFY, d: identify }));
          return;
        }

        if (op === OP.IDENTIFIED) {
          clearTimeout(timer);
          resolve(this);
          return;
        }

        if (op === OP.RESPONSE) {
          const espera = this.pending.get(d.requestId);
          if (!espera) return;
          this.pending.delete(d.requestId);
          if (d.requestStatus?.result) {
            espera.resolve(d.responseData || {});
          } else {
            const { code, comment } = d.requestStatus || {};
            espera.reject(new Error(comment || `O OBS recusou ${d.requestType} (código ${code}).`));
          }
        }
      });
    });
  }

  /** Um pedido ao OBS. Resolve com o `responseData`. */
  request(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) {
        reject(new Error('Sem conexão com o OBS.'));
        return;
      }
      const requestId = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`O OBS não respondeu a ${requestType} a tempo.`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.send(JSON.stringify({
        op: OP.REQUEST,
        d: { requestType, requestId, requestData },
      }));
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch { /* já fechado */ }
    this.socket = null;
  }
}

/** Abre a sessão, faz o trabalho e fecha — mesmo se o trabalho falhar. */
async function withObs(options, trabalho) {
  const client = new ObsClient(options);
  await client.connect();
  try {
    return await trabalho(client);
  } finally {
    client.close();
  }
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  OP,
  ObsClient,
  REQUEST_TIMEOUT_MS,
  authenticationString,
  explainConnectionError,
  withObs,
};
