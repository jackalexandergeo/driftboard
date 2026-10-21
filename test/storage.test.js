// How the board keeps its file: written soon after each change, flushed, the previous copy kept,
// and never replaced by an empty board when it cannot be read. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, newDataFolder, startBoard, stopBoard } from './helpers.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const board = (name) => JSON.stringify({ version: 2, activeWorkspaceId: 'w1', workspaces: [
  { id: 'w1', name, view: { panX: 0, panY: 0, zoom: 1 }, binders: [], cards: [] }] });

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('timed out');
}

test('a burst of changes is written compactly, and the copy before the last write is kept', async () => {
  const running = await startBoard(false);
  try {
    const file = path.join(running.data, 'board.json');
    await call(running, 'POST', '/api/items', { source: 'burst', title: 'First' });
    await waitFor(() => fs.existsSync(file));   // a board.json for the burst's write to keep as .bak
    await Promise.all(Array.from({ length: 29 }, (_, number) =>
      call(running, 'POST', '/api/items', { source: 'burst', title: `Item ${number}` })));
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')).workspaces.some((w) => w.cards.length === 30); } catch { return false; }
    });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('\n'), 'one line, no indentation');
    assert.ok(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).workspaces);
  } finally {
    await stopBoard(running);
  }
});

test('a board file that cannot be read is moved aside, and the board starts from the last good copy', async () => {
  const data = newDataFolder();
  fs.writeFileSync(path.join(data, 'board.json'), '{"workspaces": [trunc');
  fs.writeFileSync(path.join(data, 'board.json.bak'), board('Kept'));
  const running = await startBoard(false, { data });
  try {
    const { body } = await call(running, 'GET', '/api/state');
    assert.deepEqual(body.workspaces.map((w) => w.name), ['Kept']);
    const aside = fs.readdirSync(data).filter((name) => name.startsWith('board.json.unreadable-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(data, aside[0]), 'utf8'), '{"workspaces": [trunc');
  } finally {
    await stopBoard(running);
  }
});

test('with no good copy, a board file that cannot be read stops the board, untouched', async () => {
  const data = newDataFolder();
  fs.writeFileSync(path.join(data, 'board.json'), 'not a board');
  try {
    const server = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: { ...process.env, PORT: '0', DRIFTBOARD_DATA: data, DRIFTBOARD_SIGN_IN: 'off' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    server.stderr.on('data', (chunk) => { errors += chunk; });
    const code = await new Promise((resolve) => server.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(errors, /no good copy to start from: the board did not start/);
    assert.equal(fs.readFileSync(path.join(data, 'board.json'), 'utf8'), 'not a board');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a write cut off between its two renames is picked up from the written file', async () => {
  const data = newDataFolder();
  fs.writeFileSync(path.join(data, 'board.json.tmp'), board('Newest'));
  fs.writeFileSync(path.join(data, 'board.json.bak'), board('Older'));
  const running = await startBoard(false, { data });
  try {
    assert.deepEqual((await call(running, 'GET', '/api/state')).body.workspaces.map((w) => w.name), ['Newest']);
  } finally {
    await stopBoard(running);
  }
});
