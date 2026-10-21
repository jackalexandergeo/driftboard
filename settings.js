// Where the board lives and how it is reached, shared by the server and `npm run open`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The board's data folder: DRIFTBOARD_DATA, else the user's data folder ($XDG_DATA_HOME/driftboard,
// else ~/.local/share/driftboard), where the helper and the pinger look for the token too. A board
// an earlier version kept in <checkout>/data stays there (legacy: true), until it is moved.
export function dataDirFor({ env = process.env, home = os.homedir(), legacy = path.join(__dirname, 'data'),
  exists = fs.existsSync } = {}) {
  if (env.DRIFTBOARD_DATA) return { dir: path.resolve(env.DRIFTBOARD_DATA), legacy: false };
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  const dir = path.join(base, 'driftboard');
  if (!exists(path.join(dir, 'board.json')) && exists(path.join(legacy, 'board.json'))) return { dir: legacy, legacy: true };
  return { dir, legacy: false };
}
const chosen = dataDirFor();
export const DATA_DIR = chosen.dir;
export const LEGACY_DATA_DIR = chosen.legacy;
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
export const TOKEN_FORMAT_FILE = path.join(DATA_DIR, 'token-format'); // marks a token made by this version or later
// The key a pinger holds instead of the token: it puts items on the board and does nothing else.
export const ITEMS_KEY_FILE = path.join(DATA_DIR, 'items-key');
// The PIN that signs a tab in from the locked page, as a slow hash (see set-pin.js).
export const PIN_FILE = path.join(DATA_DIR, 'pin');
// Sign-in pages that `npm run open` hands the browser (see open.js), private to this user.
export const OPENING_DIR = path.join(DATA_DIR, 'opening');
export const PORT = process.env.PORT || 4321;
// The helper's socket for a card's terminal (helper/driftboard_helper/terminal.py), in its state folder.
const helperState = process.env.DRIFTBOARD_HELPER_STATE
  || path.join(process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME) ? process.env.XDG_STATE_HOME
    : path.join(os.homedir(), '.local', 'state'), 'driftboard-helper');
export const HELPER_SOCKET = process.env.DRIFTBOARD_HELPER_SOCKET || path.join(helperState, 'terminal.sock');
// Only this machine by default. Not plain HOST: tcsh and many CI systems set that to the
// machine's name, which would quietly open the board to the network.
export const HOST = process.env.DRIFTBOARD_HOST || '127.0.0.1';
// DRIFTBOARD_SIGN_IN=off: no sign-in at all, for a machine with no other users to keep out.
// The board still refuses other sites' requests, and will not start on an address other machines
// can reach (DRIFTBOARD_HOST=0.0.0.0, say): there anyone on the network could change it.
export const SIGN_IN = (process.env.DRIFTBOARD_SIGN_IN || 'on').toLowerCase() !== 'off';
export const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);

// The address a browser on this machine uses. A browser keeps its sign-in per address, and
// localhost is another address than 127.0.0.1 to it, so this is always the same one.
export function localURL() {
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
  return `http://${host}:${PORT}/`;
}
