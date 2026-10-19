// `npm run open`: open this board in the default browser, signed in. The browser gets a
// one-time sign-in code, never the token: a browser's command line can be read by every
// user on this machine, and its history keeps the address. `--print` only prints the link
// (for a browser on another device, or with no desktop).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { TOKEN_FILE, localURL } from './settings.js';

let token;
try {
  token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.error(`no token at ${TOKEN_FILE}: start the server once (npm start) to make one`);
  process.exit(1);
}
const board = localURL();
const sameSettings = 'run this with the same DRIFTBOARD_DATA, DRIFTBOARD_HOST and PORT as the server';
let response;
try {
  response = await fetch(new URL('api/sign-in-codes', board), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
} catch (err) {
  console.error(`could not reach the board at ${board} (${err.cause?.code || err.message}): is it running? ${sameSettings}`);
  process.exit(1);
}
if (!response.ok) {
  console.error(`the board at ${board} did not take the token in ${TOKEN_FILE} (HTTP ${response.status}): ${sameSettings}`);
  process.exit(1);
}
const { code } = await response.json();
const url = `${board}?code=${encodeURIComponent(code)}`;
console.log(url);
if (!process.argv.includes('--print')) {
  const opener = { darwin: 'open', win32: 'explorer' }[process.platform] || 'xdg-open';
  execFile(opener, [url], (err) => { if (err) console.error(`could not open a browser (${err.message}); the link above works once, for a minute`); });
}
