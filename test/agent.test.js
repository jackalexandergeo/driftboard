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

test('only a holder of the board token mints a card token', async () => {
  const { cardId } = await newCard('Mint');
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/agent`, {})).status, 401);
});
