import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR, HOST, ITEMS_KEY_FILE, LEGACY_DATA_DIR, OPENING_DIR, PIN_FILE, PORT, SIGN_IN, TOKEN_FILE, TOKEN_FORMAT_FILE,
  localURL } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const BOARD_TEMP_FILE = `${BOARD_FILE}.tmp`;
const BOARD_BACKUP_FILE = `${BOARD_FILE}.bak`; // the copy before the last write

const STARTER_BINDERS = ['To Do', 'In Progress', 'Blocked', 'Reviewing', 'Completed'];
const STAGE_TITLES = {
  'todo': 'To Do', 'in-progress': 'In Progress', 'blocked': 'Blocked',
  'reviewing': 'Reviewing', 'completed': 'Completed',
};

// --- Storage ---------------------------------------------------------------

// The board, its files and its token are nobody else's to read. All that the server makes is
// private (umask), and so is a data folder that already exists: mkdir's mode only applies to
// a new one, and earlier versions left data/ open to every user (755, board.json 644).
process.umask(0o077);
const myUid = process.getuid?.();
function makePrivate(file, mode) { // returns how it was
  const stat = fs.statSync(file);
  if (myUid !== undefined && stat.uid !== myUid) {
    console.error(`${file} belongs to another user (uid ${stat.uid}): keep the board in a folder of your own (DRIFTBOARD_DATA)`);
    process.exit(1);
  }
  if ((stat.mode & 0o777) !== mode) fs.chmodSync(file, mode);
  return stat;
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
makePrivate(DATA_DIR, 0o700);
fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
makePrivate(UPLOADS_DIR, 0o700);
if (fs.existsSync(BOARD_FILE)) makePrivate(BOARD_FILE, 0o600);
// Sign-in pages left by `npm run open`: the codes in them died with the last run.
if (fs.existsSync(OPENING_DIR)) {
  makePrivate(OPENING_DIR, 0o700);
  for (const name of fs.readdirSync(OPENING_DIR)) fs.rmSync(path.join(OPENING_DIR, name), { force: true, recursive: true });
}
const now = () => new Date().toISOString();

function makeBinders(titles) {
  return titles.map((title, i) => ({
    id: randomUUID(), title, x: 40 + i * 340, y: 40,
  }));
}

function starterWorkspace(name = 'My Board') {
  return {
    id: randomUUID(),
    name,
    view: { panX: 0, panY: 0, zoom: 1 },
    binders: makeBinders(STARTER_BINDERS),
    cards: [],
  };
}

function defaultState() {
  const ws = starterWorkspace();
  return { version: 2, activeWorkspaceId: ws.id, workspaces: [ws] };
}

// Bring a pre-workspace (v1) board forward without losing anything.
function migrateV1(old) {
  const binders = makeBinders((old.stages || []).map((s) => STAGE_TITLES[s] || s));
  const byStage = {};
  (old.stages || []).forEach((stage, i) => { byStage[stage] = binders[i].id; });
  const cards = (old.cards || []).map((c) => ({
    id: c.id || randomUUID(),
    title: c.title || 'Untitled',
    description: c.description || '',
    attachments: c.attachments || [],
    binderId: byStage[c.stage] || null,
    order: c.order || 0,
    x: 40, y: 40,
    createdAt: c.createdAt || now(),
    updatedAt: c.updatedAt || now(),
  }));
  const ws = { id: randomUUID(), name: 'My Board', view: { panX: 0, panY: 0, zoom: 1 }, binders, cards };
  return { version: 2, activeWorkspaceId: ws.id, workspaces: [ws] };
}

function readBoard(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw?.workspaces)) return raw;
  if (Array.isArray(raw?.cards)) return migrateV1(raw); // v1 board.json
  throw new Error('it holds no board');
}

// The board never starts empty over one that is there. A board.json that cannot be read is moved
// aside for the last good copy; with no good copy the board does not start. board.json missing
// while a write was being finished: the written temporary file, else the last good copy.
function loadState() {
  let unreadable = null;
  if (fs.existsSync(BOARD_FILE)) {
    try { return readBoard(BOARD_FILE); } catch (error) { unreadable = error.message; }
  } else if (fs.existsSync(BOARD_TEMP_FILE)) {
    try {
      const written = readBoard(BOARD_TEMP_FILE);
      console.error(`${BOARD_FILE} was missing: the board starts from the last write, ${BOARD_TEMP_FILE}`);
      return written;
    } catch { /* a write cut short: the last good copy below */ }
  }
  if (fs.existsSync(BOARD_BACKUP_FILE)) {
    try {
      const saved = readBoard(BOARD_BACKUP_FILE);
      if (unreadable) {
        const aside = `${BOARD_FILE}.unreadable-${Date.now()}`;
        fs.renameSync(BOARD_FILE, aside);
        console.error(`${BOARD_FILE} could not be read (${unreadable}): it is now ${aside}, and the board starts `
          + `from the last good copy, ${BOARD_BACKUP_FILE}`);
      } else {
        console.error(`${BOARD_FILE} was missing: the board starts from the last good copy, ${BOARD_BACKUP_FILE}`);
      }
      return saved;
    } catch (error) {
      unreadable ??= `it is missing, and ${BOARD_BACKUP_FILE} could not be read either (${error.message})`;
    }
  }
  if (unreadable) {
    console.error(`${BOARD_FILE} could not be read (${unreadable}), and there is no good copy to start from: the `
      + 'board did not start. Fix the file, or move it away to start a new board.');
    process.exit(1);
  }
  return defaultState(); // no board yet
}
let state = loadState();
if (!Array.isArray(state.trash)) state.trash = []; // undo history for deleted cards/binders
const TRASH_CAP = 40;

// Every change bumps the revision, so an open tab can tell when someone else changed the
// board. It starts from the clock so a restart never repeats an earlier number.
let revision = Date.now();

// Each change is written soon after, the whole board at once. One write at a time: changes made
// while it is under way are taken by the next one, so a burst of items or reports is one or two
// writes, not one each. A write goes to a temporary file, is flushed to the disk, and replaces
// board.json, whose previous copy is kept as board.json.bak.
let writing = null;
let dirty = false;
function persist() {
  revision += 1;
  dirty = true;
  if (!writing) writing = writeBoard();
  return writing;
}
async function writeBoard() {
  try {
    while (dirty) {
      await new Promise((resolve) => setImmediate(resolve)); // the rest of this burst first
      dirty = false;
      try {
        const file = await fsp.open(BOARD_TEMP_FILE, 'w', 0o600);
        try {
          await file.writeFile(JSON.stringify(state));
          await file.sync();
        } finally {
          await file.close();
        }
        await fsp.rename(BOARD_FILE, BOARD_BACKUP_FILE).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        await fsp.rename(BOARD_TEMP_FILE, BOARD_FILE);
        const folder = await fsp.open(DATA_DIR, 'r');   // the renames too
        await folder.sync().catch(() => {}).finally(() => folder.close());
      } catch (error) {
        console.error('persist failed:', error);
      }
    }
  } finally {
    writing = null; // at once when nothing is left: a change from now on starts the next write
  }
}
// Stopped (systemd, Ctrl-C): the last changes are written first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { Promise.resolve(writing).finally(() => process.exit(0)); });
}

// --- Lookup helpers --------------------------------------------------------

const getWorkspace = (id) => state.workspaces.find((w) => w.id === id);
function getBinder(id) {
  for (const ws of state.workspaces) {
    const binder = ws.binders.find((b) => b.id === id);
    if (binder) return { ws, binder };
  }
  return null;
}
function getCard(id) {
  for (const ws of state.workspaces) {
    const card = ws.cards.find((c) => c.id === id);
    if (card) return { ws, card };
  }
  return null;
}
function reindexBinder(ws, binderId) {
  if (!binderId) return;
  ws.cards
    .filter((c) => c.binderId === binderId)
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => { c.order = i; });
}

function uniqueWorkspaceName(base) {
  const names = new Set(state.workspaces.map((w) => w.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// Soft-delete: keep the entry (and any files) so it can be undone. When the
// buffer overflows, the oldest entry is purged for real and its files removed.
function pushTrash(entry) {
  state.trash.push(entry);
  while (state.trash.length > TRASH_CAP) {
    const old = state.trash.shift();
    if (old.type === 'card') {
      (old.card.attachments || []).filter((a) => a.filename)
        .forEach((a) => fsp.unlink(path.join(UPLOADS_DIR, a.filename)).catch(() => {}));
    }
  }
}

// --- Uploads ---------------------------------------------------------------

// A stored file keeps only a short, plain extension (it picks the type it is served with):
// the rest of the uploaded name is the uploader's to choose, and not fit for a path or a page.
function safeExtension(name) {
  const extension = path.extname(String(name || '')).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : '';
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${randomUUID()}${safeExtension(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });
// A link must be a web link: a javascript: or data: one would run on the board when clicked.
function webURL(value) {
  const text = String(value ?? '').trim();
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol) ? text : null;
  } catch {
    return null;
  }
}
function attachmentType(mimeType) {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  return 'file';
}

// --- Access ----------------------------------------------------------------
// The board has no accounts: one token, made on first start, opens it. Every API call sends
// it as `Authorization: Bearer <token>`. There is no cookie: a cookie for 127.0.0.1 also goes
// to every other port on it, where any local user can listen. A browser signs in with a
// one-time code from `npm run open` (POST /api/session), so the address it is opened with
// never holds the token. The page itself is public code (it is the GitHub Pages demo too).

// Earlier versions let the token out: in the address the browser was opened with (on command
// lines every user can read, and in the history), in a cookie that went to every port on
// 127.0.0.1, and in the browser's storage. A token one of them made is replaced, once:
// token-format, next to the token, marks one made since.
const TOKEN_FORMAT = '2';
function loadToken() {
  let saved = '';
  if (fs.existsSync(TOKEN_FILE)) {
    const { mode } = makePrivate(TOKEN_FILE, 0o600); // refuses a token another user wrote
    if (mode & 0o077) {
      console.warn(`warning: ${TOKEN_FILE} was open to other users. It is private now, but whoever `
        + 'read it can still open the board: delete it and restart to make a new token.');
    }
    saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  let format = '';
  try { format = fs.readFileSync(TOKEN_FORMAT_FILE, 'utf8').trim(); } catch { /* none: an earlier version's token */ }
  if (saved && format === TOKEN_FORMAT) return saved;
  const made = randomBytes(32).toString('base64url');
  fs.writeFileSync(`${TOKEN_FILE}.tmp`, made + '\n', { mode: 0o600 });
  fs.renameSync(`${TOKEN_FILE}.tmp`, TOKEN_FILE);
  fs.writeFileSync(TOKEN_FORMAT_FILE, TOKEN_FORMAT + '\n', { mode: 0o600 });
  if (saved) {
    console.log(`the token changed: ${TOKEN_FILE} holds a new one, because an earlier version let the old one out. `
      + 'Scripts that read the token file pick up the new one; browsers need `npm run open` again.');
  }
  return made;
}
const TOKEN = loadToken();
// Uploaded files load through <img> and <video>, which cannot send a header: their links
// carry this key instead. It opens the uploads only, never the API.
const UPLOADS_KEY = createHmac('sha256', TOKEN).update('uploads').digest('hex');
// A pinger (a chat watcher, a CI job, another tool's script) holds this key, not the token: it
// opens POST /api/items and nothing else, so it can put items on the board but cannot read
// cards, press Start or mint card tokens. Written next to the token, private, at every start.
const ITEMS_KEY = createHmac('sha256', TOKEN).update('driftboard-items').digest('hex');
fs.writeFileSync(`${ITEMS_KEY_FILE}.tmp`, ITEMS_KEY + '\n', { mode: 0o600 });
fs.renameSync(`${ITEMS_KEY_FILE}.tmp`, ITEMS_KEY_FILE);

function sameSecret(given, wanted) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(wanted);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requestToken(req) {
  const bearer = /^bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  return bearer ? bearer[1].trim() : null;
}

function requireToken(req, res, next) {
  if (!SIGN_IN) return next();   // DRIFTBOARD_SIGN_IN=off
  if (req.method === 'POST' && req.path === '/items' && sameSecret(requestToken(req), ITEMS_KEY)) return next();
  if (!sameSecret(requestToken(req), TOKEN)) {
    return res.status(401).json({ error: 'this board is locked: open it with `npm run open`' });
  }
  next();
}
// Belt and braces: no page from another origin may write, whatever it sends.
function refuseForeignWrites(req, res, next) {
  const origin = req.get('Origin');
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== `${req.protocol}://${req.get('Host')}`) {
    return res.status(403).json({ error: 'cross-origin writes are not allowed' });
  }
  next();
}

// One-time sign-in codes: each works once, for a minute. They are kept by their hash, so
// looking one up says nothing about the codes that exist.
const CODE_LIFETIME = 60 * 1000;
const MAX_CODES = 32;
const signInCodes = new Map(); // hash -> expiry, oldest first
const codeHash = (code) => createHash('sha256').update(code).digest('hex');
function makeSignInCode() {
  const time = Date.now();
  for (const [hash, expiresAt] of signInCodes) if (expiresAt <= time) signInCodes.delete(hash);
  while (signInCodes.size >= MAX_CODES) signInCodes.delete(signInCodes.keys().next().value);
  const code = randomBytes(24).toString('base64url');
  const expiresAt = time + CODE_LIFETIME;
  signInCodes.set(codeHash(code), expiresAt);
  return { code, expiresAt };
}
function useSignInCode(code) {
  if (typeof code !== 'string' || !code) return false;
  const hash = codeHash(code);
  const expiresAt = signInCodes.get(hash);
  signInCodes.delete(hash);
  return expiresAt !== undefined && expiresAt > Date.now();
}

// --- App -------------------------------------------------------------------

const app = express();
// A page on another site can point a name of its own at this machine (DNS rebinding) and then
// reach the board as its own origin. So the board answers only to the names it goes by:
// 127.0.0.1, localhost, [::1] and DRIFTBOARD_HOST, and, when it listens on every address, to
// any IP address (other devices reach it by this machine's). A rebinding page uses a name.
const listensEverywhere = HOST === '0.0.0.0' || HOST === '::';
const KNOWN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', net.isIPv6(HOST) ? `[${HOST.toLowerCase()}]` : HOST.toLowerCase()]);
function knownHost(header) {
  const name = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(String(header ?? '').trim().toLowerCase())?.[1]; // without the port
  if (!name) return false;
  return KNOWN_HOSTS.has(name) || (listensEverywhere && net.isIP(name.replace(/^\[|\]$/g, '')) !== 0);
}
app.use((req, res, next) => {
  if (knownHost(req.get('Host'))) return next();
  res.status(421).type('text/plain').send(`this board answers only at its own address, such as ${localURL()}`);
});
// Earlier versions kept the token in a cookie, driftboard_token, for a year. A cookie for
// 127.0.0.1 goes to every port on it, where any user of this machine can listen: while a
// browser still sends one, it is told to drop it (it was set for / or for /api).
app.use((req, res, next) => {
  if (/(^|;)\s*driftboard_token=/.test(req.get('Cookie') || '')) {
    for (const cookiePath of ['/', '/api']) res.clearCookie('driftboard_token', { path: cookiePath, httpOnly: true, sameSite: 'strict' });
  }
  next();
});
app.use((req, res, next) => {
  // Scripts only from the board's own files: should anything slip markup into the page, it cannot
  // run script there (no inline script, no plugins, no <base> to repoint the board's own files).
  // No other page may frame the board. Pictures only from the board itself (and blob: and data:, the
  // demo's): markdown an agent or a pinger wrote cannot load an image from elsewhere, whose address
  // could carry what it read off the board. Styles and fonts are left alone: the page sets inline
  // styles and loads its font from Google Fonts.
  res.set('Content-Security-Policy',
    "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:");
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer'); // links out of the board do not carry its address
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, refuseForeignWrites);

// Prove this server holds the token, so a client can tell it from another program listening on
// its port (any user of this machine can, while the board is down) before it sends the token.
// The proof is an HMAC of the client's fresh nonce keyed with the token: only a holder of the
// token can make it, and it says nothing about the token. Its message never equals `uploads`,
// so it cannot be used to make the uploads key either. With key=items the proof is keyed with the
// items key, for a pinger, which holds that key only.
const helloProof = (nonce, key = TOKEN) => createHmac('sha256', key).update(`driftboard-hello:${nonce}`).digest('hex');
app.get('/api/hello', (req, res) => {
  const { nonce, key } = req.query;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{16,128}$/i.test(nonce)) {
    return res.status(400).json({ error: 'nonce must be 16 to 128 hex characters' });
  }
  if (key !== undefined && key !== 'items') return res.status(400).json({ error: 'key is items, or left out for the token' });
  res.json({ proof: helloProof(nonce, key === 'items' ? ITEMS_KEY : TOKEN) });
});

// Swap a sign-in code for the token: with the hello, the only calls that need no token.
app.post('/api/session', express.json({ limit: '4kb' }), (req, res) => {
  if (!useSignInCode(req.body?.code)) {
    return res.status(401).json({ error: 'that sign-in code is not valid (each works once, for a minute): run `npm run open` again' });
  }
  res.json({ token: TOKEN });
});

// A PIN set with `npm run set-pin` signs a tab in from the locked page, so a new tab or a
// bookmark needs no terminal. Only its scrypt hash is kept (data/pin, 0600). Guessing is slowed
// for everyone (one try at a time, and a wait after each wrong one that doubles), and stops
// after PIN_MAX_FAILURES wrong ones until the PIN is set again.
const PIN_MAX_FAILURES = 20;
const pin = { failures: 0, waitUntil: 0, checking: false, salt: null };
function readPin() {
  try {
    const saved = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
    if (saved.version !== 1) return null;
    if (saved.salt !== pin.salt) Object.assign(pin, { failures: 0, waitUntil: 0, salt: saved.salt }); // set again
    return saved;
  } catch {
    return null;
  }
}
// Whether this board asks for a sign-in at all (DRIFTBOARD_SIGN_IN=off says no).
app.get('/api/sign-in', (req, res) => {
  res.json({ required: SIGN_IN });
});
app.get('/api/pin', (req, res) => {
  res.json({ enabled: Boolean(readPin()) && pin.failures < PIN_MAX_FAILURES });
});
app.post('/api/pin', express.json({ limit: '1kb' }), (req, res) => {
  const saved = readPin();
  if (!saved) return res.status(404).json({ error: 'no PIN is set: run `npm run set-pin` on the machine the board runs on' });
  if (pin.failures >= PIN_MAX_FAILURES) {
    return res.status(423).json({ error: 'too many wrong PINs: set it again with `npm run set-pin`' });
  }
  const now = Date.now();
  if (pin.checking || now < pin.waitUntil) {
    return res.status(429).json({ error: 'wait a moment before trying again', retryAfterMs: Math.max(0, pin.waitUntil - now) });
  }
  pin.checking = true;
  scrypt(String(req.body?.pin ?? ''), Buffer.from(saved.salt, 'hex'), 64, { N: saved.N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
    (err, hash) => {
      pin.checking = false;
      if (err || !timingSafeEqual(hash, Buffer.from(saved.hash, 'hex'))) {
        pin.failures += 1;
        pin.waitUntil = Date.now() + Math.min(1000 * 2 ** (pin.failures - 1), 10 * 60 * 1000);
        return res.status(401).json({ error: 'wrong PIN', triesLeft: PIN_MAX_FAILURES - pin.failures });
      }
      Object.assign(pin, { failures: 0, waitUntil: 0 });
      res.json({ token: TOKEN });
    });
});

// ---- Agents: each holds a token that reaches its own card only ----
// The helper that starts an agent on a card mints a token for that card (with the board token,
// below). With it the agent keeps its card current: progress, notes, a question for the user,
// its result, and moves between the working columns. It can never reach another card, move
// one to Done or Won't do, press a button or start anything: those are the user's.
const AGENT_COLUMNS = ['Working', 'Needs you', 'Review'];
// A board may call its working columns otherwise (kept from another tool, say): each of the agent's
// three is the first of these names the board has.
const AGENT_COLUMN_NAMES = {
  Working: ['Working', 'Researching', 'In progress', 'In Progress', 'Doing'],
  'Needs you': ['Needs you', 'Blocked'],
  Review: ['Review', 'Proposed', 'In review', 'Reviewing'],
};
const agentColumn = (ws, column) => (AGENT_COLUMN_NAMES[column] || [])
  .map((name) => ws.binders.find((binder) => binder.title === name)).find(Boolean) || null;
const CLOSED_COLUMNS = ['Done', "Won't do", 'Completed'];   // Completed: the starter board's own
const AGENT_LIMITS = { progress: 300, question: 2000, result: 20000, content: 20000, text: 8000 };
const CHAT_KEPT = 500; // the newest messages a card keeps
const NOTES_KEPT = 200; // the newest notes items and agents put on a card; the user's own are all kept

// A note an item (source) or an agent (by) puts on a card. Past NOTES_KEPT of those, the oldest go.
function addNote(card, note) {
  card.attachments.push({ id: randomUUID(), type: 'text', createdAt: now(), order: card.attachments.length, ...note });
  const added = card.attachments.filter((a) => a.type === 'text' && (a.by || a.source));
  if (added.length > NOTES_KEPT) {
    const dropped = new Set(added.slice(0, added.length - NOTES_KEPT).map((a) => a.id));
    card.attachments = card.attachments.filter((a) => !dropped.has(a.id));
  }
}

// The card's conversation: the user and its agent, oldest first. A question is the agent asking,
// a result the agent's answer; the rest is talk.
function addChat(card, from, text, kind, images) {
  const message = { id: randomUUID(), from, text, at: now(), ...(kind ? { kind } : {}),
    ...(from === 'agent' && card.agent?.name ? { name: card.agent.name } : {}), ...(images?.length ? { images } : {}) };
  card.chat = [...(card.chat || []), message].slice(-CHAT_KEPT);
  return message;
}
const agentTokenHash = (token) => createHash('sha256').update(`driftboard-agent:${token}`).digest('hex');
const columnOf = (ws, card) => ws.binders.find((b) => b.id === card.binderId)?.title || null;

function agentCard(req, res) {
  const found = getCard(req.params.id);
  const token = requestToken(req);
  if (!found || !found.card.agent?.tokenHash || !token || !sameSecret(agentTokenHash(token), found.card.agent.tokenHash)) {
    res.status(401).json({ error: 'this token does not reach this card' });
    return null;
  }
  if (CLOSED_COLUMNS.includes(columnOf(found.ws, found.card))) {
    res.status(409).json({ error: 'the user closed this card' });
    return null;
  }
  return found;
}

function agentText(body, field, res) {
  const value = body?.[field];
  if (typeof value !== 'string' || !value.trim()) return res.status(400).json({ error: `${field} is required` }), null;
  if (value.length > AGENT_LIMITS[field]) return res.status(400).json({ error: `${field} is longer than ${AGENT_LIMITS[field]} characters` }), null;
  return value.trim();
}

function moveCard(ws, card, binder) {
  const from = card.binderId;
  card.binderId = binder.id;
  card.order = ws.cards.filter((c) => c.binderId === binder.id && c.id !== card.id).length;
  reindexBinder(ws, from);
  reindexBinder(ws, binder.id);
}

const agentApi = express.Router();
// Room for the longest text (20000 characters) however it is sent: UTF-8 takes up to 4 bytes a
// character, and an escaped \uXXXX 6.
agentApi.use(express.json({ limit: '256kb' }));
// What the agent needs to read: its card, the user's side of the chat with it, and the column.
agentApi.get('/cards/:id', (req, res) => {
  const found = agentCard(req, res); if (!found) return;
  const { ws, card } = found;
  const { tokenHash, ...agent } = card.agent;
  res.json({ card: { id: card.id, title: card.title, description: card.description, column: columnOf(ws, card),
    chat: card.chat || [], agent } });
});
agentApi.patch('/cards/:id', (req, res) => {   // {progress?, result?}
  const found = agentCard(req, res); if (!found) return;
  const { card } = found;
  for (const field of ['progress', 'result']) {
    if (req.body?.[field] === undefined) continue;
    const value = agentText(req.body, field, res); if (value === null) return;
    card.agent[field] = value;
    if (field === 'result') addChat(card, 'agent', value, 'result');
  }
  card.agent.updatedAt = now();
  card.updatedAt = now();
  persist();
  res.json({ ok: true });
});
agentApi.post('/cards/:id/notes', (req, res) => {   // {content}
  const found = agentCard(req, res); if (!found) return;
  const content = agentText(req.body, 'content', res); if (content === null) return;
  const { card } = found;
  addNote(card, { content, by: card.agent.name });
  card.updatedAt = now();
  persist();
  res.status(201).json({ ok: true });
});
agentApi.post('/cards/:id/ask', (req, res) => {   // {question}: the card goes to Needs you
  const found = agentCard(req, res); if (!found) return;
  const question = agentText(req.body, 'question', res); if (question === null) return;
  const { ws, card } = found;
  card.agent.question = question;
  card.agent.askedAt = now();
  addChat(card, 'agent', question, 'question');
  const binder = agentColumn(ws, 'Needs you');
  if (binder) moveCard(ws, card, binder);
  card.updatedAt = now();
  persist();
  res.json({ ok: true });
});
agentApi.post('/cards/:id/chat', (req, res) => {   // {text}: the agent says something to the user
  const found = agentCard(req, res); if (!found) return;
  const text = agentText(req.body, 'text', res); if (text === null) return;
  const message = addChat(found.card, 'agent', text);
  found.card.updatedAt = now();
  persist();
  res.status(201).json(message);
});
agentApi.post('/cards/:id/move', (req, res) => {   // {column}: Working, Needs you or Review
  const found = agentCard(req, res); if (!found) return;
  const { ws, card } = found;
  const column = typeof req.body?.column === 'string' ? req.body.column.trim() : '';
  const binder = AGENT_COLUMNS.includes(column) && agentColumn(ws, column);
  if (!binder) return res.status(400).json({ error: `an agent moves its card only to ${AGENT_COLUMNS.join(', ')}` });
  moveCard(ws, card, binder);
  if (column !== 'Needs you') delete card.agent.question;   // answered: back to work, or done
  card.updatedAt = now();
  persist();
  res.json({ ok: true });
});
app.use('/api/agent', agentApi);   // before the board token: these take the card's own token

app.use('/api', requireToken);
app.use('/api', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    res.set('X-Board-Revision', String(revision)); // read when sent, after the handler's write
    return json(body);
  };
  next();
});
app.use('/uploads', (req, res, next) => {
  if (!SIGN_IN || sameSecret(req.query.k, UPLOADS_KEY) || sameSecret(requestToken(req), TOKEN)) return next();
  res.status(401).send('this file needs the board\'s uploads key');
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'docs'))); // static site (also the GitHub Pages source); marked/purify are vendored under docs/vendor/
// Uploads are served from the board's own origin, where the token lives: an uploaded page or
// SVG opened in a tab must not run there. Nothing is sniffed, nothing runs (sandbox), and only
// images and videos show inline; anything else downloads.
app.use('/uploads', express.static(UPLOADS_DIR, {
  setHeaders: (res, file) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "sandbox; frame-ancestors 'none'");
    if (!/^(image\/(?!svg)|video\/)/.test(express.static.mime.lookup(file))) res.set('Content-Disposition', 'attachment');
  },
}));

// ---- Session ----
app.post('/api/sign-in-codes', (req, res) => {
  res.status(201).json(makeSignInCode());
});
app.get('/api/session', (req, res) => {
  res.json({ uploadsKey: UPLOADS_KEY });
});

// ---- Workspaces ----
app.get('/api/state', (req, res) => {
  res.json({
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map((w) => ({ id: w.id, name: w.name })),
    notice: state.notice || null,
  });
});

// A one-line notice a script pins at the top of the board ("out of usage until 7pm"), until it
// clears it. Text only; every open tab shows it within seconds.
app.put('/api/notice', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 300) : '';
  const level = ['info', 'warning', 'error'].includes(req.body?.level) ? req.body.level : 'info';
  if (!text) return res.status(400).json({ error: 'text is required (DELETE /api/notice clears it)' });
  if (state.notice?.text !== text || state.notice?.level !== level) {
    state.notice = { text, level, at: now() };
    persist();
  }
  res.json(state.notice);
});
app.delete('/api/notice', (req, res) => {
  if (state.notice) {
    state.notice = null;
    persist();
  }
  res.json({ ok: true });
});

app.patch('/api/state', (req, res) => {
  if (getWorkspace(req.body.activeWorkspaceId)) state.activeWorkspaceId = req.body.activeWorkspaceId;
  persist();
  res.json({ ok: true });
});

app.get('/api/workspaces/:id', (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  res.json(ws);
});

app.post('/api/workspaces', (req, res) => {
  const name = (req.body.name || '').trim() || uniqueWorkspaceName('New board');
  const ws = { id: randomUUID(), name, view: { panX: 0, panY: 0, zoom: 1 }, binders: [], cards: [] };
  state.workspaces.push(ws);
  state.activeWorkspaceId = ws.id;
  persist();
  res.status(201).json(ws);
});

app.patch('/api/workspaces/:id', (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) ws.name = req.body.name.trim();
  if (req.body.view && typeof req.body.view === 'object') {
    ws.view = {
      panX: Number(req.body.view.panX) || 0,
      panY: Number(req.body.view.panY) || 0,
      zoom: Math.min(2.5, Math.max(0.25, Number(req.body.view.zoom) || 1)),
    };
  }
  persist();
  res.json({ id: ws.id, name: ws.name, view: ws.view });
});

app.delete('/api/workspaces/:id', async (req, res) => {
  const index = state.workspaces.findIndex((w) => w.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'workspace not found' });
  if (state.workspaces.length === 1) return res.status(400).json({ error: 'cannot delete the last workspace' });
  const [ws] = state.workspaces.splice(index, 1);
  if (state.activeWorkspaceId === ws.id) state.activeWorkspaceId = state.workspaces[0].id;
  persist();
  await Promise.all(ws.cards.flatMap((c) => (c.attachments || [])
    .filter((a) => a.filename)
    .map((a) => fsp.unlink(path.join(UPLOADS_DIR, a.filename)).catch(() => {}))));
  res.json({ ok: true, activeWorkspaceId: state.activeWorkspaceId });
});

// ---- Binders ----
app.post('/api/workspaces/:id/binders', (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  const binder = {
    id: randomUUID(),
    title: (req.body.title || 'New binder').trim() || 'New binder',
    x: Number(req.body.x) || 48,
    y: Number(req.body.y) || 48,
  };
  ws.binders.push(binder);
  persist();
  res.status(201).json(binder);
});

// A colour is drawn into the page's CSS (--binder-color), so it is a colour and nothing else:
// a url() there would load from anywhere.
const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

app.patch('/api/binders/:id', (req, res) => {
  const found = getBinder(req.params.id);
  if (!found) return res.status(404).json({ error: 'binder not found' });
  if (req.body.color !== undefined && !isColor(req.body.color)) return res.status(400).json({ error: 'color must be #rrggbb' });
  const { binder } = found;
  if (typeof req.body.title === 'string' && req.body.title.trim()) binder.title = req.body.title.trim();
  if (req.body.x !== undefined) binder.x = Number(req.body.x);
  if (req.body.y !== undefined) binder.y = Number(req.body.y);
  if (req.body.color !== undefined) binder.color = req.body.color.toLowerCase();
  if (typeof req.body.description === 'string') binder.description = req.body.description;
  persist();
  res.json(binder);
});

// Delete a binder; its cards spill out onto the canvas near where it was.
app.delete('/api/binders/:id', (req, res) => {
  const found = getBinder(req.params.id);
  if (!found) return res.status(404).json({ error: 'binder not found' });
  const { ws, binder } = found;
  const members = ws.cards
    .filter((c) => c.binderId === binder.id)
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ id: c.id, order: c.order }));
  ws.cards.filter((c) => c.binderId === binder.id).forEach((c, i) => {
    c.binderId = null;
    c.x = binder.x + 16 + (i % 3) * 24;
    c.y = binder.y + 64 + i * 28;
  });
  ws.binders = ws.binders.filter((b) => b.id !== binder.id);
  pushTrash({ type: 'binder', workspaceId: ws.id, binder, members });
  persist();
  res.json({ ok: true });
});

// ---- Cards ----
app.post('/api/workspaces/:id/cards', (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const binderId = ws.binders.some((b) => b.id === req.body.binderId) ? req.body.binderId : null;
  const card = {
    id: randomUUID(),
    title,
    description: '',
    attachments: [],
    binderId,
    order: binderId ? ws.cards.filter((c) => c.binderId === binderId).length : 0,
    x: Number(req.body.x) || 80,
    y: Number(req.body.y) || 80,
    createdAt: now(),
    updatedAt: now(),
  };
  ws.cards.push(card);
  persist();
  res.status(201).json(card);
});

// ---- Items: work from anywhere (a chat watcher, CI, email, a script) ----
// One call makes a card. A repeat of the same item is ignored, and a later item in the same
// thread joins the card the thread started (as a note), so a back-and-forth stays one card.
const ITEM_BINDERS = ['New', 'Working', 'Needs you', 'Review', 'Done', "Won't do"];
const ITEM_LIMITS = { title: 200, body: 16000, source: 40, externalId: 200, thread: 200, workspace: 80, column: 80 };
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
// The ids each source's items came with, newest last, and the card each went to: a repeat is known
// even once the user deleted its card (a pinger that sends a window of its mailbox again).
const SEEN_KEPT = 5000; // per source
function seenItem(source, externalId) {
  return (state.seenItems?.[source] || []).find(([id]) => id === externalId) || null;
}
function rememberItem(source, externalId, cardId) {
  state.seenItems ??= {};
  const seen = (state.seenItems[source] || []).filter(([id]) => id !== externalId);
  seen.push([externalId, cardId]);
  state.seenItems[source] = seen.slice(-SEEN_KEPT);
}
if (!state.seenItems) {   // a board from before the index: what its cards remember
  for (const ws of state.workspaces) {
    for (const card of ws.cards) for (const id of card.source?.items || []) rememberItem(card.source.name, id, card.id);
  }
}

function itemProblems(item) {
  const problems = [];
  for (const [field, limit] of Object.entries(ITEM_LIMITS)) {
    const value = item[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') problems.push(`${field} must be text`);
    else if (value.length > limit) problems.push(`${field} is longer than ${limit} characters`);
  }
  if (typeof item.title !== 'string' || !item.title.trim()) problems.push('title is required');
  if (typeof item.workspace === 'string' && !item.workspace.trim()) problems.push('workspace must name a board (leave it out for Inbox)');
  if (typeof item.source !== 'string' || !SOURCE_NAME.test(item.source)) {
    problems.push('source is required: lowercase letters, digits, . _ - (who sent it, e.g. "ci")');
  }
  if (item.link !== undefined && item.link !== null) {
    if (typeof item.link !== 'object' || !webURL(item.link.url)) problems.push('link.url must be an http or https address');
    else if (item.link.title !== undefined && (typeof item.link.title !== 'string' || item.link.title.length > 200)) {
      problems.push('link.title must be text of at most 200 characters');
    }
  }
  return problems;
}

// The board an item names, made with the work columns if it is not there yet.
function itemWorkspace(name) {
  let ws = state.workspaces.find((w) => w.name === name);
  if (!ws) {
    ws = { ...starterWorkspace(name), binders: makeBinders(ITEM_BINDERS) };
    state.workspaces.push(ws);
  }
  return ws;
}

app.post('/api/items', (req, res) => {
  const item = req.body && typeof req.body === 'object' ? req.body : {};
  const problems = itemProblems(item);
  if (problems.length) return res.status(400).json({ error: 'invalid item', problems });
  const source = item.source;
  const seen = item.externalId && seenItem(source, item.externalId);
  if (seen) {
    const held = seen[1] && getCard(seen[1]);   // gone: the user deleted it, and it stays gone
    return res.json({ cardId: held ? held.card.id : null, workspaceId: held ? held.ws.id : null, created: false, duplicate: true });
  }
  const remember = (card) => { if (item.externalId) rememberItem(source, item.externalId, card.id); };
  if (item.thread) {
    for (const ws of state.workspaces) {
      const card = ws.cards.find((c) => c.source?.name === source && c.source.thread === item.thread);
      if (!card) continue;
      // On a closed card nobody would see it: the card comes back where a new item lands.
      const landing = ws.binders[0];
      const reopened = CLOSED_COLUMNS.includes(columnOf(ws, card)) && landing && !CLOSED_COLUMNS.includes(landing.title);
      if (reopened) moveCard(ws, card, landing);
      const content = [reopened ? `_Reopened: a new item came in on this thread._` : '', `**${source}**: ${item.title.trim()}`,
        (item.body || '').trim()].filter(Boolean).join('\n\n');
      addNote(card, { content, source });
      if (item.link && !card.attachments.some((a) => a.type === 'url' && a.url === webURL(item.link.url))) {
        card.attachments.push({ id: randomUUID(), type: 'url', url: webURL(item.link.url), title: (item.link.title || '').trim(),
          createdAt: now(), order: card.attachments.length });
      }
      remember(card);
      card.updatedAt = now();
      persist();
      return res.json({ cardId: card.id, workspaceId: ws.id, created: false, joined: true, ...(reopened ? { reopened: true } : {}) });
    }
  }
  const wanted = (item.workspace || 'Inbox').trim();
  const existing = state.workspaces.find((w) => w.name === wanted);
  const columns = existing ? existing.binders.map((b) => b.title) : ITEM_BINDERS;   // checked before a new board is made
  if (item.column && !columns.includes(item.column.trim())) {
    return res.status(400).json({ error: `no column "${item.column}" on ${wanted}`, columns });
  }
  const ws = existing || itemWorkspace(wanted);
  const binder = (item.column && ws.binders.find((b) => b.title === item.column.trim())) || ws.binders[0] || null;
  const card = {
    id: randomUUID(),
    title: item.title.trim(),
    description: (item.body || '').trim(),
    attachments: [],
    binderId: binder ? binder.id : null,
    order: binder ? ws.cards.filter((c) => c.binderId === binder.id).length : 0,
    x: 80, y: 80,
    source: { name: source, ...(item.thread ? { thread: item.thread } : {}) },
    createdAt: now(),
    updatedAt: now(),
  };
  if (item.link) {
    card.attachments.push({ id: randomUUID(), type: 'url', url: webURL(item.link.url), title: (item.link.title || '').trim(),
      createdAt: now(), order: 0 });
  }
  remember(card);
  ws.cards.push(card);
  persist();
  res.status(201).json({ cardId: card.id, workspaceId: ws.id, created: true });
});

// The user writes to the card's agent (from the open card, or a script on their behalf), with
// pictures already uploaded to the card: {text, images?: [attachment id]}. Only the kinds of
// picture an agent can look at.
const CHAT_IMAGES = 8;
const CHAT_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
app.post('/api/cards/:id/chat', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const wanted = req.body?.images ?? [];
  if (!Array.isArray(wanted) || wanted.length > CHAT_IMAGES || !wanted.every((id) => typeof id === 'string')) {
    return res.status(400).json({ error: `images must be a list of at most ${CHAT_IMAGES} attachment ids` });
  }
  const images = [];
  for (const id of new Set(wanted)) {
    const attachment = found.card.attachments.find((each) => each.id === id);
    if (!attachment?.filename || !CHAT_IMAGE_TYPES.test(attachment.mimeType || '')) {
      return res.status(400).json({ error: `${id} is not a png, jpeg, gif or webp picture on this card` });
    }
    images.push({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
      name: attachment.originalName || '' });
  }
  if (!text && !images.length) return res.status(400).json({ error: 'text or a picture is required' });
  if (text.length > AGENT_LIMITS.text) return res.status(400).json({ error: `text is longer than ${AGENT_LIMITS.text} characters` });
  const message = addChat(found.card, 'user', text, undefined, images);
  found.card.updatedAt = now();
  persist();
  res.status(201).json(message);
});

// The helper starting an agent on a card mints its token (shown once; a new one replaces it),
// and revokes it when the agent stops. What the agent reported stays on the card.
app.post('/api/cards/:id/agent', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : 'agent';
  const token = randomBytes(32).toString('base64url');
  found.card.agent = { ...(found.card.agent || {}), name, tokenHash: agentTokenHash(token), startedAt: now() };
  delete found.card.agent.stoppedAt;
  persist();
  res.status(201).json({ token, cardId: found.card.id });
});
app.delete('/api/cards/:id/agent', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  if (found.card.agent) {
    delete found.card.agent.tokenHash;
    delete found.card.agent.question;
    found.card.agent.stoppedAt = now();
    persist();
  }
  res.json({ ok: true });
});

// Which board a card is on, for a link straight to it.
app.get('/api/cards/:id', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  res.json({ workspaceId: found.ws.id, card: found.card });
});

// Buttons a script puts on its cards (e.g. start / pause): pressing one records it on the card
// for that script to act on; the board itself runs nothing.
const BUTTON_ID = /^[a-z][a-z0-9-]{0,31}$/;
function validButtons(buttons) {
  return Array.isArray(buttons) && buttons.length <= 3 && buttons.every((button) =>
    button && typeof button === 'object' && BUTTON_ID.test(button.id) &&
    typeof button.label === 'string' && button.label.trim() && button.label.length <= 24 &&
    (button.title === undefined || (typeof button.title === 'string' && button.title.length <= 120)) &&
    (button.input === undefined || (typeof button.input === 'string' && button.input.trim() && button.input.length <= 120)) &&
    (button.confirm === undefined || (typeof button.confirm === 'string' && button.confirm.trim() && button.confirm.length <= 24)));
}

app.patch('/api/cards/:id', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  if (req.body.buttons !== undefined && req.body.buttons !== null && !validButtons(req.body.buttons)) {
    return res.status(400).json({ error: 'buttons: at most 3 of {id: a-z0-9-, label: up to 24 characters, title?, confirm?, input?}' });
  }
  if (req.body.pressed !== undefined && req.body.pressed !== null) {
    return res.status(400).json({ error: 'pressed can only be cleared (null); press a button with POST /press' });
  }
  if (req.body.pressedAt !== undefined && (req.body.pressed !== null || typeof req.body.pressedAt !== 'string')) {
    return res.status(400).json({ error: 'pressedAt goes with pressed: null: the `at` of the press the script handled' });
  }
  if (req.body.chat !== undefined && typeof req.body.chat !== 'boolean') {
    return res.status(400).json({ error: 'chat must be true or false: whether the open card offers a chat with its agent' });
  }
  const { card } = found;
  if (typeof req.body.title === 'string') card.title = req.body.title;
  if (typeof req.body.description === 'string') card.description = req.body.description;
  if (typeof req.body.attSort === 'string' && ['newest', 'oldest', 'custom'].includes(req.body.attSort)) card.attSort = req.body.attSort;
  if (req.body.buttons !== undefined) {
    if (req.body.buttons && req.body.buttons.length) {
      card.buttons = req.body.buttons.map(({ id, label, title, confirm, input }) => ({
        id, label: label.trim(), ...(title ? { title } : {}), ...(confirm ? { confirm: confirm.trim() } : {}),
        ...(input ? { input: input.trim() } : {}),
      }));
    } else delete card.buttons;
  }
  // A script clears the press it handled, named by its `at`: a newer press, made while it was busy,
  // stays for its next look. Without pressedAt (older scripts) any press is cleared.
  if (req.body.pressed === null && (req.body.pressedAt === undefined || card.pressed?.at === req.body.pressedAt)) delete card.pressed;
  // A script that talks to the card's agent offers the chat (card.chat holds the messages themselves).
  if (req.body.chat === true) card.chatEnabled = true;
  else if (req.body.chat === false) delete card.chatEnabled;
  card.updatedAt = now();
  persist();
  res.json(card);
});

// Press one of a card's buttons: {button: id}. Only a button the card has; a second press
// before the script took the first replaces it.
app.post('/api/cards/:id/press', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const { card } = found;
  const button = (card.buttons || []).find((each) => each.id === req.body.button);
  if (!button) return res.status(400).json({ error: 'this card has no such button' });
  // A button with `input` asks the user for text first (e.g. context for an agent): the press carries it.
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (button.input && !text) return res.status(400).json({ error: 'this button takes some text' });
  if (text.length > 8000) return res.status(400).json({ error: 'the text is longer than 8000 characters' });
  card.pressed = { button: req.body.button, at: now(), ...(button.input ? { text } : {}) };
  card.updatedAt = now();
  persist();
  res.json(card);
});

// Unified move: into a binder ({binderId, toIndex}) or free on canvas ({binderId:null, x, y}).
app.post('/api/cards/:id/move', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const { ws, card } = found;
  const fromBinderId = card.binderId;
  const targetBinder = ws.binders.find((b) => b.id === req.body.binderId);

  if (targetBinder) {
    const column = ws.cards
      .filter((c) => c.binderId === targetBinder.id && c.id !== card.id)
      .sort((a, b) => a.order - b.order);
    let index = Number.isInteger(req.body.toIndex) ? req.body.toIndex : column.length;
    index = Math.max(0, Math.min(index, column.length));
    column.splice(index, 0, card);
    card.binderId = targetBinder.id;
    column.forEach((c, i) => { c.order = i; });
  } else {
    card.binderId = null;
    if (req.body.x !== undefined) card.x = Number(req.body.x);
    if (req.body.y !== undefined) card.y = Number(req.body.y);
  }
  if (fromBinderId && fromBinderId !== card.binderId) reindexBinder(ws, fromBinderId);
  card.updatedAt = now();
  persist();
  res.json({ ok: true });
});

// Soft-delete a card: keep its files so the deletion can be undone.
app.delete('/api/cards/:id', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const { ws, card } = found;
  ws.cards = ws.cards.filter((c) => c.id !== card.id);
  if (card.binderId) reindexBinder(ws, card.binderId);
  pushTrash({ type: 'card', workspaceId: ws.id, card });
  persist();
  res.json({ ok: true });
});

// Undo the most recent card/binder deletion.
app.post('/api/undo', (req, res) => {
  const entry = state.trash.pop();
  if (!entry) return res.json({ ok: false, empty: true });
  const ws = getWorkspace(entry.workspaceId);
  if (!ws) { persist(); return res.json({ ok: false }); }

  if (entry.type === 'card') {
    const card = entry.card;
    if (card.binderId && !ws.binders.some((b) => b.id === card.binderId)) card.binderId = null;
    ws.cards.push(card);
    if (card.binderId) reindexBinder(ws, card.binderId);
    persist();
    return res.json({ ok: true, kind: 'card', workspaceId: ws.id });
  }
  // binder
  ws.binders.push(entry.binder);
  entry.members.forEach((m) => {
    const c = ws.cards.find((cc) => cc.id === m.id);
    if (c) { c.binderId = entry.binder.id; c.order = m.order; }
  });
  reindexBinder(ws, entry.binder.id);
  persist();
  res.json({ ok: true, kind: 'binder', workspaceId: ws.id });
});

// ---- Attachments ----
app.post('/api/cards/:id/attachments', upload.single('file'), async (req, res) => {
  const found = getCard(req.params.id);
  if (!found) {
    if (req.file) await fsp.unlink(req.file.path).catch(() => {});
    return res.status(404).json({ error: 'card not found' });
  }
  const { card } = found;

  let attachment;
  if (req.file) {
    attachment = {
      id: randomUUID(),
      type: attachmentType(req.file.mimetype),
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      createdAt: now(),
    };
  } else if (req.body.type === 'text') {
    attachment = { id: randomUUID(), type: 'text', content: req.body.content || '', createdAt: now() };
  } else if (req.body.type === 'url') {
    if (!String(req.body.url ?? '').trim()) return res.status(400).json({ error: 'url is required' });
    const url = webURL(req.body.url);
    if (!url) return res.status(400).json({ error: 'only http and https links can be attached' });
    attachment = { id: randomUUID(), type: 'url', url, title: (req.body.title || '').trim(), createdAt: now() };
  } else {
    return res.status(400).json({ error: 'unsupported attachment' });
  }

  attachment.order = card.attachments.length;
  card.attachments.push(attachment);
  card.updatedAt = now();
  persist();
  res.status(201).json(attachment);
});

// Set a custom attachment order (drag-to-reorder).
app.post('/api/cards/:id/attachments/reorder', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const { card } = found;
  const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [];
  ids.forEach((id, i) => { const a = card.attachments.find((x) => x.id === id); if (a) a.order = i; });
  card.attSort = 'custom';
  card.updatedAt = now();
  persist();
  res.json({ ok: true });
});

app.patch('/api/cards/:id/attachments/:attId', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const att = (found.card.attachments || []).find((a) => a.id === req.params.attId);
  if (!att) return res.status(404).json({ error: 'attachment not found' });
  const url = att.type === 'url' && typeof req.body.url === 'string' && req.body.url.trim() ? webURL(req.body.url) : undefined;
  if (url === null) return res.status(400).json({ error: 'only http and https links can be attached' });
  if (att.type === 'text' && typeof req.body.content === 'string') att.content = req.body.content;
  if (url) att.url = url;
  if (typeof req.body.title === 'string') att.title = req.body.title;
  found.card.updatedAt = now();
  persist();
  res.json(att);
});

app.delete('/api/cards/:id/attachments/:attId', async (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const { card } = found;
  const index = (card.attachments || []).findIndex((a) => a.id === req.params.attId);
  if (index === -1) return res.status(404).json({ error: 'attachment not found' });
  const [att] = card.attachments.splice(index, 1);
  card.updatedAt = now();
  persist();
  if (att.filename) await fsp.unlink(path.join(UPLOADS_DIR, att.filename)).catch(() => {});
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'request failed' });
});

app.listen(PORT, HOST, () => {
  console.log(SIGN_IN ? `driftboard running at ${localURL()}; open it with: npm run open`
    : `driftboard running at ${localURL()} with no sign-in (DRIFTBOARD_SIGN_IN=off): anyone on this machine can open it`);
  console.log(`data dir: ${DATA_DIR}`);
  if (LEGACY_DATA_DIR) {
    console.log('  (an earlier version\'s folder, kept because the board is there: the helper and the pinger look in '
      + '~/.local/share/driftboard, so move it there, or set DRIFTBOARD_DATA for all three)');
  }
});
