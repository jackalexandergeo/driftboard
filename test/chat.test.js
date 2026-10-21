// The card's chat: the user writes with the board token, the agent with its card's token; an
// agent's question and result are part of it. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, startBoard, stopBoard } from './helpers.js';

let board;

before(async () => {
  board = await startBoard(true);
});

after(() => stopBoard(board));

test('the user and the agent talk on the card, the agent asking and answering in the same thread', async () => {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Talk to me' }, board.token)).body;
  const token = (await call(board, 'POST', `/api/cards/${cardId}/agent`, { name: 'claude' }, board.token)).body.token;
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/chat`, { text: 'Use the 2026 ledger.' }, board.token)).status, 201);
  assert.equal((await call(board, 'POST', `/api/agent/cards/${cardId}/chat`, { text: 'On it.' }, token)).status, 201);
  await call(board, 'POST', `/api/agent/cards/${cardId}/ask`, { question: 'Include credit notes?' }, token);
  await call(board, 'PATCH', `/api/agent/cards/${cardId}`, { result: '**2 mismatches**' }, token);
  const chat = (await call(board, 'GET', `/api/cards/${cardId}`, undefined, board.token)).body.card.chat;
  assert.deepEqual(chat.map((message) => [message.from, message.kind ?? null, message.text, message.name ?? null]), [
    ['user', null, 'Use the 2026 ledger.', null], ['agent', null, 'On it.', 'claude'],
    ['agent', 'question', 'Include credit notes?', 'claude'], ['agent', 'result', '**2 mismatches**', 'claude']]);
});

test('each side writes only as itself', async () => {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Who says what' }, board.token)).body;
  const token = (await call(board, 'POST', `/api/cards/${cardId}/agent`, {}, board.token)).body.token;
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/chat`, { text: 'x' }, token)).status, 401);   // the card token is not the user's
  assert.equal((await call(board, 'POST', `/api/agent/cards/${cardId}/chat`, { text: 'x' }, board.token)).status, 401);
  assert.equal((await call(board, 'POST', `/api/cards/${cardId}/chat`, { text: '  ' }, board.token)).status, 400);
});
