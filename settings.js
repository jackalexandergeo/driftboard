// Where the board lives and how it is reached, shared by the server and `npm run open`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DRIFTBOARD_DATA ? path.resolve(process.env.DRIFTBOARD_DATA) : path.join(__dirname, 'data');
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
export const PORT = process.env.PORT || 4321;
// Only this machine by default: the board has no accounts, so anyone who can reach it can edit it.
export const HOST = process.env.HOST || '127.0.0.1';

// The address a browser on this machine uses, with the sign-in token when given one.
export function localURL(token) {
  const host = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
  return `http://${host}:${PORT}/` + (token ? `?token=${encodeURIComponent(token)}` : '');
}
