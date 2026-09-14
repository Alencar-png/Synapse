'use strict';

/**
 * Cliente MCP por stdio — o lado do app que conversa com um servidor MCP.
 *
 * O Synapse usa isto para falar com o servidor do OBS (`mcp-obs/server.js`),
 * mas nada aqui é sobre OBS: é o protocolo, e só. JSON-RPC 2.0, uma mensagem
 * por linha, no stdin e no stdout de um processo filho.
 *
 * Escrito à mão porque é pouca coisa e porque o app não tem dependências de
 * runtime — cada pacote a mais é código de terceiro rodando na máquina de quem
 * grava as reuniões.
 */

const { spawn } = require('node:child_process');

// Quanto esperar por uma resposta. As ferramentas do OBS têm o próprio limite,
// menor; este é a rede de segurança para um servidor que morreu sem avisar.
const CALL_TIMEOUT_MS = 30000;

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'synapse', version: '1.0.0' };

class McpClient {
  /**
   * @param {object} opcoes
   * @param {string} opcoes.command Executável do servidor.
   * @param {string[]} opcoes.args Argumentos.
   * @param {object} opcoes.env Ambiente extra (é por aqui que a senha passa,
   *   e não por argumento: argumento aparece na lista de processos).
   * @param {Function} opcoes.spawnFn Injetável para teste.
   */
  constructor({ command, args = [], env = {}, cwd, spawnFn = spawn } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.spawnFn = spawnFn;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  get running() {
    return Boolean(this.child) && this.child.exitCode === null;
  }

  /** Sobe o servidor e faz o handshake do protocolo. */
  async start() {
    if (this.running) return this;

    this.child = this.spawnFn(this.command, this.args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });
    // Sem ouvinte, um 'error' de nascimento derruba o processo principal.
    this.child.on('error', (err) => this.#derrubar(`Não deu para abrir o servidor MCP: ${err.message}`));
    this.child.on('exit', () => this.#derrubar('O servidor MCP encerrou.'));

    let buffer = '';
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const linhas = buffer.split('\n');
      buffer = linhas.pop();
      for (const linha of linhas) this.#receber(linha);
    });
    // O stderr do servidor não é protocolo, mas é o que explica uma falha
    // silenciosa — guardamos o fim dele para a mensagem de erro.
    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    // O servidor só pode considerar a sessão pronta depois desta notificação.
    this.notify('notifications/initialized');
    return this;
  }

  #derrubar(motivo) {
    for (const { reject } of this.pending.values()) reject(new Error(motivo));
    this.pending.clear();
  }

  #receber(linha) {
    const texto = linha.trim();
    if (!texto) return;
    let msg;
    try {
      msg = JSON.parse(texto);
    } catch {
      return;   // linha que não é do protocolo (um log solto, por exemplo)
    }
    const espera = this.pending.get(msg.id);
    if (!espera) return;
    this.pending.delete(msg.id);
    if (msg.error) espera.reject(new Error(msg.error.message || 'Erro no servidor MCP.'));
    else espera.resolve(msg.result);
  }

  #enviar(mensagem) {
    this.child.stdin.write(`${JSON.stringify(mensagem)}\n`);
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('O servidor MCP não está no ar.'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`O servidor MCP não respondeu a ${method} a tempo.`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#enviar({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Notificação: sem id, e portanto sem resposta. */
  notify(method, params = {}) {
    if (this.running) this.#enviar({ jsonrpc: '2.0', method, params });
  }

  async listTools() {
    const r = await this.request('tools/list');
    return r?.tools || [];
  }

  /**
   * Chama uma ferramenta e devolve o que ela respondeu, já em objeto.
   *
   * O MCP devolve texto: as ferramentas do OBS respondem JSON, e o que
   * interessa ao app é o objeto. `isError` vira exceção, porque para quem
   * chama é uma falha — não um resultado a interpretar.
   */
  async callTool(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    const texto = (r?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (r?.isError) throw new Error(texto || 'A ferramenta MCP falhou sem dizer o motivo.');
    try {
      return JSON.parse(texto);
    } catch {
      return { text: texto };
    }
  }

  stop() {
    if (!this.child) return;
    this.#derrubar('O servidor MCP foi encerrado.');
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch { /* já morreu */ }
    this.child = null;
  }
}

module.exports = { CALL_TIMEOUT_MS, CLIENT_INFO, McpClient, PROTOCOL_VERSION };
