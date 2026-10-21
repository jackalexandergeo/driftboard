// Undo puts back the last deleted card or column; redo deletes it again; a new deletion
// forgets what redo could do. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, startBoard, stopBoard } from './helpers.js';

let board;

before(async () => {
  board = await startBoard(true);
});

after(() => stopBoard(board));

const inbox = async (workspaceId) => (await call(board, 'GET', `/api/workspaces/${workspaceId}`, undefined, board.token)).body;

test('redo deletes again what undo brought back, card and column alike', async () => {
  const { cardId, workspaceId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Undo me' }, board.token)).body;
  await call(board, 'DELETE', `/api/cards/${cardId}`, undefined, board.token);
  assert.equal((await call(board, 'POST', '/api/undo', undefined, board.token)).body.ok, true);
  assert.ok((await inbox(workspaceId)).cards.some((card) => card.id === cardId));
  assert.equal((await call(board, 'POST', '/api/redo', undefined, board.token)).body.ok, true);
  assert.ok(!(await inbox(workspaceId)).cards.some((card) => card.id === cardId));
  assert.equal((await call(board, 'POST', '/api/undo', undefined, board.token)).body.ok, true);   // and back again
  assert.ok((await inbox(workspaceId)).cards.some((card) => card.id === cardId));

  const column = (await inbox(workspaceId)).binders.find((binder) => binder.title === 'Review');
  await call(board, 'DELETE', `/api/binders/${column.id}`, undefined, board.token);
  await call(board, 'POST', '/api/undo', undefined, board.token);
  assert.equal((await call(board, 'POST', '/api/redo', undefined, board.token)).body.kind, 'binder');
  assert.ok(!(await inbox(workspaceId)).binders.some((binder) => binder.id === column.id));
});

test('a new deletion forgets what redo could do', async () => {
  const first = (await call(board, 'POST', '/api/items', { source: 'test', title: 'First' }, board.token)).body;
  const second = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Second' }, board.token)).body;
  await call(board, 'DELETE', `/api/cards/${first.cardId}`, undefined, board.token);
  await call(board, 'POST', '/api/undo', undefined, board.token);
  await call(board, 'DELETE', `/api/cards/${second.cardId}`, undefined, board.token);
  assert.deepEqual((await call(board, 'POST', '/api/redo', undefined, board.token)).body, { ok: false, empty: true });
  assert.ok((await inbox(first.workspaceId)).cards.some((card) => card.id === first.cardId));
});
