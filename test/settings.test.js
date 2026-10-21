// Where the board keeps its data, for the server, `npm run open`, the helper and the pinger alike.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dataDirFor } from '../settings.js';

const home = '/home/pat';
const legacy = '/opt/driftboard/data';
const has = (...files) => (file) => files.includes(file);

test('the data folder is the user\'s own data folder unless DRIFTBOARD_DATA names one', () => {
  assert.deepEqual(dataDirFor({ env: {}, home, legacy, exists: has() }), { dir: '/home/pat/.local/share/driftboard', legacy: false });
  assert.deepEqual(dataDirFor({ env: { XDG_DATA_HOME: '/data/pat' }, home, legacy, exists: has() }).dir, '/data/pat/driftboard');
  assert.equal(dataDirFor({ env: { XDG_DATA_HOME: 'relative' }, home, legacy, exists: has() }).dir, '/home/pat/.local/share/driftboard');
  assert.equal(dataDirFor({ env: { DRIFTBOARD_DATA: '/srv/board' }, home, legacy, exists: has() }).dir, path.resolve('/srv/board'));
});

test('a board an earlier version kept in the checkout stays where it is', () => {
  const kept = dataDirFor({ env: {}, home, legacy, exists: has(`${legacy}/board.json`) });
  assert.deepEqual(kept, { dir: legacy, legacy: true });
  const moved = dataDirFor({ env: {}, home, legacy, exists: has(`${legacy}/board.json`, '/home/pat/.local/share/driftboard/board.json') });
  assert.deepEqual(moved, { dir: '/home/pat/.local/share/driftboard', legacy: false });
});
