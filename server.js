import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, HOST, PORT, TOKEN_FILE, localURL } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');

const STARTER_BINDERS = ['To Do', 'In Progress', 'Blocked', 'Reviewing', 'Completed'];
const STAGE_TITLES = {
  'todo': 'To Do', 'in-progress': 'In Progress', 'blocked': 'Blocked',
  'reviewing': 'Reviewing', 'completed': 'Completed',
};

// --- Storage ---------------------------------------------------------------

fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 }); // the board is nobody else's to read
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

let state = defaultState();
try {
  const raw = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
  if (Array.isArray(raw.workspaces)) {
    state = raw;
  } else if (Array.isArray(raw.cards)) {
    state = migrateV1(raw); // v1 board.json
  }
} catch {
  // no board yet — start fresh
}
if (!Array.isArray(state.trash)) state.trash = []; // undo history for deleted cards/binders
const TRASH_CAP = 40;

// Serialize writes so overlapping requests can't corrupt the file.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    const tmp = BOARD_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, BOARD_FILE);
  }).catch((err) => console.error('persist failed:', err));
  return writeChain;
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ''}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });
function attachmentType(mimeType) {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  return 'file';
}

// --- Access ----------------------------------------------------------------
// The board has no accounts: one token, made on first start, opens it. A browser signs in
// once with the link from `npm run open` and keeps the token in a cookie; scripts send it
// as a bearer token. The page itself is public code (it is the GitHub Pages demo too).

function loadToken() {
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // first start
  }
  const made = randomBytes(32).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, made + '\n', { mode: 0o600 });
  return made;
}
const TOKEN = loadToken();
const COOKIE = 'driftboard_token';

function isToken(value) {
  const given = Buffer.from(String(value || ''));
  const wanted = Buffer.from(TOKEN);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
function requestToken(req) {
  const bearer = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (bearer) return bearer[1].trim();
  const cookie = (req.get('Cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + '='));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : null;
}

// The sign-in link: keep the token in a cookie, then drop it from the address bar.
function signIn(req, res, next) {
  if (req.method !== 'GET' || req.query.token === undefined) return next();
  if (!isToken(req.query.token)) return res.status(401).send('That sign-in link is not valid for this board.');
  res.cookie(COOKIE, TOKEN, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 365 * 24 * 3600 * 1000 });
  const url = new URL(req.originalUrl, 'http://board.invalid');
  url.searchParams.delete('token');
  res.redirect(303, url.pathname + url.search + url.hash);
}

function requireToken(req, res, next) {
  if (!isToken(requestToken(req))) {
    return res.status(401).json({ error: 'this board is locked: open it with the link from `npm run open`' });
  }
  // A page on another local port is the same site, so the cookie alone would let it write.
  const origin = req.get('Origin');
  if (req.method !== 'GET' && origin && origin !== `${req.protocol}://${req.get('Host')}`) {
    return res.status(403).json({ error: 'cross-origin writes are not allowed' });
  }
  next();
}

// --- App -------------------------------------------------------------------

const app = express();
app.use(signIn);
app.use('/api', requireToken);
app.use('/uploads', requireToken);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'docs'))); // static site (also the GitHub Pages source); marked/purify are vendored under docs/vendor/
app.use('/uploads', express.static(UPLOADS_DIR));

// ---- Workspaces ----
app.get('/api/state', (req, res) => {
  res.json({
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map((w) => ({ id: w.id, name: w.name })),
  });
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

app.patch('/api/binders/:id', (req, res) => {
  const found = getBinder(req.params.id);
  if (!found) return res.status(404).json({ error: 'binder not found' });
  const { binder } = found;
  if (typeof req.body.title === 'string' && req.body.title.trim()) binder.title = req.body.title.trim();
  if (req.body.x !== undefined) binder.x = Number(req.body.x);
  if (req.body.y !== undefined) binder.y = Number(req.body.y);
  if (typeof req.body.color === 'string') binder.color = req.body.color;
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

app.patch('/api/cards/:id', (req, res) => {
  const found = getCard(req.params.id);
  if (!found) return res.status(404).json({ error: 'card not found' });
  const { card } = found;
  if (typeof req.body.title === 'string') card.title = req.body.title;
  if (typeof req.body.description === 'string') card.description = req.body.description;
  if (typeof req.body.attSort === 'string' && ['newest', 'oldest', 'custom'].includes(req.body.attSort)) card.attSort = req.body.attSort;
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
    const url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
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
  if (att.type === 'text' && typeof req.body.content === 'string') att.content = req.body.content;
  if (att.type === 'url' && typeof req.body.url === 'string' && req.body.url.trim()) att.url = req.body.url.trim();
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
  console.log(`driftboard running at ${localURL()}; sign in with: npm run open`);
  if (process.stdout.isTTY) console.log(`sign-in link: ${localURL(TOKEN)}`);
  console.log(`data dir: ${DATA_DIR}`);
});
