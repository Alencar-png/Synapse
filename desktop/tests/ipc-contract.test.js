'use strict';

/**
 * O contrato entre as três camadas do app, conferido por leitura do código.
 *
 * A janela só fala com o processo principal pela ponte do `preload.js`, e cada
 * elo dessa corrente quebra em silêncio: um canal exposto sem handler devolve
 * uma promessa que nunca resolve; um `window.api.x` que não existe no preload
 * estoura só quando alguém clica no botão; um modal que não entra na lista de
 * fechar fica aberto para sempre, com a operação já feita por trás.
 *
 * Nada disso aparece num teste de unidade normal — e os três já aconteceram
 * neste app. Aqui a conferência é estática: não abre Electron, não abre janela,
 * e roda em milissegundos junto do resto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ler = (arquivo) => fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf-8');

const MAIN = ler('main.js');
const PRELOAD = ler('preload.js');
const RENDERER = ler(path.join('renderer', 'app.js'));
const HTML = ler(path.join('renderer', 'index.html'));
const MOCK = ler(path.join('renderer', 'mock-api.js'));

/** Tudo que casa com o padrão, sem repetição. */
const todos = (texto, regex) => [...new Set([...texto.matchAll(regex)].map((m) => m[1]))];

test('todo canal exposto no preload tem handler no processo principal', () => {
  const expostos = todos(PRELOAD, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
  const tratados = new Set(todos(MAIN, /ipcMain\.handle\(\s*'([^']+)'/g));

  assert.ok(expostos.length > 30, 'a ponte deveria expor dezenas de canais');
  const órfãos = expostos.filter((canal) => !tratados.has(canal));
  assert.deepEqual(órfãos, [], `canais sem handler no main: ${órfãos.join(', ')}`);
});

test('todo handler do processo principal é alcançável pela ponte', () => {
  const tratados = todos(MAIN, /ipcMain\.handle\(\s*'([^']+)'/g);
  const expostos = new Set(todos(PRELOAD, /ipcRenderer\.invoke\(\s*'([^']+)'/g));

  const inúteis = tratados.filter((canal) => !expostos.has(canal));
  assert.deepEqual(inúteis, [], `handlers que ninguém pode chamar: ${inúteis.join(', ')}`);
});

test('todo evento que a janela escuta é anunciado pelo preload', () => {
  const declarados = new Set(todos(PRELOAD, /^\s*'([a-z]+:[a-zA-Z]+)':\s*new Set\(\)/gm));
  const escutados = todos(RENDERER, /window\.api\.on\(\s*'([^']+)'/g);

  const desconhecidos = escutados.filter((canal) => !declarados.has(canal));
  assert.deepEqual(desconhecidos, [], `eventos sem canal no preload: ${desconhecidos.join(', ')}`);
});

test('todo window.api que a janela usa existe na ponte', () => {
  const usados = todos(RENDERER, /window\.api\.(\w+)\s*\(/g).filter((n) => n !== 'on');
  const oferecidos = new Set([
    ...todos(PRELOAD, /^\s*(\w+):\s*\(/gm),
    ...todos(PRELOAD, /^\s*(\w+):\s*async/gm),
  ]);

  const faltando = usados.filter((nome) => !oferecidos.has(nome));
  assert.deepEqual(faltando, [], `métodos ausentes no preload: ${faltando.join(', ')}`);
});

test('a demonstração no navegador acompanha a ponte', () => {
  // O mock-api substitui a ponte quando o app roda sem Electron (a demo e os
  // testes de interface). Um método novo que não chega lá deixa a demo quebrada
  // num clique específico, que é o tipo de coisa que ninguém percebe a tempo.
  const oferecidos = todos(PRELOAD, /^\s*(\w+):\s*\(/gm).filter((n) => n !== 'on');
  const noMock = new Set([
    ...todos(MOCK, /^\s*async (\w+)\(/gm),
    ...todos(MOCK, /^\s*(\w+)\(/gm),
    ...todos(MOCK, /^\s*(\w+):\s*\(/gm),
  ]);

  const faltando = oferecidos.filter((nome) => !noMock.has(nome));
  assert.deepEqual(faltando, [], `métodos ausentes no mock-api: ${faltando.join(', ')}`);
});

test('todo modal do HTML é fechado por closeModals', () => {
  // Um modal fora da lista fica aberto depois de salvar: a operação acontece,
  // a tela não muda, e quem está usando repete a ação achando que falhou.
  const noHtml = todos(HTML, /<div class="modal[^"]*" id="(modal-[\w-]+)"/g);
  const fechados = new Set([
    ...todos(RENDERER, /'(modal-[\w-]+)'/g),
  ]);

  assert.ok(noHtml.length >= 5, 'o app deveria ter vários modais');
  const esquecidos = noHtml.filter((id) => !fechados.has(id));
  assert.deepEqual(esquecidos, [], `modais que o renderer nunca menciona: ${esquecidos.join(', ')}`);

  // A lista de closeModals, especificamente. Duas exceções legítimas:
  // `modal-danger` tem fechamento próprio (closeDanger, que também resolve a
  // promessa da confirmação) e `modal-scrim` é o fundo escuro, escondido na
  // primeira linha de closeModals — não é um modal.
  const àParte = ['modal-danger', 'modal-scrim'];
  const lista = /for \(const id of \[([^\]]+)\]\) \{?\s*\$\(id\)\.hidden = true;/.exec(RENDERER);
  assert.ok(lista, 'closeModals deveria varrer uma lista de ids');
  const naLista = new Set(todos(lista[1], /'(modal-[\w-]+)'/g));
  const ausentes = noHtml.filter((id) => !àParte.includes(id) && !naLista.has(id));
  assert.deepEqual(ausentes, [], `modais fora de closeModals: ${ausentes.join(', ')}`);
});
