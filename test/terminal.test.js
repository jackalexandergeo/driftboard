// A card's terminal: the board relays the page's WebSocket to the helper's socket, and only for
// the board's own page. A fake helper stands in on a Unix socket. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { call, startBoard, stopBoard } from './helpers.js';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'driftboard-terminal-'));
const socketPath = path.join(folder, 'terminal.sock');
let board;
let fakeHelper;
const heard = [];   // what the fake helper was sent, as [kind, payload]

function frame(kind, payload) {
  const body = kind === 1 ? Buffer.from(JSON.stringify(payload)) : Buffer.from(payload);
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

before(async () => {
  fakeHelper = net.createServer((connection) => {
    let buffer = Buffer.alloc(0);
    connection.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
        const kind = buffer.readUInt8(0);
        const body = buffer.subarray(5, 5 + buffer.readUInt32BE(1));
        buffer = buffer.subarray(5 + body.length);
        const payload = kind === 1 ? JSON.parse(body.toString()) : body.toString();
        heard.push([kind, payload]);
        if (kind === 1 && payload.card) connection.write(Buffer.concat([frame(1, { started: true }), frame(0, 'welcome\r\n')]));
        if (kind === 0) connection.write(frame(0, `echo ${payload}`));
      }
    });
  });
  await new Promise((resolve) => fakeHelper.listen(socketPath, resolve));
  board = await startBoard(true, { env: { DRIFTBOARD_HELPER_SOCKET: socketPath } });
});

after(async () => {
  await stopBoard(board);
  fakeHelper.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

async function cardWithTerminal(title, terminalEnabled = true) {
  const { cardId } = (await call(board, 'POST', '/api/items', { source: 'test', title }, board.token)).body;
  await call(board, 'PATCH', `/api/cards/${cardId}`, { terminalEnabled }, board.token);
  return cardId;
}

function open(cardId, origin = board.url) {
  return new WebSocket(`${board.url.replace('http', 'ws')}/api/cards/${cardId}/terminal`, origin ? { origin } : {});
}

// Everything the page is sent until the board closes it, or until `until` returns true.
function listen(socket, until = () => false) {
  return new Promise((resolve) => {
    const got = [];
    const done = () => resolve(got);
    socket.on('message', (data, binary) => {
      got.push(binary ? data.toString() : JSON.parse(data.toString()));
      if (until(got)) done();
    });
    socket.on('close', done);
    socket.on('error', () => done());
  });
}

test("only the board's own page opens a terminal", async () => {
  const cardId = await cardWithTerminal('Elsewhere');
  for (const origin of ['http://evil.example', null]) {
    const refused = await new Promise((resolve) => {
      const socket = open(cardId, origin);
      socket.on('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.on('open', () => resolve('opened'));
    });
    assert.equal(refused, 403, String(origin));
  }
});

test('a terminal needs the token, a card whose agent has one, and the helper', async () => {
  const cardId = await cardWithTerminal('Locked');
  const wrong = open(cardId);
  wrong.on('open', () => wrong.send(JSON.stringify({ token: 'not-it', cols: 80, rows: 24 })));
  assert.deepEqual(await listen(wrong), [{ error: "this terminal needs the board's token" }]);

  const none = open(await cardWithTerminal('No terminal', false));
  none.on('open', () => none.send(JSON.stringify({ token: board.token, cols: 80, rows: 24 })));
  assert.deepEqual(await listen(none), [{ error: "this card's agent has no terminal now" }]);

  const elsewhere = await startBoard(true, { env: { DRIFTBOARD_HELPER_SOCKET: path.join(folder, 'nobody.sock') } });
  try {
    const { cardId: lonely } = (await call(elsewhere, 'POST', '/api/items', { source: 'test', title: 'No helper' }, elsewhere.token)).body;
    await call(elsewhere, 'PATCH', `/api/cards/${lonely}`, { terminalEnabled: true }, elsewhere.token);
    const socket = new WebSocket(`${elsewhere.url.replace('http', 'ws')}/api/cards/${lonely}/terminal`, { origin: elsewhere.url });
    socket.on('open', () => socket.send(JSON.stringify({ token: elsewhere.token, cols: 80, rows: 24 })));
    const [answer] = await listen(socket);
    assert.match(answer.error, /the helper is not running/);
  } finally {
    await stopBoard(elsewhere);
  }
});

test('keys, output and the size go through', async () => {
  const cardId = await cardWithTerminal('Talk to me');
  const socket = open(cardId);
  socket.on('open', () => {
    socket.send(JSON.stringify({ token: board.token, cols: 100, rows: 30 }));
    socket.send(Buffer.from('ls\n'), { binary: true });   // sent before the helper answered: it waits, then goes
    socket.send(JSON.stringify({ resize: [120, 40] }));
  });
  const got = await listen(socket, (messages) => messages.some((message) => message === 'echo ls\n'));
  socket.close();
  assert.deepEqual(got.slice(0, 2), [{ started: true }, 'welcome\r\n']);
  assert.ok(got.includes('echo ls\n'));
  assert.deepEqual(heard.find(([kind, payload]) => kind === 1 && payload.card === cardId), [1, { card: cardId, cols: 100, rows: 30 }]);
  assert.ok(heard.some(([kind, payload]) => kind === 1 && JSON.stringify(payload) === JSON.stringify({ resize: [120, 40] })));
});
