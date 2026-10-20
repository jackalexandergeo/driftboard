// `npm run open`: open this board in the default browser, signed in. The browser gets a
// one-time sign-in code, never the token: a browser's command line can be read by every
// user on this machine, and its history keeps the address. `--print` only prints the link
// (for a browser on another device, or with no desktop).
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
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
// the token. A first look: Linux tells who listens in /proc/net/tcp (elsewhere this is skipped).
// It only names who listened a moment ago; what decides is the server's proof, below.
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

// The server proves it holds the token (GET /api/hello) before it is sent the token, and the
// token goes on the very connection that proof came over: a connection cannot change hands, but
// the port can, between two connections. So this agent makes one connection and never another.
class OneConnection extends http.Agent {
  createConnection(options, callback) {
    if (this.connected) return callback(new Error('the board closed the connection it proved itself on'));
    this.connected = true;
    return super.createConnection(options, callback);
  }
}
const agent = new OneConnection({ keepAlive: true, maxSockets: 1 });
function ask(method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, board), { method, headers, agent, signal: AbortSignal.timeout(10000) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: not the board */ }
        resolve({ status: response.statusCode, body });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}
function fail(message) {
  console.error(message);
  agent.destroy();
  process.exit(1);
}

const nonce = randomBytes(32).toString('hex');
let hello;
try {
  hello = await ask('GET', `api/hello?nonce=${nonce}`);
} catch (err) {
  fail(`could not reach the board at ${board} (${err.cause?.code || err.code || err.message}): is it running? ${sameSettings}`);
}
const proof = Buffer.from(typeof hello.body?.proof === 'string' ? hello.body.proof : '');
const expected = Buffer.from(createHmac('sha256', token).update(`driftboard-hello:${nonce}`).digest('hex'));
if (hello.status !== 200 || proof.length !== expected.length || !timingSafeEqual(proof, expected)) {
  fail(`the server at ${board} could not prove it holds the token in ${TOKEN_FILE} (HTTP ${hello.status}), so it was not sent the token. `
    + `It is another program, or a board with another token: ${sameSettings}`);
}

let codes;
try {
  codes = await ask('POST', 'api/sign-in-codes', { Authorization: `Bearer ${token}` });
} catch (err) {
  fail(`the board at ${board} went away before it was asked for a sign-in code (${err.cause?.code || err.code || err.message}): try again`);
}
agent.destroy();
if (codes.status !== 201 || typeof codes.body?.code !== 'string') {
  fail(`the board at ${board} gave no sign-in code (HTTP ${codes.status}): ${sameSettings}`);
}
const url = `${board}?code=${encodeURIComponent(codes.body.code)}`;
console.log(url);
if (!process.argv.includes('--print')) {
  const opener = { darwin: 'open', win32: 'explorer' }[process.platform] || 'xdg-open';
  execFile(opener, [url], (err) => { if (err) console.error(`could not open a browser (${err.message}); the link above works once, for a minute`); });
}
