// Where the board lives and how it is reached, shared by the server and `npm run open`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DRIFTBOARD_DATA ? path.resolve(process.env.DRIFTBOARD_DATA) : path.join(__dirname, 'data');
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
export const TOKEN_FORMAT_FILE = path.join(DATA_DIR, 'token-format'); // marks a token made by this version or later
// Sign-in pages that `npm run open` hands the browser (see open.js), private to this user.
export const OPENING_DIR = path.join(DATA_DIR, 'opening');
export const PORT = process.env.PORT || 4321;
// Only this machine by default. Not plain HOST: tcsh and many CI systems set that to the
// machine's name, which would quietly open the board to the network.
export const HOST = process.env.DRIFTBOARD_HOST || '127.0.0.1';

// The address a browser on this machine uses. A browser keeps its sign-in per address, and
// localhost is another address than 127.0.0.1 to it, so this is always the same one.
export function localURL() {
  const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
  return `http://${host}:${PORT}/`;
}
