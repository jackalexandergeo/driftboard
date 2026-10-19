// `npm run open`: open this board in the default browser, signed in. The browser gets a
// one-time sign-in code, never the token: a browser's command line can be read by every
// user on this machine, and its history keeps the address. `--print` only prints the link
// (for a browser on another device, or with no desktop).
import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

// While the board is down, any user of this machine can listen on its port, and would be sent
// the token. So the token only goes to a port this user listens on. Linux tells who listens
// in /proc/net/tcp; elsewhere the check is skipped.
const canonical = (ip) => (net.isIPv6(ip) ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip);
function procAddress(hex) { // each 32-bit word is in the machine's byte order
  const bytes = Buffer.from(hex, 'hex');
  if (os.endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  return bytes.length === 4 ? [...bytes].join('.') : canonical(bytes.toString('hex').match(/.{4}/g).join(':'));
}
async function portHolders(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  const reaches = new Set(['0.0.0.0', '::']); // a wildcard listener takes what no exact one does
  for (const ip of ips) { reaches.add(canonical(ip)); if (net.isIPv4(ip)) reaches.add(canonical(`::ffff:${ip}`)); }
  const holders = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let table;
    try { table = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8 || fields[3] !== '0A') continue; // 0A: listening
      const [address, port] = fields[1].split(':');
      if (parseInt(port, 16) === Number(url.port || 80) && reaches.has(procAddress(address))) holders.add(Number(fields[7]));
    }
  }
  return holders;
}
if (typeof process.getuid === 'function') {
  const strangers = [...await portHolders(new URL(board))].filter((uid) => uid !== process.getuid());
  if (strangers.length) {
    console.error(`another user (uid ${strangers.join(', ')}) is listening on ${board}, not this board: not sending it the token. Is the board running? ${sameSettings}`);
    process.exit(1);
  }
}
let response;
try {
  response = await fetch(new URL('api/sign-in-codes', board), {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
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
