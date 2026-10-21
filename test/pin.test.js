// The PIN: typed without ever showing, kept as a slow hash, and its wrong tries counted across
// restarts. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDataFolder } from './helpers.js';

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
