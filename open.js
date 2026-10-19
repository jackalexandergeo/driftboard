// `npm run open`: print this board's sign-in link and open it in the default browser.
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
const url = localURL(token);
console.log(url);
const opener = { darwin: 'open', win32: 'explorer' }[process.platform] || 'xdg-open';
execFile(opener, [url], (err) => { if (err) console.error(`could not open a browser (${err.message}); use the link above`); });
