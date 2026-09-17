'use strict';

/**
 * Excluir leva tudo o que é da coisa excluída: uma reunião leva suas tarefas;
 * um projeto leva vínculos, tarefas e histórico do chat. Disco e banco de
 * verdade, em pastas temporárias.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const db = require('../db');
const library = require('../library');
const projects = require('../projects');
const tasks = require('../tasks');
const chat = require('../chat-messages');

let out;
let work;
let projectId;

function meetingFolder(root, name) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, `${name}.md`), `# ${name}`, 'utf-8');
  fs.writeFileSync(path.join(root, name, 'analise.json'), '{"title":"x"}', 'utf-8');
}

before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-del-out-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-del-work-'));
  projectId = projects.saveProject(out, { name: 'Alpha', workdir: work }).id;
  meetingFolder(path.join(work, 'synapse'), 'Kickoff');
  meetingFolder(path.join(work, 'synapse'), 'Weekly');
});

after(() => {
  db.closeAll();
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('excluir a reunião apaga a pasta e as tarefas que vieram dela', () => {
  const id = `${projectId}::Kickoff`;
  projects.assignMeeting(out, id, projectId);
  tasks.createFromExtraction(out, { projectId, meetingId: id, items: [{ title: 'A' }, { title: 'B' }] });
  tasks.createFromExtraction(out, { projectId, meetingId: `${projectId}::Weekly`, items: [{ title: 'C' }] });
  assert.strictEqual(tasks.listTasks(out, projectId).length, 3);

  const r = library.deleteMeeting(out, id);
  assert.ok(r.ok, r.message);
  assert.ok(!fs.existsSync(path.join(work, 'synapse', 'Kickoff')));

  const apagadas = tasks.deleteByMeeting(out, id);
  assert.strictEqual(apagadas.deleted, 2);
  const restantes = tasks.listTasks(out, projectId);
  assert.deepStrictEqual(restantes.map((t) => t.title), ['C']);
  assert.ok(!library.listMeetings(out).some((m) => m.id === id));
});

test('excluir o projeto apaga vínculos, tarefas e histórico do chat', () => {
  const weekly = `${projectId}::Weekly`;
  projects.assignMeeting(out, weekly, projectId);
  chat.addMessage(out, { projectId, role: 'user', text: 'oi' });
  assert.strictEqual(chat.listMessages(out, projectId).length, 1);

  const r = projects.deleteProject(out, projectId);
  assert.ok(r.ok);
  assert.strictEqual(projects.getProject(out, projectId), null);
  assert.strictEqual(tasks.listTasks(out, projectId).length, 0);
  assert.strictEqual(chat.listMessages(out, projectId).length, 0);
  assert.deepStrictEqual(projects.projectsByMeeting(out), {});
  const conn = db.open(out);
  assert.strictEqual(conn.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 0, 'nenhum vínculo órfão');
});

test('duas extrações no mesmo milissegundo não colidem no id da tarefa', () => {
  // O id era cunhado pelo índice dentro da chamada (`t-<ms>-0`, `t-<ms>-1`),
  // então uma segunda chamada no mesmo milissegundo recomeçava do zero e
  // morria no UNIQUE. Duas reuniões processadas em sequência numa máquina
  // rápida caem exatamente aí — e o CI, que é uma delas, pegou o caso.
  const p = projects.saveProject(out, { name: 'Colisão' }).id;
  for (let i = 0; i < 12; i += 1) {
    const r = tasks.createFromExtraction(out, {
      projectId: p, meetingId: `m-${i}`, items: [{ title: `T${i}a` }, { title: `T${i}b` }],
    });
    assert.strictEqual(r.created, 2, `a extração ${i} não criou as duas tarefas`);
  }

  const criadas = tasks.listTasks(out, p);
  assert.strictEqual(criadas.length, 24);
  assert.strictEqual(new Set(criadas.map((t) => t.id)).size, 24, 'houve id repetido');
});
