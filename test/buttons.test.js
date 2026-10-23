// Card buttons a script sets: a press is recorded for the script; a button with `input`
// asks the user for text first, and the press carries it. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, startBoard, stopBoard } from './helpers.js';

let board;

before(async () => {
  board = await startBoard(true);
});

after(() => stopBoard(board));

test('a button that asks for text records the text with the press', async () => {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Talked about it in person' }, board.token)).body;
  const buttons = [{ id: 'start', label: '▶ Start' },
    { id: 'context', label: '＋ Context', input: 'What should the agent know?' }];
  assert.equal((await call(board, 'PATCH', `/api/cards/${cardId}`, { buttons }, board.token)).status, 200);
  const card = (await call(board, 'GET', `/api/cards/${cardId}`, undefined, board.token)).body.card;
  assert.equal(card.buttons[1].input, 'What should the agent know?');
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'context' }, board.token)).status, 400);
  const pressed = await call(board, 'POST', `/api/cards/${cardId}/press`,
    { button: 'context', text: '  We agreed to skip invoice 9.  ' }, board.token);
  assert.deepEqual([pressed.status, pressed.body.pressed.button, pressed.body.pressed.text],
    [200, 'context', 'We agreed to skip invoice 9.']);
  const plain = await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'start', text: 'ignored' }, board.token);
  assert.equal(plain.body.pressed.text, undefined);   // a plain button takes no text
});

test('a script clears only the press it handled; a newer one waits for it', async () => {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Two presses' }, board.token)).body;
  const buttons = [{ id: 'start', label: '▶ Start' }, { id: 'context', label: '＋ Context', input: 'Context?' }];
  await call(board, 'PATCH', `/api/cards/${cardId}`, { buttons }, board.token);
  const handled = (await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'start' }, board.token)).body.pressed;
  await new Promise((resolve) => setTimeout(resolve, 5));   // a later press has a later `at`
  await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'context', text: 'made while the script was busy' }, board.token);
  const kept = await call(board, 'PATCH', `/api/cards/${cardId}`, { pressed: null, pressedAt: handled.at }, board.token);
  assert.deepEqual([kept.status, kept.body.pressed.button], [200, 'context']);
  const cleared = await call(board, 'PATCH', `/api/cards/${cardId}`, { pressed: null, pressedAt: kept.body.pressed.at }, board.token);
  assert.equal(cleared.body.pressed, undefined);
  await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'start' }, board.token);
  assert.equal((await call(board, 'PATCH', `/api/cards/${cardId}`, { pressed: null }, board.token)).body.pressed, undefined);   // as before
  assert.equal((await call(board, 'PATCH', `/api/cards/${cardId}`, { pressedAt: 'x' }, board.token)).status, 400);
});

test('a card asked of an agent is made with ▶ Start pressed, and its details', async () => {
  const { workspaceId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Puts the Inbox up' }, board.token)).body;
  const make = (body) => call(board, 'POST', `/api/workspaces/${workspaceId}/cards`, body, board.token);
  const asked = await make({ title: 'Why did the nightly build slow down?', description: '  Since Tuesday.  ', start: true });
  assert.deepEqual([asked.status, asked.body.description, asked.body.pressed.button], [201, 'Since Tuesday.', 'start']);
  const plain = await make({ title: 'Just a card' });
  assert.deepEqual([plain.status, plain.body.description, plain.body.pressed], [201, '', undefined]);
  assert.equal((await make({ title: 'x', start: 'yes' })).status, 400);
  assert.equal((await make({ title: 'x', description: 7 })).status, 400);
  const workspace = (await call(board, 'GET', `/api/workspaces/${workspaceId}`, undefined, board.token)).body;
  const done = workspace.binders.find((binder) => binder.title === 'Done');
  assert.equal((await make({ title: 'Set aside', start: true, binderId: done.id })).status, 400);   // never taken there
  assert.equal((await make({ title: 'Set aside', binderId: done.id })).status, 201);
});

test('a ▶ Start still waiting goes when the card is closed; another script\'s press stays', async () => {
  const { workspaceId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Puts the Inbox up' }, board.token)).body;
  const workspace = (await call(board, 'GET', `/api/workspaces/${workspaceId}`, undefined, board.token)).body;
  const column = (title) => workspace.binders.find((binder) => binder.title === title).id;
  const waiting = (await call(board, 'POST', `/api/workspaces/${workspaceId}/cards`,
    { title: 'Waits for a free agent', start: true, binderId: column('New') }, board.token)).body;
  await call(board, 'POST', `/api/cards/${waiting.id}/move`, { binderId: column('Working') }, board.token);
  assert.equal((await call(board, 'GET', `/api/cards/${waiting.id}`, undefined, board.token)).body.card.pressed.button, 'start');
  await call(board, 'POST', `/api/cards/${waiting.id}/move`, { binderId: column("Won't do") }, board.token);
  assert.equal((await call(board, 'GET', `/api/cards/${waiting.id}`, undefined, board.token)).body.card.pressed, undefined);
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Approve the refund' }, board.token)).body;
  await call(board, 'PATCH', `/api/cards/${cardId}`, { buttons: [{ id: 'approve', label: 'Approve' }] }, board.token);
  await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'approve' }, board.token);
  await call(board, 'POST', `/api/cards/${cardId}/move`, { binderId: column('Done') }, board.token);
  assert.equal((await call(board, 'GET', `/api/cards/${cardId}`, undefined, board.token)).body.card.pressed.button, 'approve');
});

test('three buttons on the card, and two more in the open card with place "open"', async () => {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Many buttons' }, board.token)).body;
  const button = (id, place) => ({ id, label: id, ...(place ? { place } : {}) });
  const fine = [button('a'), button('b'), button('c'), button('d', 'open'), button('e', 'open')];
  const set = await call(board, 'PATCH', `/api/cards/${cardId}`, { buttons: fine }, board.token);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.buttons.map((each) => [each.id, each.place ?? null]),
    [['a', null], ['b', null], ['c', null], ['d', 'open'], ['e', 'open']]);
  for (const buttons of [[...fine.slice(0, 3), button('d')], [...fine, button('f', 'open')], [button('a', 'elsewhere')]]) {
    assert.equal((await call(board, 'PATCH', `/api/cards/${cardId}`, { buttons }, board.token)).status, 400);
  }
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/press`, { button: 'd' }, board.token)).status, 200);
});
