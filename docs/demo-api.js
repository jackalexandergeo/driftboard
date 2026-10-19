/* Driftboard demo backend — a browser-only port of server.js.
 *
 * When demo mode is on (see config.js), app.js routes every api() call here
 * instead of to the network, and resolves fileUrl() to object URLs from blobs
 * stored locally. Board metadata lives in IndexedDB (mirroring board.json);
 * uploaded files live as Blobs in a second store (mirroring data/uploads/).
 *
 * This script is inert until handle() is first called, so including it in the
 * server-backed app costs nothing. It intentionally mirrors server.js's route
 * bodies 1:1 so behaviour (migration-free defaults, trash/undo, reindexing,
 * attachment sorting) is identical.
 */
(() => {
  'use strict';

  const STARTER_BINDERS = ['To Do', 'In Progress', 'Blocked', 'Reviewing', 'Completed'];
  const SEED_VERSION = 1; // bump to re-seed everyone's untouched demo board
  const TRASH_CAP = 40;
  const DB_NAME = 'driftboard-demo';

  const now = () => new Date().toISOString();
  const uuid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x))); // emulate the JSON-over-HTTP boundary
  const safeExtension = (name) => { // as server.js: a short, plain extension, or none
    const base = String(name || '').split(/[\\/]/).pop();
    const extension = base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
    return /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : '';
  };
  const webURL = (value) => { // as server.js: http(s) links only
    const text = String(value ?? '').trim();
    try { return ['http:', 'https:'].includes(new URL(text).protocol) ? text : null; } catch { return null; }
  };
  const err = (message) => Object.assign(new Error(message), { status: / not found$/.test(message) ? 404 : 400 }); // as the server's replies

  // --- Storage state (in memory; persisted to IndexedDB) ---------------------
  let db = null;
  let state = null;
  let initPromise = null;
  const urlByFilename = new Map(); // filename -> object URL, so fileUrl() stays synchronous

  function makeBinders(titles) {
    return titles.map((title, i) => ({ id: uuid(), title, x: 40 + i * 340, y: 40 }));
  }
  function starterWorkspace(name = 'My Board') {
    return { id: uuid(), name, view: { panX: 0, panY: 0, zoom: 1 }, binders: makeBinders(STARTER_BINDERS), cards: [] };
  }
  function defaultState() {
    const ws = starterWorkspace();
    return { version: 2, activeWorkspaceId: ws.id, workspaces: [ws], trash: [] };
  }

  // --- Demo seed: preload the board with driftboard's own dev history --------
  // Images are the showcase media served from docs/media/; seed() fetches them
  // into the blob store on first load (and on reset) so they behave like uploads.
  const SEED_IMAGES = [
    { key: 'seed-animations', src: 'media/cardMoveAnimations.gif', mimeType: 'image/gif', name: 'drag-animations.gif' },
    { key: 'seed-reorder', src: 'media/showCardAttachments.gif', mimeType: 'image/gif', name: 'attachment-reordering.gif' },
    { key: 'seed-attachments', src: 'media/cardAttachmentView.png', mimeType: 'image/png', name: 'card-attachments.png' },
    { key: 'seed-board', src: 'media/normalView.png', mimeType: 'image/png', name: 'driftboard-board.png' },
  ];
  const IMG = Object.fromEntries(SEED_IMAGES.map((i) => [i.key, i]));

  function buildSeedState(sizes) {
    const txt = (content, createdAt, order) => ({ id: uuid(), type: 'text', content, createdAt, order });
    const link = (url, title, createdAt, order) => ({ id: uuid(), type: 'url', url, title, createdAt, order });
    const img = (key, createdAt, order) => ({ id: uuid(), type: 'image', filename: IMG[key].key, originalName: IMG[key].name, mimeType: IMG[key].mimeType, size: sizes[IMG[key].key] || 0, createdAt, order });
    const card = (o) => ({ description: '', attachments: [], ...o });

    const binders = [
      { id: uuid(), title: 'To Do', x: 40, y: 40, color: '#646d72' },
      { id: uuid(), title: 'In Progress', x: 380, y: 40, color: '#e76125' },
      { id: uuid(), title: 'Blocked', x: 720, y: 40, color: '#d21419' },
      { id: uuid(), title: 'Reviewing', x: 1060, y: 40, color: '#b8860b' },
      { id: uuid(), title: 'Completed', x: 1400, y: 40, color: '#2e8b57' },
    ];
    const [todo, inprog, blocked, reviewing, completed] = binders.map((b) => b.id);

    const cards = [
      card({
        id: uuid(), title: '👋 Welcome to the Driftboard demo', binderId: null, order: 0, x: 40, y: 430,
        description: 'This whole board lives in **your browser** — nothing is uploaded. Drag cards between binders, open one to add notes and files, and hit **Reset demo** in the top bar to start fresh.\n\nPan by dragging empty space; ⌘/Ctrl + scroll to zoom.',
        attachments: [txt('Everything here is a real, editable card. Try dragging me somewhere, or open me and drop in an image.', '2026-07-23T09:00:00.000Z', 0)],
        createdAt: '2026-07-23T09:00:00.000Z', updatedAt: '2026-07-23T09:00:00.000Z',
      }),
      card({
        id: uuid(), title: 'Multi-select & bulk drag', binderId: todo, order: 0, x: 80, y: 80,
        description: 'Shift-click to grab several cards, then drag them between binders as one stack.',
        createdAt: '2026-07-23T10:00:00.000Z', updatedAt: '2026-07-23T10:00:00.000Z',
      }),
      card({
        id: uuid(), title: 'Command palette (⌘K)', binderId: todo, order: 1, x: 80, y: 80,
        description: 'Fuzzy-jump to any card or board and run actions without touching the mouse.',
        createdAt: '2026-07-23T10:05:00.000Z', updatedAt: '2026-07-23T10:05:00.000Z',
      }),
      card({
        id: uuid(), title: 'Browser-only demo on GitHub Pages', binderId: inprog, order: 0, x: 80, y: 80,
        description: 'Swap the Express backend for an **IndexedDB** one behind the same `api()` call, so the entire app runs client-side — no server needed.',
        attachments: [
          img('seed-board', '2026-07-23T11:00:00.000Z', 0),
          link('https://mitchellaidant.github.io/driftboard/', 'Live demo', '2026-07-23T11:01:00.000Z', 1),
        ],
        createdAt: '2026-07-23T11:00:00.000Z', updatedAt: '2026-07-23T11:10:00.000Z',
      }),
      card({
        id: uuid(), title: 'Attachment reordering with a drop-ghost', binderId: reviewing, order: 0, x: 80, y: 80,
        attSort: 'custom',
        description: 'Drag an attachment by its grip: a lifted ghost follows the cursor and an **orange placeholder** shows where it will land, while the other items slide out of the way.',
        attachments: [
          img('seed-reorder', '2026-07-22T15:00:00.000Z', 0),
          img('seed-attachments', '2026-07-22T15:01:00.000Z', 1),
          txt('Newest-first and custom order drop new attachments at the top; oldest-first drops them at the bottom.', '2026-07-22T15:02:00.000Z', 2),
        ],
        createdAt: '2026-07-22T15:00:00.000Z', updatedAt: '2026-07-22T15:05:00.000Z',
      }),
      card({
        id: uuid(), title: 'Real-time sync across devices', binderId: blocked, order: 0, x: 80, y: 80,
        description: 'Live multi-device sync. Blocked on choosing a strategy (CRDT vs. last-write-wins) and an auth story.',
        createdAt: '2026-07-21T12:00:00.000Z', updatedAt: '2026-07-21T12:00:00.000Z',
      }),
      card({
        id: uuid(), title: 'Card & binder drag animations', binderId: completed, order: 0, x: 80, y: 80,
        description: 'Pick-up swing driven by horizontal velocity, pop-in on create, a drop-in settle, and a little binder wobble.',
        attachments: [
          img('seed-animations', '2026-07-20T14:00:00.000Z', 0),
          txt('The swing eases back upright with a small requestAnimationFrame spring.', '2026-07-20T14:02:00.000Z', 1),
        ],
        createdAt: '2026-07-20T14:00:00.000Z', updatedAt: '2026-07-20T14:05:00.000Z',
      }),
      card({
        id: uuid(), title: 'Dark mode', binderId: completed, order: 1, x: 80, y: 80,
        description: 'Full light / dark theming via CSS custom properties on `[data-theme]`, remembered per browser.',
        attachments: [txt('Toggle it with the ☾ / ☀ button at the top-right.', '2026-07-19T16:00:00.000Z', 0)],
        createdAt: '2026-07-19T16:00:00.000Z', updatedAt: '2026-07-19T16:00:00.000Z',
      }),
      card({
        id: uuid(), title: 'Rework palette to the Mujin brand', binderId: completed, order: 2, x: 80, y: 80,
        description: 'Adopt the brand colors as CSS variables so every surface stays consistent.',
        attachments: [txt('**Palette**\n\n- Orange `#e76125`\n- Gray `#646d72`\n- Red `#d21419`\n- Light `#ececec`', '2026-07-18T13:00:00.000Z', 0)],
        createdAt: '2026-07-18T13:00:00.000Z', updatedAt: '2026-07-18T13:00:00.000Z',
      }),
    ];

    const ws = { id: uuid(), name: 'Driftboard', view: { panX: 0, panY: 0, zoom: 1 }, binders, cards };
    return { version: 2, demoSeeded: SEED_VERSION, activeWorkspaceId: ws.id, workspaces: [ws], trash: [] };
  }

  // A board saved before seeding existed (or an old seed): a single workspace with
  // no cards and no demoSeeded marker. Safe to (re)seed over — it holds nothing.
  function isReseedable(s) {
    return !!s
      && s.demoSeeded !== SEED_VERSION
      && Array.isArray(s.workspaces) && s.workspaces.length === 1
      && (s.workspaces[0].cards || []).length === 0;
  }

  // Fetch the seed images into the blob store, then build + persist the board.
  // Falls back gracefully (dropping any image that fails to load, or the whole
  // seed) so the demo always comes up.
  async function seed() {
    const sizes = {};
    const loaded = new Set();
    for (const image of SEED_IMAGES) {
      try {
        const res = await fetch(image.src, { cache: 'force-cache' });
        if (!res.ok) throw new Error('fetch failed');
        const blob = await res.blob();
        await putBlob(image.key, blob);
        sizes[image.key] = blob.size;
        loaded.add(image.key);
      } catch { /* image missing — its attachment is dropped below */ }
    }
    try {
      state = buildSeedState(sizes);
      for (const ws of state.workspaces) for (const c of ws.cards) {
        c.attachments = (c.attachments || []).filter((a) => a.type !== 'image' || loaded.has(a.filename));
        c.attachments.forEach((a, i) => { a.order = i; });
      }
    } catch {
      state = defaultState();
    }
    await persist();
  }

  // --- Lookup helpers (mirror server.js) -------------------------------------
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
    ws.cards.filter((c) => c.binderId === binderId).sort((a, b) => a.order - b.order).forEach((c, i) => { c.order = i; });
  }
  function uniqueWorkspaceName(base) {
    const names = new Set(state.workspaces.map((w) => w.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }
  function attachmentType(mimeType) {
    if (mimeType?.startsWith('image/')) return 'image';
    if (mimeType?.startsWith('video/')) return 'video';
    return 'file';
  }
  // Soft-delete: overflow purges the oldest entry's files for real.
  function pushTrash(entry) {
    state.trash.push(entry);
    while (state.trash.length > TRASH_CAP) {
      const old = state.trash.shift();
      if (old.type === 'card') (old.card.attachments || []).filter((a) => a.filename).forEach((a) => deleteBlob(a.filename));
    }
  }

  // --- IndexedDB plumbing ----------------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('blobs')) database.createObjectStore('blobs', { keyPath: 'filename' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const idbReq = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const txDone = (t) => new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });

  async function persist() { // mirror of server's persist(): rewrite the whole board
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put({ key: 'state', value: state });
    await txDone(t);
  }
  async function putBlob(filename, blob) {
    const t = db.transaction('blobs', 'readwrite');
    t.objectStore('blobs').put({ filename, blob });
    await txDone(t);
    urlByFilename.set(filename, URL.createObjectURL(blob));
  }
  async function deleteBlob(filename) {
    try { const t = db.transaction('blobs', 'readwrite'); t.objectStore('blobs').delete(filename); await txDone(t); } catch { /* best effort */ }
    const url = urlByFilename.get(filename);
    if (url) { URL.revokeObjectURL(url); urlByFilename.delete(filename); }
  }

  function ready() { if (!initPromise) initPromise = init(); return initPromise; }
  async function init() {
    db = await openDb();
    const rec = await idbReq(db.transaction('kv', 'readonly').objectStore('kv').get('state'));
    if (rec && !isReseedable(rec.value)) {
      state = rec.value;
      if (!Array.isArray(state.trash)) state.trash = [];
      const blobs = await idbReq(db.transaction('blobs', 'readonly').objectStore('blobs').getAll());
      for (const b of blobs) urlByFilename.set(b.filename, URL.createObjectURL(b.blob));
    } else {
      await seed(); // fresh store, or a left-over empty board from before seeding existed
    }
  }

  // --- Route dispatch (mirrors server.js endpoints) --------------------------
  async function dispatch(method, url, body, isForm) {
    const seg = url.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean); // ['api','cards','ID','move']
    const j = (!isForm && body) ? body : {};

    // ---- Workspaces ----
    if (seg[0] === 'api' && seg[1] === 'state' && seg.length === 2) {
      if (method === 'GET') return { activeWorkspaceId: state.activeWorkspaceId, workspaces: state.workspaces.map((w) => ({ id: w.id, name: w.name })) };
      if (method === 'PATCH') { if (getWorkspace(j.activeWorkspaceId)) state.activeWorkspaceId = j.activeWorkspaceId; await persist(); return { ok: true }; }
    }
    if (seg[0] === 'api' && seg[1] === 'workspaces' && seg.length === 2 && method === 'POST') {
      const name = (j.name || '').trim() || uniqueWorkspaceName('New board');
      const ws = { id: uuid(), name, view: { panX: 0, panY: 0, zoom: 1 }, binders: [], cards: [] };
      state.workspaces.push(ws); state.activeWorkspaceId = ws.id; await persist(); return ws;
    }
    if (seg[0] === 'api' && seg[1] === 'workspaces' && seg.length === 3) {
      const ws = getWorkspace(seg[2]);
      if (method === 'GET') { if (!ws) throw err('workspace not found'); return ws; }
      if (method === 'PATCH') {
        if (!ws) throw err('workspace not found');
        if (typeof j.name === 'string' && j.name.trim()) ws.name = j.name.trim();
        if (j.view && typeof j.view === 'object') {
          ws.view = { panX: Number(j.view.panX) || 0, panY: Number(j.view.panY) || 0, zoom: Math.min(2.5, Math.max(0.25, Number(j.view.zoom) || 1)) };
        }
        await persist(); return { id: ws.id, name: ws.name, view: ws.view };
      }
      if (method === 'DELETE') {
        const index = state.workspaces.findIndex((w) => w.id === seg[2]);
        if (index === -1) throw err('workspace not found');
        if (state.workspaces.length === 1) throw err('cannot delete the last workspace');
        const [removed] = state.workspaces.splice(index, 1);
        if (state.activeWorkspaceId === removed.id) state.activeWorkspaceId = state.workspaces[0].id;
        await persist();
        for (const c of removed.cards) for (const a of (c.attachments || [])) if (a.filename) await deleteBlob(a.filename);
        return { ok: true, activeWorkspaceId: state.activeWorkspaceId };
      }
    }
    // ---- Binders ----
    if (seg[0] === 'api' && seg[1] === 'workspaces' && seg[3] === 'binders' && seg.length === 4 && method === 'POST') {
      const ws = getWorkspace(seg[2]); if (!ws) throw err('workspace not found');
      const binder = { id: uuid(), title: (j.title || 'New binder').trim() || 'New binder', x: Number(j.x) || 48, y: Number(j.y) || 48 };
      ws.binders.push(binder); await persist(); return binder;
    }
    if (seg[0] === 'api' && seg[1] === 'binders' && seg.length === 3) {
      const found = getBinder(seg[2]); if (!found) throw err('binder not found');
      const { ws, binder } = found;
      if (method === 'PATCH') {
        if (typeof j.title === 'string' && j.title.trim()) binder.title = j.title.trim();
        if (j.x !== undefined) binder.x = Number(j.x);
        if (j.y !== undefined) binder.y = Number(j.y);
        if (typeof j.color === 'string') binder.color = j.color;
        if (typeof j.description === 'string') binder.description = j.description;
        await persist(); return binder;
      }
      if (method === 'DELETE') {
        const members = ws.cards.filter((c) => c.binderId === binder.id).sort((a, b) => a.order - b.order).map((c) => ({ id: c.id, order: c.order }));
        ws.cards.filter((c) => c.binderId === binder.id).forEach((c, i) => { c.binderId = null; c.x = binder.x + 16 + (i % 3) * 24; c.y = binder.y + 64 + i * 28; });
        ws.binders = ws.binders.filter((b) => b.id !== binder.id);
        pushTrash({ type: 'binder', workspaceId: ws.id, binder, members });
        await persist(); return { ok: true };
      }
    }
    // ---- Cards ----
    if (seg[0] === 'api' && seg[1] === 'workspaces' && seg[3] === 'cards' && seg.length === 4 && method === 'POST') {
      const ws = getWorkspace(seg[2]); if (!ws) throw err('workspace not found');
      const title = (j.title || '').trim(); if (!title) throw err('title is required');
      const binderId = ws.binders.some((b) => b.id === j.binderId) ? j.binderId : null;
      const card = {
        id: uuid(), title, description: '', attachments: [], binderId,
        order: binderId ? ws.cards.filter((c) => c.binderId === binderId).length : 0,
        x: Number(j.x) || 80, y: Number(j.y) || 80, createdAt: now(), updatedAt: now(),
      };
      ws.cards.push(card); await persist(); return card;
    }
    if (seg[0] === 'api' && seg[1] === 'cards' && seg.length === 3) {
      const found = getCard(seg[2]); if (!found) throw err('card not found');
      const { card } = found;
      if (method === 'GET') return { workspaceId: found.ws.id, card };
      if (method === 'PATCH') {
        if (typeof j.title === 'string') card.title = j.title;
        if (typeof j.description === 'string') card.description = j.description;
        if (typeof j.attSort === 'string' && ['newest', 'oldest', 'custom'].includes(j.attSort)) card.attSort = j.attSort;
        card.updatedAt = now(); await persist(); return card;
      }
      if (method === 'DELETE') {
        const { ws } = found;
        ws.cards = ws.cards.filter((c) => c.id !== card.id);
        if (card.binderId) reindexBinder(ws, card.binderId);
        pushTrash({ type: 'card', workspaceId: ws.id, card });
        await persist(); return { ok: true };
      }
    }
    if (seg[0] === 'api' && seg[1] === 'cards' && seg[3] === 'move' && seg.length === 4 && method === 'POST') {
      const found = getCard(seg[2]); if (!found) throw err('card not found');
      const { ws, card } = found;
      const fromBinderId = card.binderId;
      const targetBinder = ws.binders.find((b) => b.id === j.binderId);
      if (targetBinder) {
        const column = ws.cards.filter((c) => c.binderId === targetBinder.id && c.id !== card.id).sort((a, b) => a.order - b.order);
        let index = Number.isInteger(j.toIndex) ? j.toIndex : column.length;
        index = Math.max(0, Math.min(index, column.length));
        column.splice(index, 0, card); card.binderId = targetBinder.id; column.forEach((c, i) => { c.order = i; });
      } else {
        card.binderId = null;
        if (j.x !== undefined) card.x = Number(j.x);
        if (j.y !== undefined) card.y = Number(j.y);
      }
      if (fromBinderId && fromBinderId !== card.binderId) reindexBinder(ws, fromBinderId);
      card.updatedAt = now(); await persist(); return { ok: true };
    }
    // ---- Undo ----
    if (seg[0] === 'api' && seg[1] === 'undo' && seg.length === 2 && method === 'POST') {
      const entry = state.trash.pop();
      if (!entry) return { ok: false, empty: true };
      const ws = getWorkspace(entry.workspaceId);
      if (!ws) { await persist(); return { ok: false }; }
      if (entry.type === 'card') {
        const card = entry.card;
        if (card.binderId && !ws.binders.some((b) => b.id === card.binderId)) card.binderId = null;
        ws.cards.push(card);
        if (card.binderId) reindexBinder(ws, card.binderId);
        await persist(); return { ok: true, kind: 'card', workspaceId: ws.id };
      }
      ws.binders.push(entry.binder);
      entry.members.forEach((m) => { const c = ws.cards.find((cc) => cc.id === m.id); if (c) { c.binderId = entry.binder.id; c.order = m.order; } });
      reindexBinder(ws, entry.binder.id);
      await persist(); return { ok: true, kind: 'binder', workspaceId: ws.id };
    }
    // ---- Attachments ----
    if (seg[0] === 'api' && seg[1] === 'cards' && seg[3] === 'attachments' && seg.length === 4 && method === 'POST') {
      const found = getCard(seg[2]); if (!found) throw err('card not found');
      const { card } = found;
      let attachment;
      const file = isForm ? body.get('file') : null;
      if (file) {
        const filename = `${uuid()}${safeExtension(file.name)}`;
        await putBlob(filename, file);
        attachment = { id: uuid(), type: attachmentType(file.type), filename, originalName: file.name, mimeType: file.type, size: file.size, createdAt: now() };
      } else if (j.type === 'text') {
        attachment = { id: uuid(), type: 'text', content: j.content || '', createdAt: now() };
      } else if (j.type === 'url') {
        if (!String(j.url ?? '').trim()) throw err('url is required');
        const url2 = webURL(j.url); if (!url2) throw err('only http and https links can be attached');
        attachment = { id: uuid(), type: 'url', url: url2, title: (j.title || '').trim(), createdAt: now() };
      } else {
        throw err('unsupported attachment');
      }
      attachment.order = card.attachments.length;
      card.attachments.push(attachment); card.updatedAt = now(); await persist(); return attachment;
    }
    if (seg[0] === 'api' && seg[1] === 'cards' && seg[3] === 'attachments' && seg[4] === 'reorder' && seg.length === 5 && method === 'POST') {
      const found = getCard(seg[2]); if (!found) throw err('card not found');
      const { card } = found;
      const ids = Array.isArray(j.orderedIds) ? j.orderedIds : [];
      ids.forEach((id, i) => { const a = card.attachments.find((x) => x.id === id); if (a) a.order = i; });
      card.attSort = 'custom'; card.updatedAt = now(); await persist(); return { ok: true };
    }
    if (seg[0] === 'api' && seg[1] === 'cards' && seg[3] === 'attachments' && seg.length === 5) {
      const found = getCard(seg[2]); if (!found) throw err('card not found');
      const att = (found.card.attachments || []).find((a) => a.id === seg[4]);
      if (!att) throw err('attachment not found');
      if (method === 'PATCH') {
        const url2 = att.type === 'url' && typeof j.url === 'string' && j.url.trim() ? webURL(j.url) : undefined;
        if (url2 === null) throw err('only http and https links can be attached');
        if (att.type === 'text' && typeof j.content === 'string') att.content = j.content;
        if (url2) att.url = url2;
        if (typeof j.title === 'string') att.title = j.title;
        found.card.updatedAt = now(); await persist(); return att;
      }
      if (method === 'DELETE') {
        const { card } = found;
        const index = card.attachments.findIndex((a) => a.id === seg[4]);
        const [removed] = card.attachments.splice(index, 1);
        card.updatedAt = now(); await persist();
        if (removed.filename) await deleteBlob(removed.filename);
        return { ok: true };
      }
    }

    throw err(`demo: unhandled ${method} ${url}`);
  }

  async function handle(method, url, body, isForm) {
    await ready();
    const result = await dispatch(method.toUpperCase(), url, body, isForm);
    return clone(result); // hand back copies, exactly like the JSON-over-HTTP server would
  }

  function fileUrl(filename) { return urlByFilename.get(filename) || ''; }

  async function reset() {
    await ready();
    for (const url of urlByFilename.values()) URL.revokeObjectURL(url);
    urlByFilename.clear();
    const t = db.transaction(['kv', 'blobs'], 'readwrite');
    t.objectStore('kv').clear();
    t.objectStore('blobs').clear();
    await txDone(t);
    await seed(); // restore the preloaded demo board, not an empty one
  }

  window.DriftboardDemo = { handle, fileUrl, reset };
})();
