// The agent API: a token minted for one card reaches that card only, and only within the
// working columns. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, startBoard, stopBoard } from './helpers.js';

let board;

before(async () => {
  board = await startBoard(true);
});

after(() => stopBoard(board));

async function newCard(title) {
  const { body } = await call(board, 'POST', '/api/items', { source: 'test', title }, board.token);
  return body;
}

async function cardOf(cardId) {
  return (await call(board, 'GET', `/api/cards/${cardId}`, undefined, board.token)).body.card;
}

async function columnOf(cardId, workspaceId) {
  const workspace = (await call(board, 'GET', `/api/workspaces/${workspaceId}`, undefined, board.token)).body;
  const card = workspace.cards.find((each) => each.id === cardId);
  return workspace.binders.find((binder) => binder.id === card.binderId).title;
}

async function agentFor(cardId) {
  const { status, body } = await call(board, 'POST', `/api/cards/${cardId}/agent`, { name: 'codex' }, board.token);
  assert.equal(status, 201);
  return body.token;
}

test('an agent keeps its own card current: progress, a note, its result', async () => {
  const { cardId } = await newCard('Reconcile the October invoices');
  const token = await agentFor(cardId);
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${cardId}`, { progress: 'reading 12 invoices' }, token)).status, 200);
  assert.equal((await call(board, 'POST', `/api/agent/cards/${cardId}/notes`, { content: 'invoice 7 is in EUR' }, token)).status, 201);
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${cardId}`, { result: '**2 mismatches**: 7 and 9' }, token)).status, 200);
  const card = await cardOf(cardId);
  assert.equal(card.agent.name, 'codex');
  assert.deepEqual([card.agent.progress, card.agent.result], ['reading 12 invoices', '**2 mismatches**: 7 and 9']);
  assert.deepEqual(card.attachments.map((attachment) => [attachment.content, attachment.by]), [['invoice 7 is in EUR', 'codex']]);
});

test("an agent's notes are capped at the newest 200; the user's own stay", async () => {
  const { cardId } = await newCard('Chatty');
  await call(board, 'POST', `/api/cards/${cardId}/attachments`, { type: 'text', content: 'my own note' }, board.token);
  const token = await agentFor(cardId);
  for (let number = 1; number <= 205; number += 1) {
    await call(board, 'POST', `/api/agent/cards/${cardId}/notes`, { content: `note ${number}` }, token);
  }
  const notes = (await cardOf(cardId)).attachments.map((attachment) => attachment.content);
  assert.equal(notes.length, 201);
  assert.deepEqual([notes[0], notes[1], notes.at(-1)], ['my own note', 'note 6', 'note 205']);
});

test('a long result in any script arrives whole, however the client encodes it', async () => {
  const { cardId } = await newCard('In Japanese');
  const token = await agentFor(cardId);
  const escaped = `{"result": "${'\\u3042'.repeat(20000)}"}`;   // 120 kB, as a client that escapes non-ASCII sends it
  const response = await fetch(`${board.url}/api/agent/cards/${cardId}`, { method: 'PATCH', body: escaped,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await cardOf(cardId)).agent.result, 'あ'.repeat(20000));
});

test('an agent reads its own card, with what the user said to it, and no other', async () => {
  const { cardId } = await newCard('Read me');
  const other = await newCard('Not yours');
  const token = await agentFor(cardId);
  await call(board, 'POST', `/api/cards/${cardId}/chat`, { text: 'Use the 2026 ledger.' }, board.token);
  const { status, body } = await call(board, 'GET', `/api/agent/cards/${cardId}`, undefined, token);
  assert.equal(status, 200);
  assert.deepEqual([body.card.title, body.card.column, body.card.chat.map((message) => message.text)], ['Read me', 'New', ['Use the 2026 ledger.']]);
  assert.equal(body.card.agent.tokenHash, undefined);
  assert.equal((await call(board, 'GET', `/api/agent/cards/${other.cardId}`, undefined, token)).status, 401);
  assert.equal((await call(board, 'GET', `/api/agent/cards/${cardId}`, undefined, board.token)).status, 401);
});

test('asking moves the card to Needs you; going back to work clears the question', async () => {
  const { cardId, workspaceId } = await newCard('Which ledger?');
  const token = await agentFor(cardId);
  await call(board, 'POST', `/api/agent/cards/${cardId}/ask`, { question: 'The 2025 or the 2026 ledger?' }, token);
  assert.equal(await columnOf(cardId, workspaceId), 'Needs you');
  assert.equal((await cardOf(cardId)).agent.question, 'The 2025 or the 2026 ledger?');
  await call(board, 'POST', `/api/agent/cards/${cardId}/move`, { column: 'Working' }, token);
  assert.equal(await columnOf(cardId, workspaceId), 'Working');
  assert.equal((await cardOf(cardId)).agent.question, undefined);
});

test('an agent moves only among the working columns, and reaches no other card', async () => {
  const mine = await newCard('Mine');
  const theirs = await newCard('Not mine');
  const token = await agentFor(mine.cardId);
  for (const column of ['Done', "Won't do", 'New']) {
    assert.equal((await call(board, 'POST', `/api/agent/cards/${mine.cardId}/move`, { column }, token)).status, 400, column);
  }
  assert.equal((await call(board, 'POST', `/api/agent/cards/${mine.cardId}/move`, { column: 'Review' }, token)).status, 200);
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${theirs.cardId}`, { progress: 'x' }, token)).status, 401);
  assert.equal((await call(board, 'PATCH', `/api/cards/${theirs.cardId}`, { title: 'renamed' }, token)).status, 401);   // nor the board's API
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${mine.cardId}`, { progress: 'x' }, board.token)).status, 401);   // card tokens only
});

test('once the user closes the card, or the token is revoked, the agent can change nothing', async () => {
  const { cardId, workspaceId } = await newCard('Close me');
  const token = await agentFor(cardId);
  const workspace = (await call(board, 'GET', `/api/workspaces/${workspaceId}`, undefined, board.token)).body;
  const done = workspace.binders.find((binder) => binder.title === 'Done');
  await call(board, 'POST', `/api/cards/${cardId}/move`, { binderId: done.id, toIndex: 0 }, board.token);
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${cardId}`, { progress: 'still here' }, token)).status, 409);
  const other = await newCard('Revoke me');
  const revoked = await agentFor(other.cardId);
  await call(board, 'DELETE', `/api/cards/${other.cardId}/agent`, undefined, board.token);
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${other.cardId}`, { progress: 'x' }, revoked)).status, 401);
  assert.ok((await cardOf(other.cardId)).agent.stoppedAt);
});

test("an agent's columns are the board's own, whatever it calls them", async () => {
  const { cardId, workspaceId } = (await call(board, 'POST', '/api/items',
    { source: 'test', title: 'Own columns', workspace: 'Kept columns' }, board.token)).body;
  const workspace = (await call(board, 'GET', `/api/workspaces/${workspaceId}`, undefined, board.token)).body;
  for (const [from, to] of [['Working', 'Researching'], ['Review', 'Proposed']]) {
    const binder = workspace.binders.find((each) => each.title === from);
    await call(board, 'PATCH', `/api/binders/${binder.id}`, { title: to }, board.token);
  }
  const token = await agentFor(cardId);
  await call(board, 'POST', `/api/agent/cards/${cardId}/move`, { column: 'Working' }, token);
  assert.equal(await columnOf(cardId, workspaceId), 'Researching');
  await call(board, 'POST', `/api/agent/cards/${cardId}/move`, { column: 'Review' }, token);
  assert.equal(await columnOf(cardId, workspaceId), 'Proposed');
});

test("the starter board's Completed is closed too", async () => {
  const workspace = (await call(board, 'POST', '/api/workspaces', { name: 'Starter style' }, board.token)).body;
  const binders = {};
  for (const title of ['In Progress', 'Completed']) {
    binders[title] = (await call(board, 'POST', `/api/workspaces/${workspace.id}/binders`, { title }, board.token)).body.id;
  }
  const card = (await call(board, 'POST', `/api/workspaces/${workspace.id}/cards`, { title: 'Ship it', binderId: binders['In Progress'] },
    board.token)).body;
  const token = await agentFor(card.id);
  await call(board, 'POST', `/api/cards/${card.id}/move`, { binderId: binders.Completed, toIndex: 0 }, board.token);
  assert.equal((await call(board, 'PATCH', `/api/agent/cards/${card.id}`, { progress: 'still here' }, token)).status, 409);
});

test('an agent changing code moves to Coding, or Clauding; a board without either keeps it in Working', async () => {
  const { cardId, workspaceId } = (await call(board, 'POST', '/api/items',
    { source: 'test', title: 'Write the code', workspace: 'Coding board' }, board.token)).body;
  const token = await agentFor(cardId);
  assert.equal((await call(board, 'POST', `/api/agent/cards/${cardId}/move`, { column: 'Coding' }, token)).status, 200);
  assert.equal(await columnOf(cardId, workspaceId), 'Working');   // the starter columns have no coding one
  const binder = (await call(board, 'POST', `/api/workspaces/${workspaceId}/binders`, { title: 'Clauding', x: 900, y: 40 }, board.token)).body;
  assert.ok(binder);
  await call(board, 'POST', `/api/agent/cards/${cardId}/move`, { column: 'Coding' }, token);
  assert.equal(await columnOf(cardId, workspaceId), 'Clauding');
});

test('only a holder of the board token mints a card token', async () => {
  const { cardId } = await newCard('Mint');
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/agent`, {})).status, 401);
});
