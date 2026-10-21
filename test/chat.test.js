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

test('pictures on the card go with a message, with or without text; other files do not', async () => {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title: 'Look at this' }, board.token)).body;
  const upload = async (name, type) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('not really a picture')], { type }), name);
    const response = await fetch(`${board.url}/api/cards/${cardId}/attachments`, {
      method: 'POST', headers: { Authorization: `Bearer ${board.token}` }, body: form });
    return (await response.json()).id;
  };
  const screenshot = await upload('screenshot.png', 'image/png');
  const drawing = await upload('drawing.svg', 'image/svg+xml');
  const sent = await call(board, 'POST', `/api/cards/${cardId}/chat`, { text: '', images: [screenshot] }, board.token);
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body.images.map((image) => [image.id, image.mimeType, image.name]), [[screenshot, 'image/png', 'screenshot.png']]);
  assert.match(sent.body.images[0].filename, /^[0-9a-f-]{36}\.png$/);
  for (const images of [[drawing], ['no-such-attachment'], 'not a list', Array(9).fill(screenshot)]) {
    assert.equal((await call(board, 'POST', `/api/cards/${cardId}/chat`, { text: 'x', images }, board.token)).status, 400);
  }
});
