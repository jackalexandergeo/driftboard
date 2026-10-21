// `npm run set-pin`: set (or `-- --remove`) the PIN that signs a tab in from the locked page.
// Asked for twice, never echoed; kept only as a slow scrypt hash in the data folder.
import { randomBytes, scrypt } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { PIN_FILE } from './settings.js';

const N = 2 ** 15; // about 0.1 s and 32 MB per try: slow for a guesser, quick for the user

if (process.argv.includes('--remove')) {
  fs.rmSync(PIN_FILE, { force: true });
  console.log(`no PIN any more (${PIN_FILE} removed)`);
  process.exit(0);
}

// The question is written here, and readline's own output goes nowhere: on a backspace or any edit
// it redraws the prompt with the line typed so far, which would show the PIN.
const nowhere = new Writable({ write(chunk, encoding, done) { done(); } });
function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const prompt = readline.createInterface({ input: process.stdin, output: nowhere, terminal: true });
    prompt.on('SIGINT', () => { process.stdout.write('\n'); process.exit(130); });   // Ctrl-C: nothing changed
    prompt.question('', (answer) => { prompt.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

if (!process.stdin.isTTY) {
  console.error('run this in a terminal: the PIN is typed, never passed on a command line');
  process.exit(1);
}
const first = await ask('New PIN (4 to 32 characters): ');
if (first.length < 4 || first.length > 32) {
  console.error('a PIN has 4 to 32 characters; nothing changed');
  process.exit(1);
}
if ((await ask('Again: ')) !== first) {
  console.error('the two did not match; nothing changed');
  process.exit(1);
}
const salt = randomBytes(16);
scrypt(first, salt, 64, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (err, hash) => {
  if (err) { console.error(err.message); process.exit(1); }
  const saved = JSON.stringify({ version: 1, N, salt: salt.toString('hex'), hash: hash.toString('hex') }) + '\n';
  fs.writeFileSync(`${PIN_FILE}.tmp`, saved, { mode: 0o600 });
  fs.renameSync(`${PIN_FILE}.tmp`, PIN_FILE);
  console.log(`PIN set (${PIN_FILE}). New tabs can sign in with it; the running board picks it up at once.`);
});
