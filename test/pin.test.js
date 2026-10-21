// The PIN: typed without ever showing, kept as a slow hash, and its wrong tries counted across
// restarts. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, newDataFolder, startBoard, stopBoard } from './helpers.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Types into `npm run set-pin` on a terminal: a PIN, a backspace, the rest, and the PIN again.
const TYPIST = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.environ["DRIFTBOARD_DATA"] = sys.argv[1]
    os.execvp(sys.argv[2], [sys.argv[2], "set-pin.js"])
seen = b""
def read(seconds):
    global seen
    end = time.time() + seconds
    while time.time() < end and select.select([fd], [], [], max(0, end - time.time()))[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return
        if not chunk:
            return
        seen += chunk
for keys in (b"9876", b"\\x7f", b"5\\r", b"9875\\r"):
    read(0.8)
    os.write(fd, keys)
read(3)
sys.stdout.write(seen.decode(errors="replace"))
`;
const python = spawnSync('python3', ['--version']).status === 0;

test('set-pin never shows what is typed, not even when the line is edited', { skip: !python && 'needs python3 for a terminal' }, () => {
  const data = newDataFolder();
  try {
    const typed = spawnSync('python3', ['-c', TYPIST, data, process.execPath], { cwd: root, encoding: 'utf8', timeout: 20000 });
    assert.match(typed.stdout, /New PIN \(4 to 32 characters\): \r\nAgain: \r\nPIN set/);
    assert.ok(!/98/.test(typed.stdout), typed.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'pin'), 'utf8')).version, 1);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

function setPin(data, value) {
  const salt = randomBytes(16);
  const N = 2 ** 14;
  const hash = scryptSync(value, salt, 64, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  fs.writeFileSync(path.join(data, 'pin'), JSON.stringify({ version: 1, N, salt: salt.toString('hex'), hash: hash.toString('hex') }));
  return salt.toString('hex');
}

test('a pin file set-pin did not write is no PIN, and the board stays up', async () => {
  const data = newDataFolder();
  fs.writeFileSync(path.join(data, 'pin'), JSON.stringify({ version: 1, N: 2 ** 15, salt: 'ab'.repeat(16), hash: 'cd'.repeat(8) }));
  const board = await startBoard(true, { data });
  try {
    assert.deepEqual((await call(board, 'GET', '/api/pin')).body, { enabled: false });
    assert.equal((await call(board, 'POST', '/api/pin', { pin: '1234' })).status, 404);
    assert.equal((await call(board, 'GET', '/api/sign-in')).status, 200);
  } finally {
    await stopBoard(board);
  }
});

test('wrong PIN tries are kept, so a restart hands out no fresh ones; a new PIN starts over', async () => {
  const data = newDataFolder();
  const salt = setPin(data, '2468');
  let board = await startBoard(true, { data });
  try {
    const wrong = await call(board, 'POST', '/api/pin', { pin: '1111' });
    assert.deepEqual([wrong.status, wrong.body.triesLeft], [401, 19]);
    const kept = JSON.parse(fs.readFileSync(path.join(data, 'pin-tries'), 'utf8'));
    assert.deepEqual([kept.salt, kept.failures, kept.waitUntil > Date.now()], [salt, 1, true]);
  } finally {
    board.server.kill();
    await new Promise((resolve) => board.server.once('exit', resolve));
  }
  fs.writeFileSync(path.join(data, 'pin-tries'), JSON.stringify({ salt, failures: 20, waitUntil: 0 }));   // used up, then a restart
  board = await startBoard(true, { data });
  try {
    assert.deepEqual((await call(board, 'GET', '/api/pin')).body, { enabled: false });
    assert.equal((await call(board, 'POST', '/api/pin', { pin: '2468' })).status, 423);
    setPin(data, '1357');   // set again: the tries of the old PIN do not count
    assert.deepEqual((await call(board, 'GET', '/api/pin')).body, { enabled: true });
    assert.equal((await call(board, 'POST', '/api/pin', { pin: '1357' })).status, 200);
  } finally {
    await stopBoard(board);
  }
});
