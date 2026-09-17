'use strict';

/**
 * Tarefas do Kanban.
 *
 * Uma tarefa pertence a um projeto e, quando veio de uma reunião, guarda o id
 * dela — é o que permite abrir a reunião de origem a partir do card e desenhar
 * a aresta tarefa→reunião no grafo.
 *
 * Moram no `synapse.db`, dentro da pasta de saída (ver `db.js`).
 */

const db = require('./db');

const STATUSES = ['backlog', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

/** Converte a linha do banco para o vocabulário do resto do app. */
function toTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    meetingId: row.meeting_id,
    title: row.title,
    description: row.description,
    assignee: row.assignee,
    priority: row.priority,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normaliza campos vindos da UI ou da extração da IA. */
function sanitize(data, existente = {}) {
  return {
    title: String(data.title ?? existente.title ?? '').trim(),
    description: String(data.description ?? existente.description ?? '').trim(),
    assignee: String(data.assignee ?? existente.assignee ?? '').trim(),
    projectId: String(data.projectId ?? existente.projectId ?? ''),
    meetingId: String(data.meetingId ?? existente.meetingId ?? ''),
    status: STATUSES.includes(data.status) ? data.status : existente.status || 'backlog',
    priority: PRIORITIES.includes(data.priority)
      ? data.priority
      : existente.priority || 'medium',
  };
}

/** Tarefas de um projeto, mais recentes primeiro dentro de cada coluna. */
function listTasks(dir, projectId) {
  const conn = db.open(dir);
  if (!conn) return [];
  const linhas = projectId
    ? conn.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
    : conn.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  return linhas.map(toTask);
}

/** Quantas tarefas abertas cada projeto tem — para a listagem e o painel. */
function openCountByProject(dir) {
  const conn = db.open(dir);
  if (!conn) return {};
  const linhas = conn.prepare(`
    SELECT project_id, COUNT(*) AS total
      FROM tasks WHERE status <> 'done' GROUP BY project_id
  `).all();
  return Object.fromEntries(linhas.map((l) => [l.project_id, l.total]));
}

function novoId(conn, sufixo = 0) {
  const id = `t-${Date.now().toString(36)}-${sufixo}`;
  return conn.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id) ? novoId(conn, sufixo + 1) : id;
}

function saveTask(dir, data) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };

  if (data.id) {
    const atual = conn.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id);
    if (!atual) return { ok: false, message: 'Tarefa não encontrada.' };
    const campos = sanitize(data, toTask(atual));
    if (!campos.title) return { ok: false, message: 'Dê um título à tarefa.' };
    conn.prepare(`
      UPDATE tasks SET project_id = ?, meeting_id = ?, title = ?, description = ?,
                       assignee = ?, priority = ?, status = ?, updated_at = ?
       WHERE id = ?
    `).run(
      campos.projectId, campos.meetingId, campos.title, campos.description,
      campos.assignee, campos.priority, campos.status, Date.now(), data.id,
    );
    return { ok: true, id: data.id };
  }

  const campos = sanitize(data);
  if (!campos.title) return { ok: false, message: 'Dê um título à tarefa.' };
  if (!campos.projectId) return { ok: false, message: 'A tarefa precisa de um projeto.' };

  const id = novoId(conn);
  conn.prepare(`
    INSERT INTO tasks (id, project_id, meeting_id, title, description, assignee,
                       priority, status, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
  `).run(
    id, campos.projectId, campos.meetingId, campos.title, campos.description,
    campos.assignee, campos.priority, campos.status, Date.now(),
  );
  return { ok: true, id };
}

/** Move o card entre colunas do Kanban. */
function moveTask(dir, id, status) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  if (!STATUSES.includes(status)) return { ok: false, message: 'Coluna desconhecida.' };
  const r = conn.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
  if (!r.changes) return { ok: false, message: 'Tarefa não encontrada.' };
  return { ok: true };
}

function deleteTask(dir, id) {
  const conn = db.open(dir);
  if (!conn) return { ok: false, message: 'Pasta de saída indisponível.' };
  const r = conn.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (!r.changes) return { ok: false, message: 'Tarefa não encontrada.' };
  return { ok: true };
}

/**
 * Cria em lote as tarefas extraídas de uma reunião (AI-02). Ignora as sem
 * título em vez de falhar o lote inteiro: a extração é heurística e uma
 * entrada ruim não deve custar as outras.
 */
function createFromExtraction(dir, { projectId, meetingId, items }) {
  const conn = db.open(dir);
  if (!conn || !projectId || !Array.isArray(items) || !items.length) return { created: 0 };

  const existe = conn.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!existe) return { created: 0 };

  const agora = Date.now();
  const ins = conn.prepare(`
    INSERT INTO tasks (id, project_id, meeting_id, title, description, assignee,
                       priority, status, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', 'ia', ?)
  `);

  return db.transaction(conn, () => {
    let criadas = 0;
    for (const item of items) {
      const campos = sanitize({ ...item, projectId, meetingId });
      if (!campos.title) continue;
      // O id vem de `novoId`, que consulta o banco, e não do índice desta
      // chamada: duas extrações no mesmo milissegundo cunhariam `t-<ms>-0`
      // duas vezes e a segunda morreria no UNIQUE. Dentro da transação, cada
      // consulta já enxerga o que as linhas anteriores inseriram.
      ins.run(
        novoId(conn), projectId, meetingId, campos.title,
        campos.description, campos.assignee, campos.priority, agora,
      );
      criadas += 1;
    }
    return { created: criadas };
  });
}

/**
 * A reunião foi excluída: as tarefas que nasceram dela vão junto. Excluir é
 * excluir tudo o que é daquela coisa — uma tarefa órfã da reunião que a gerou
 * viraria ruído no Kanban.
 */
function deleteByMeeting(dir, meetingId) {
  const conn = db.open(dir);
  if (!conn || !meetingId) return { deleted: 0 };
  const r = conn.prepare('DELETE FROM tasks WHERE meeting_id = ?').run(meetingId);
  return { deleted: r.changes };
}

/** Acompanha o novo id quando a reunião é renomeada. */
function renameMeeting(dir, oldId, newId) {
  const conn = db.open(dir);
  if (!conn) return;
  conn.prepare('UPDATE tasks SET meeting_id = ? WHERE meeting_id = ?').run(newId, oldId);
}

module.exports = {
  PRIORITIES,
  STATUSES,
  createFromExtraction,
  deleteByMeeting,
  deleteTask,
  listTasks,
  moveTask,
  openCountByProject,
  renameMeeting,
  saveTask,
};
