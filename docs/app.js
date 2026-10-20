/* global marked, DOMPurify */

// ---------- icons ----------
const ICON = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4" stroke-linecap="round"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  grip: '<svg viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>',
};
const BINDER_COLORS = ['#646d72', '#e76125', '#d21419', '#b8860b', '#2e8b57', '#3b7dd8', '#8e44ad'];
const GRID = 26;

// ---------- state ----------
let wsList = [];
let activeWorkspaceId = null;
let ws = null;
let panX = 0, panY = 0, zoom = 1;
let currentCardId = null;
let descEditing = false;
let pendingPopId = null;
let droppedId = null;
let theme = localStorage.getItem('tt-theme') || 'light';
let snapEnabled = localStorage.getItem('tt-snap') !== 'off';
const editingAtts = new Set();

// Demo mode (see config.js): all persistence runs in the browser via demo-api.js
// instead of the Express backend. Off by default → the real server app is unchanged.
const DEMO = !!window.DRIFTBOARD_DEMO;

const $ = (id) => document.getElementById(id);
const snap = (v) => (snapEnabled ? Math.round(v / GRID) * GRID : v);

// ---------- save indicator ----------
let pendingWrites = 0, saveStart = 0, savedTimer = null;
function beginSave() {
  if (pendingWrites === 0) saveStart = performance.now();
  pendingWrites++;
  clearTimeout(savedTimer);
  const el = document.getElementById('save-status');
  el.classList.add('saving');
  el.querySelector('.save-text').textContent = 'Saving…';
}
function endSave() {
  pendingWrites = Math.max(0, pendingWrites - 1);
  if (pendingWrites > 0) return;
  const el = document.getElementById('save-status');
  const wait = Math.max(0, 350 - (performance.now() - saveStart)); // keep "Saving…" visible briefly
  savedTimer = setTimeout(() => {
    if (pendingWrites !== 0) return;
    el.classList.remove('saving');
    el.querySelector('.save-text').textContent = 'Saved';
  }, wait);
}

// ---------- sign-in ----------
// The board's data needs its token; the page itself is public. `npm run open` opens the board
// with a one-time code (#code=, or ?code=), which is swapped for the token here. The token is kept in this
// page's memory only and goes with every API call as a bearer token. Not in the browser's
// storage: while the board is down, another user of this machine can serve a page of their own
// at its address, and that page could read the storage. So a reload needs a new sign-in.
let token = null;
try { localStorage.removeItem('driftboard-token'); } catch { /* where the previous version kept it */ }
let uploadsKey = '';
let locked = false;
let away = false;

// The code comes in the fragment (#code=…, also #code=…&card=…), which no request carries, or
// in the query (?code=…). It goes out of the address bar, and so out of a bookmark; #card= stays.
function takeSignInCode() {
  const address = new URL(location.href);
  const fragment = new URLSearchParams(address.hash.slice(1));
  const code = fragment.get('code') || address.searchParams.get('code');
  if (!code) return null;
  fragment.delete('code');
  address.searchParams.delete('code');
  const hash = fragment.toString();
  history.replaceState(history.state, '', address.pathname + address.search + (hash ? `#${hash}` : ''));
  return code;
}
async function signInWithCode(code) {
  if (DEMO || !code) return;
  const res = await fetch('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  }).catch(() => null);
  if (!res || !res.ok) {
    toast(res ? 'That sign-in link has expired or was used already: run `npm run open` again' : 'Could not reach the board to sign in');
    return;
  }
  const body = await res.json().catch(() => null);
  token = typeof body?.token === 'string' ? body.token : null;
}
function showLocked() {
  locked = true;
  $('locked').classList.remove('hidden');
}

// While the board is down, any user of this machine can listen on its port, and a call from
// this page would hand them the token. So no call carries it before the server has proved it
// holds the token: asked with a fresh nonce, it answers HMAC-SHA256(token, "driftboard-hello:" +
// nonce), which only a holder of the token can make and which says nothing about it. A browser
// cannot keep a call on the connection that proof came over, so the proof comes right before
// each call; calls made while one is on its way share it.
let proving = null;
function proveServer() {
  if (!proving) proving = askForProof().finally(() => { proving = null; });
  return proving;
}
async function askForProof() {
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const expected = window.DriftboardHMAC(token, `driftboard-hello:${nonce}`);
  let proof = null;
  try {
    const res = await fetch(`/api/hello?nonce=${nonce}`, { cache: 'no-store' });
    if (res.ok) proof = (await res.json()).proof;
  } catch { /* not reached, or not the board's answer */ }
  if (proof !== expected) {
    throw Object.assign(new Error('the server at this address could not prove it is this board, so it was not sent anything'), { status: 0 });
  }
}

// The board went away: it stopped, or a call met an error, an answer that is not the board's, or
// a 401. Until a server proves itself again, nothing goes out with the token and the board is not
// checked for changes; the proof is asked for every few seconds.
const AWAY_RETRY = 3000;
let awayTimer = null;
const awayError = () => Object.assign(new Error('the board went away: nothing is sent until it is back'), { status: 0, away: true });
function goAway() {
  if (away) return;
  away = true;
  $('away').classList.remove('hidden');
  awayTimer = setInterval(comeBack, AWAY_RETRY);
}
async function comeBack() {
  try { await proveServer(); } catch { return; }
  if (!away) return;
  away = false;
  clearInterval(awayTimer);
  $('away').classList.add('hidden');
  if (!ws) { start(); return; } // it went away before the board was first drawn
  changedElsewhere = true; // whatever changed meanwhile
  checkForChanges().catch(() => {});
  openLinkedCard();
}

// ---------- api ----------
// The reply, and the board revision it was sent at (none in the demo).
async function request(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (isForm) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const isWrite = method !== 'GET';
  if (isWrite) beginSave();
  try {
    if (DEMO) return { data: await window.DriftboardDemo.handle(method, url, body, isForm), revision: null }; // browser backend, same shapes
    if (!token) { showLocked(); throw Object.assign(new Error('this board is locked: open it with `npm run open`'), { status: 401 }); }
    if (away) throw awayError();
    try { await proveServer(); } catch { goAway(); throw awayError(); }
    opts.headers.Authorization = `Bearer ${token}`;
    let res;
    try { res = await fetch(url, opts); } catch { goAway(); throw awayError(); }
    if (res.status === 401) { goAway(); throw awayError(); }
    const answer = res.status === 204 ? null : await res.json().catch(() => undefined);
    if (answer === undefined) { goAway(); throw awayError(); } // not the board's answer
    if (isWrite) noteWrite(res);
    if (!res.ok) throw Object.assign(new Error(answer?.error || 'request failed'), { status: res.status });
    return { data: answer, revision: Number(res.headers.get('X-Board-Revision')) || null };
  } finally {
    if (isWrite) endSave();
  }
}
async function api(method, url, body, isForm) {
  return (await request(method, url, body, isForm)).data;
}

// ---------- utils ----------
const currentCard = () => ws && ws.cards.find((c) => c.id === currentCardId);
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function toastAction(msg, label, fn) {
  const el = document.createElement('div');
  el.className = 'toast';
  const s = document.createElement('span'); s.textContent = msg; el.appendChild(s);
  const b = document.createElement('button'); b.textContent = label;
  b.addEventListener('click', () => { el.remove(); fn(); }); el.appendChild(b);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
// Every value that goes into HTML, as text or in an attribute, goes through this first.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Only web links are followed: a javascript: or data: one would run on the board when clicked.
function webURL(value) {
  const text = String(value ?? '').trim();
  try { return ['http:', 'https:'].includes(new URL(text).protocol) ? text : null; }
  catch { return null; }
}
function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function shortDate(iso) {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
// A link in a note opens in a new tab: followed in this one, it would take the sign-in with it.
// A link within the board (#card=…) stays.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href') && !node.getAttribute('href').startsWith('#')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
function renderMarkdown(text) { return DOMPurify.sanitize(marked.parse(text || '', { breaks: true })); }
function stripMd(s) {
  return String(s || '')
    .replace(/!\[.*?\]\(.*?\)/g, '')            // images
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')          // links -> text
    .replace(/[#>*_`~-]+/g, ' ')                 // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim();
}
const fileUrl = (a) => (DEMO ? window.DriftboardDemo.fileUrl(a.filename) : `/uploads/${encodeURIComponent(a.filename)}?k=${uploadsKey}`);
const looksLikeImage = (u) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i.test(u);
const looksLikeVideo = (u) => /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(u);
const clampZoom = (z) => Math.min(2.5, Math.max(0.25, z));

// ---------- theme / snap ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('tt-theme', t);
  $('theme-toggle').innerHTML = t === 'dark' ? ICON.sun : ICON.moon;
}
$('theme-toggle').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); });
applyTheme(theme);

function updateSnapBtn() { $('snap-toggle').classList.toggle('active', snapEnabled); }
$('snap-toggle').addEventListener('click', () => {
  snapEnabled = !snapEnabled;
  localStorage.setItem('tt-snap', snapEnabled ? 'on' : 'off');
  updateSnapBtn();
});
updateSnapBtn();

// ---------- canvas transform ----------
const viewport = $('viewport');
const world = $('world');

function updateTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  viewport.style.backgroundPosition = `${panX}px ${panY}px`;
  viewport.style.backgroundSize = `${GRID * zoom}px ${GRID * zoom}px`;
  $('zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
}
function screenToWorld(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
}
function viewCenterWorld() {
  const r = viewport.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}
function zoomAt(clientX, clientY, newZoom) {
  const r = viewport.getBoundingClientRect();
  const before = screenToWorld(clientX, clientY);
  zoom = clampZoom(newZoom);
  panX = (clientX - r.left) - before.x * zoom;
  panY = (clientY - r.top) - before.y * zoom;
  updateTransform(); saveView();
}
let viewTimer;
function saveView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { if (ws) api('PATCH', `/api/workspaces/${ws.id}`, { view: { panX, panY, zoom } }).catch(() => {}); }, 400);
}

// ---------- load / render ----------
async function loadState() {
  if (!DEMO) uploadsKey = (await api('GET', '/api/session')).uploadsKey;
  const s = await api('GET', '/api/state');
  wsList = s.workspaces; activeWorkspaceId = s.activeWorkspaceId;
  renderTabs();
  await loadWorkspace(activeWorkspaceId);
}
async function loadWorkspace(id) {
  showWorkspace(await api('GET', `/api/workspaces/${id}`));
}
function showWorkspace(fresh) {
  ws = fresh; activeWorkspaceId = fresh.id;
  panX = ws.view?.panX || 0; panY = ws.view?.panY || 0; zoom = clampZoom(ws.view?.zoom || 1);
  updateTransform(); renderWorkspace(); renderTabs();
}
async function reloadWorkspace() {
  const fresh = await api('GET', `/api/workspaces/${activeWorkspaceId}`);
  if (gesturing()) { changedElsewhere = true; return; } // a drag began meanwhile: the next check draws this
  ws = fresh;
  renderWorkspace();
}

function renderTabs() {
  const nav = $('workspaces');
  nav.innerHTML = '';
  wsList.forEach((w) => {
    const tab = document.createElement('div');
    tab.className = 'ws-tab' + (w.id === activeWorkspaceId ? ' active' : '');
    tab.setAttribute('role', 'button');
    const name = document.createElement('span'); name.className = 'ws-name'; name.textContent = w.name;
    tab.appendChild(name);
    if (w.id === activeWorkspaceId) {
      const dot = document.createElement('span'); dot.className = 'ws-menu-dot'; dot.textContent = '⋯';
      dot.addEventListener('click', (e) => { e.stopPropagation(); openWorkspaceMenu(e, w); });
      tab.appendChild(dot);
    }
    tab.addEventListener('click', () => { if (w.id !== activeWorkspaceId) switchWorkspace(w.id); });
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); startTabRename(w, name); });
    nav.appendChild(tab);
  });
}

function startTabRename(w, nameSpan) {
  const input = document.createElement('input');
  input.className = 'ws-name-edit'; input.value = w.name;
  nameSpan.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    if (save) {
      const name = input.value.trim();
      if (name && name !== w.name) {
        try { await api('PATCH', `/api/workspaces/${w.id}`, { name }); w.name = name; const s = await api('GET', '/api/state'); wsList = s.workspaces; }
        catch (e) { toast(e.message); }
      }
    }
    renderTabs();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') commit(false);
  });
}

function renderWorkspace() {
  world.innerHTML = '';
  const origin = document.createElement('div');
  origin.className = 'origin-marker';
  origin.innerHTML = '<div class="cross"></div><div class="origin-label">0, 0</div>';
  world.appendChild(origin);
  ws.binders.forEach((b, i) => world.appendChild(makeBinderEl(b, i)));
  ws.cards.filter((c) => !c.binderId).forEach((c) => world.appendChild(makeCardEl(c, true)));
  pendingPopId = null;
  droppedId = null;
}

function cardBadges(card) {
  const atts = card.attachments || [];
  const badges = atts.length ? `<div class="card-badges"><span class="badge">${ICON.clip} ${atts.length}</span></div>` : '';
  const thumbs = atts.filter((a) => a.type === 'image').slice(0, 4).map((a) => `<img src="${escapeHtml(fileUrl(a))}" alt="">`).join('');
  return `${badges}${thumbs ? `<div class="card-thumbs">${thumbs}</div>` : ''}`;
}

function makeCardEl(card, free) {
  const el = document.createElement('div');
  el.className = 'card' + (free ? ' free' : '') + (card.id === pendingPopId ? ' pop-in' : '') + (card.id === droppedId ? ' drop-in' : '');
  el.dataset.id = card.id;
  if (free) { el.style.left = card.x + 'px'; el.style.top = card.y + 'px'; }
  else if (card.binderId) { // accent stripe matches the binder's colour (set inline so the drag ghost keeps it)
    const binder = ws.binders.find((b) => b.id === card.binderId);
    if (binder) el.style.setProperty('--binder-color', binderColor(binder, ws.binders.indexOf(binder)));
  }
  el.innerHTML = `<div class="card-accent"></div><div class="card-title-txt"></div><div class="card-desc"></div>${cardBadges(card)}`;
  el.querySelector('.card-title-txt').textContent = card.title;
  const descEl = el.querySelector('.card-desc');
  const preview = stripMd(card.description);
  if (preview) descEl.textContent = preview; else descEl.remove();

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const del = document.createElement('button'); // clicking the card opens it, so only a delete affordance is needed
  del.className = 'icon-btn danger card-act'; del.innerHTML = ICON.trash; del.title = 'Delete card';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    const title = card.title;
    el.classList.add('removing');
    await new Promise((r) => setTimeout(r, 180));
    try { await api('DELETE', `/api/cards/${card.id}`); await reloadWorkspace(); toastAction(`Deleted “${title}”`, 'Undo', undo); }
    catch (err) { el.classList.remove('removing'); toast(err.message); }
  });
  actions.append(del);
  el.appendChild(actions);
  return el;
}

const binderColor = (binder, index) => binder.color || BINDER_COLORS[index % BINDER_COLORS.length];

function makeBinderEl(binder, index) {
  const el = document.createElement('div');
  el.className = 'binder' + (binder.id === pendingPopId ? ' pop-in' : '');
  el.dataset.id = binder.id;
  el.style.left = binder.x + 'px'; el.style.top = binder.y + 'px';
  el.style.setProperty('--binder-color', binderColor(binder, index));
  const cards = ws.cards.filter((c) => c.binderId === binder.id).sort((a, b) => a.order - b.order);
  el.innerHTML = `
    <div class="binder-head">
      <span class="binder-title" title="Double-click to edit"></span>
      <span class="binder-actions">
        <button class="icon-btn edit-binder" title="Edit binder">${ICON.pencil}</button>
        <button class="icon-btn danger delete-binder" title="Delete binder">${ICON.trash}</button>
      </span>
      <span class="binder-count">${cards.length}</span>
    </div>
    ${binder.description ? '<div class="binder-desc"></div>' : ''}
    <div class="binder-cards ${cards.length ? '' : 'empty'}"></div>
    <button class="binder-add">+ Add a card</button>`;
  el.querySelector('.binder-title').textContent = binder.title;
  if (binder.description) el.querySelector('.binder-desc').textContent = binder.description;
  const cardsEl = el.querySelector('.binder-cards');
  cards.forEach((c) => cardsEl.appendChild(makeCardEl(c, false)));

  el.querySelector('.binder-title').addEventListener('dblclick', (e) => { e.stopPropagation(); openBinderEditor(binder.id); });
  el.querySelector('.edit-binder').addEventListener('click', (e) => { e.stopPropagation(); openBinderEditor(binder.id); });

  el.querySelector('.delete-binder').addEventListener('click', async () => {
    const title = binder.title;
    el.classList.add('removing');
    await new Promise((r) => setTimeout(r, 150));
    try { await api('DELETE', `/api/binders/${binder.id}`); await reloadWorkspace(); toastAction(`Deleted binder “${title}”`, 'Undo', undo); }
    catch (e) { el.classList.remove('removing'); toast(e.message); }
  });

  wireBinderAdd(el, binder);
  return el;
}

function wireBinderAdd(binderEl, binder) {
  const addBtn = binderEl.querySelector('.binder-add');
  addBtn.addEventListener('click', () => {
    const composer = document.createElement('div');
    composer.className = 'composer';
    composer.innerHTML = `<textarea rows="2" placeholder="Card title…"></textarea>
      <div class="row"><button class="btn-primary">Add</button><button class="btn">Cancel</button></div>`;
    addBtn.replaceWith(composer);
    const ta = composer.querySelector('textarea'); ta.focus();
    let settled = false;
    const cleanup = () => document.removeEventListener('pointerdown', onOutside, true);
    const cancel = () => { if (settled) return; settled = true; cleanup(); composer.replaceWith(addBtn); };
    const save = async () => {
      if (settled) return;
      const title = ta.value.trim();
      if (!title) return cancel();
      settled = true; cleanup();
      try { const c = await api('POST', `/api/workspaces/${ws.id}/cards`, { title, binderId: binder.id }); pendingPopId = c.id; await reloadWorkspace(); }
      catch (e) { settled = false; document.addEventListener('pointerdown', onOutside, true); toast(e.message); }
    };
    const commitAway = () => { if (ta.value.trim()) save(); else cancel(); }; // text → card, empty → discard
    // The canvas preventDefaults pointerdown (pan/drag), so blur alone can't catch a
    // click-away — watch for any pointerdown outside the composer instead.
    function onOutside(ev) { if (!composer.contains(ev.target)) commitAway(); }
    document.addEventListener('pointerdown', onOutside, true);
    // Buttons act on mousedown so they win the race against the textarea's blur.
    composer.querySelector('.btn-primary').addEventListener('mousedown', (e) => { e.preventDefault(); save(); });
    composer.querySelector('.btn').addEventListener('mousedown', (e) => { e.preventDefault(); cancel(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
    ta.addEventListener('blur', commitAway); // covers Ctrl+Enter / Escape (programmatic blur) and tab-away
  });
}

// ---------- drag system ----------
let insertLineEl = null;
let lastDropBinder = null;
function clearInsert() {
  if (insertLineEl) { insertLineEl.remove(); insertLineEl = null; }
  if (lastDropBinder) { lastDropBinder.classList.remove('drop-target'); lastDropBinder = null; }
}
function binderElAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const b = el.closest && el.closest('.binder');
    if (b && world.contains(b)) return b;
  }
  return null;
}
function insertionIndex(binderEl, y, draggingId) {
  const items = [...binderEl.querySelectorAll('.binder-cards > .card')].filter((c) => c.dataset.id !== draggingId);
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return items.length;
}
function showInsert(binderEl, index, draggingId) {
  const cardsEl = binderEl.querySelector('.binder-cards');
  const items = [...cardsEl.children].filter((c) => c.classList.contains('card') && c.dataset.id !== draggingId);
  if (items.length === 0) return; // empty binder: the orange "Drop cards here" area marks the target
  const box = document.createElement('div'); box.className = 'insert-box'; insertLineEl = box;
  if (index >= items.length) cardsEl.appendChild(box); else cardsEl.insertBefore(box, items[index]);
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const interactive = e.target.closest('input, textarea, button, a, .composer');
  const cardEl = e.target.closest('.card');
  const headEl = e.target.closest('.binder-head');
  if (cardEl && !interactive) startCardDrag(e, cardEl);
  else if (headEl && !interactive) startBinderDrag(e, headEl.closest('.binder'));
  else if (!e.target.closest('.binder') && !cardEl) startPan(e);
});

function startPan(e) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, px = panX, py = panY;
  viewport.classList.add('panning');
  const move = (ev) => { panX = px + (ev.clientX - sx); panY = py + (ev.clientY - sy); updateTransform(); };
  const up = () => { viewport.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveView(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function startBinderDrag(e, binderEl) {
  e.preventDefault();
  const binder = ws.binders.find((b) => b.id === binderEl.dataset.id);
  const sx = e.clientX, sy = e.clientY, x0 = binder.x, y0 = binder.y;
  const head = binderEl.querySelector('.binder-head');
  let moved = false, lastX = e.clientX, curAngle = 0, targetAngle = 0, raf = null;
  const tick = () => {
    targetAngle *= 0.85;
    curAngle += (targetAngle - curAngle) * 0.25;
    binderEl.style.transform = `rotate(${curAngle.toFixed(2)}deg) scale(1.015)`;
    raf = requestAnimationFrame(tick);
  };
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    if (!moved) { moved = true; head.classList.add('grabbing'); binderEl.classList.add('binder-dragging'); raf = requestAnimationFrame(tick); }
    targetAngle = Math.max(-6, Math.min(6, (ev.clientX - lastX) * 0.5)); lastX = ev.clientX;
    binder.x = snap(x0 + (ev.clientX - sx) / zoom);
    binder.y = snap(y0 + (ev.clientY - sy) / zoom);
    binderEl.style.left = binder.x + 'px'; binderEl.style.top = binder.y + 'px';
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (raf) cancelAnimationFrame(raf);
    head.classList.remove('grabbing'); binderEl.classList.remove('binder-dragging');
    binderEl.style.transform = '';
    if (moved) {
      binderEl.classList.add('dropped');
      setTimeout(() => binderEl.classList.remove('dropped'), 280);
      api('PATCH', `/api/binders/${binder.id}`, { x: binder.x, y: binder.y }).catch((err) => toast(err.message));
    }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function startCardDrag(e, cardEl) {
  e.preventDefault();
  const cardId = cardEl.dataset.id;
  const sx = e.clientX, sy = e.clientY;
  const rect = cardEl.getBoundingClientRect();
  const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
  let ghost = null, moved = false, drop = null, lastX = e.clientX;
  let curAngle = 0, targetAngle = 0, raf = null;

  // swing the picked-up card side to side by horizontal velocity, easing back upright
  const tick = () => {
    targetAngle *= 0.85;
    curAngle += (targetAngle - curAngle) * 0.25;
    if (ghost) ghost.style.transform = `rotate(${curAngle.toFixed(2)}deg)`;
    raf = requestAnimationFrame(tick);
  };

  const move = (ev) => {
    if (!moved) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      ghost = cardEl.cloneNode(true);
      ghost.classList.add('drag-ghost'); ghost.classList.remove('pop-in', 'drop-in');
      ghost.style.width = rect.width + 'px';
      document.body.appendChild(ghost);
      cardEl.classList.add('drag-source');
      document.body.classList.add('dragging-card');
      raf = requestAnimationFrame(tick);
    }
    targetAngle = Math.max(-14, Math.min(14, (ev.clientX - lastX) * 1.3));
    lastX = ev.clientX;
    ghost.style.left = (ev.clientX - offX) + 'px';
    ghost.style.top = (ev.clientY - offY) + 'px';
    clearInsert();
    const binderEl = binderElAt(ev.clientX, ev.clientY);
    if (binderEl) {
      const index = insertionIndex(binderEl, ev.clientY, cardId);
      binderEl.classList.add('drop-target'); lastDropBinder = binderEl;
      showInsert(binderEl, index, cardId);
      drop = { binderId: binderEl.dataset.id, toIndex: index };
    } else { drop = null; }
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (raf) cancelAnimationFrame(raf);
    document.body.classList.remove('dragging-card');
    if (ghost) ghost.remove();
    cardEl.classList.remove('drag-source');
    clearInsert();
    if (!moved) { openCard(cardId); return; }
    if (drop) applyMove(cardId, drop);
    else {
      const w = screenToWorld(ev.clientX - offX, ev.clientY - offY);
      applyMove(cardId, { binderId: null, x: snap(Math.round(w.x)), y: snap(Math.round(w.y)) });
    }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

async function applyMove(cardId, payload) {
  droppedId = cardId; // play the drop-in animation on the card once it re-renders
  try { await api('POST', `/api/cards/${cardId}/move`, payload); await reloadWorkspace(); }
  catch (e) { toast(e.message); await reloadWorkspace(); }
}

// ---------- wheel ----------
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, zoom * Math.exp(-e.deltaY * 0.0015));
  else { panX -= e.deltaX; panY -= e.deltaY; updateTransform(); saveView(); }
}, { passive: false });

$('zoom-in').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, zoom * 1.2); });
$('zoom-out').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, zoom / 1.2); });
$('zoom-reset').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; updateTransform(); saveView(); });

// ---------- toolbar add ----------
$('add-card-btn').addEventListener('click', async () => {
  const c = viewCenterWorld();
  try {
    const card = await api('POST', `/api/workspaces/${ws.id}/cards`, { title: 'New card', x: snap(Math.round(c.x - 132)), y: snap(Math.round(c.y - 40)) });
    pendingPopId = card.id;
    await reloadWorkspace();
    openCard(card.id); titleInput.focus(); titleInput.select();
  } catch (e) { toast(e.message); }
});
$('add-binder-btn').addEventListener('click', async () => {
  const c = viewCenterWorld();
  try {
    const b = await api('POST', `/api/workspaces/${ws.id}/binders`, { title: 'New binder', x: snap(Math.round(c.x - 156)), y: snap(Math.round(c.y - 40)) });
    pendingPopId = b.id;
    await reloadWorkspace();
    openBinderEditor(b.id, true); // new binder → jump straight to naming it
  } catch (e) { toast(e.message); }
});

// ---------- workspaces ----------
async function switchWorkspace(id) {
  await api('PATCH', '/api/state', { activeWorkspaceId: id }).catch(() => {});
  await loadWorkspace(id);
}
$('ws-add').addEventListener('click', async () => {
  try {
    const created = await api('POST', '/api/workspaces', {});
    const s = await api('GET', '/api/state'); wsList = s.workspaces;
    await loadWorkspace(created.id);
  } catch (e) { toast(e.message); }
});

let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('pointerdown', onDocDown, true); } }
function onDocDown(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div'); menu.className = 'popup-menu';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.textContent = it.label; if (it.danger) b.className = 'danger';
    b.addEventListener('click', () => { closeMenu(); it.onClick(); });
    menu.appendChild(b);
  });
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  document.body.appendChild(menu); openMenuEl = menu;
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
}
function openWorkspaceMenu(e, w) {
  const r = e.target.getBoundingClientRect();
  showMenu(r.left - 100, r.bottom + 6, [
    { label: 'Rename', onClick: () => { const tab = [...document.querySelectorAll('.ws-tab')].find((t) => t.querySelector('.ws-name')?.textContent === w.name); if (tab) startTabRename(w, tab.querySelector('.ws-name')); } },
    { label: 'Delete board', danger: true, onClick: async () => {
      if (wsList.length === 1) return toast('Cannot delete the last board');
      if (!confirm(`Delete board “${w.name}” and everything in it? (This cannot be undone.)`)) return;
      try { const res = await api('DELETE', `/api/workspaces/${w.id}`); const s = await api('GET', '/api/state'); wsList = s.workspaces; await loadWorkspace(res.activeWorkspaceId); }
      catch (err) { toast(err.message); }
    } },
  ]);
}

// ---------- undo ----------
async function undo() {
  try {
    const r = await api('POST', '/api/undo');
    if (r.empty) { toast('Nothing to undo'); return; }
    if (!r.ok) { toast('Could not undo'); return; }
    if (r.workspaceId && r.workspaceId !== activeWorkspaceId) await switchWorkspace(r.workspaceId);
    else await reloadWorkspace();
  } catch (e) { toast(e.message); }
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    e.preventDefault(); undo();
  }
});

// ---------- modal ----------
const overlay = $('modal-overlay');
const modal = $('modal');
const titleInput = $('card-title');
const descView = $('desc-view');
const descEdit = $('desc-edit');
const descToggle = $('desc-toggle');
const attachmentsEl = $('attachments');
const addDrop = $('add-drop');

$('modal-close').innerHTML = ICON.close;
$('delete-card').innerHTML = ICON.trash;

function openCard(id) {
  currentCardId = id; descEditing = false; editingAtts.clear();
  const card = currentCard(); if (!card) return;
  showCard(card);
  overlay.classList.remove('hidden');
}
function showCard(card) {
  titleInput.value = card.title;
  showCardMeta(card);
  renderDescription(); renderAttachments(); updateSortBtn();
}
function showCardMeta(card) {
  $('card-meta').textContent = `Created ${shortDate(card.createdAt)} · Updated ${shortDate(card.updatedAt)}`;
}
function closeModal() { overlay.classList.add('hidden'); currentCardId = null; }
let overlayPressTarget = null;
overlay.addEventListener('pointerdown', (e) => { overlayPressTarget = e.target; });
overlay.addEventListener('click', (e) => { if (e.target === overlay && overlayPressTarget === overlay) closeModal(); });
$('modal-close').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal(); });

titleInput.addEventListener('change', async () => {
  const card = currentCard(); if (!card) return;
  const title = titleInput.value.trim();
  if (!title || title === card.title) { titleInput.value = card.title; return; }
  try { const u = await api('PATCH', `/api/cards/${card.id}`, { title }); Object.assign(card, u); renderWorkspace(); }
  catch (e) { toast(e.message); }
});

descToggle.className = 'icon-btn desc-edit-btn';
descToggle.title = 'Edit description';
descToggle.innerHTML = ICON.pencil;

function renderDescription() {
  const card = currentCard();
  if (descEditing) { descEdit.value = card.description || ''; descEdit.classList.remove('hidden'); descView.classList.add('hidden'); }
  else { descView.innerHTML = renderMarkdown(card.description); descView.classList.remove('hidden'); descEdit.classList.add('hidden'); }
}
function enterDescEdit() {
  if (descEditing) return;
  descEditing = true; renderDescription(); descEdit.focus();
}
async function saveDesc() {
  if (!descEditing) return;
  descEditing = false;
  const card = currentCard();
  if (card && descEdit.value !== card.description) {
    try { const u = await api('PATCH', `/api/cards/${card.id}`, { description: descEdit.value }); Object.assign(card, u); }
    catch (e) { toast(e.message); }
  }
  renderDescription(); renderWorkspace();
}
descToggle.addEventListener('click', () => { if (descEditing) saveDesc(); else enterDescEdit(); });
descView.addEventListener('dblclick', enterDescEdit);
descEdit.addEventListener('blur', saveDesc);

// ----- attachments -----
const attMode = (card) => (card && card.attSort) || 'newest';
function sortedAttachments(card) {
  const list = [...(card.attachments || [])];
  if (attMode(card) === 'custom') return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return attMode(card) === 'newest' ? list.reverse() : list;
}
function updateSortBtn() {
  const m = attMode(currentCard());
  $('att-sort').textContent = m === 'newest' ? 'Newest first ↓' : m === 'oldest' ? 'Oldest first ↑' : 'Custom order ↕';
}
$('att-sort').addEventListener('click', async () => {
  const card = currentCard(); if (!card) return;
  const m = attMode(card);
  const next = m === 'newest' ? 'oldest' : m === 'oldest' ? 'custom' : 'newest';
  if (next === 'custom') {
    await reorderAtts(card, sortedAttachments(card).map((a) => a.id)); // freeze current view as custom
  } else {
    card.attSort = next;
    try { await api('PATCH', `/api/cards/${card.id}`, { attSort: next }); } catch (e) { toast(e.message); }
  }
  updateSortBtn(); renderAttachments();
});
async function reorderAtts(card, ids) {
  card.attSort = 'custom';
  ids.forEach((id, i) => { const a = card.attachments.find((x) => x.id === id); if (a) a.order = i; });
  try { await api('POST', `/api/cards/${card.id}/attachments/reorder`, { orderedIds: ids }); } catch (e) { toast(e.message); }
}
function startAttReorder(e, attEl) {
  e.preventDefault();
  const card = currentCard(); if (!card) return;
  const rect = attEl.getBoundingClientRect();
  const offY = e.clientY - rect.top;
  const startX = e.clientX, startY = e.clientY;
  let moved = false, ghost = null, placeholder = null, beforeEl;

  const siblings = () => [...attachmentsEl.querySelectorAll('.attachment')].filter((el) => el !== attEl);
  const flipTargets = () => [...attachmentsEl.children].filter((el) => el !== attEl);

  // FLIP: snapshot positions, mutate the list, then slide each item from where it
  // was to where it landed — so the other attachments glide out of the way.
  const flip = (mutate) => {
    const first = new Map(flipTargets().map((el) => [el, el.getBoundingClientRect().top]));
    mutate();
    for (const el of flipTargets()) {
      const from = first.get(el);
      if (from == null) continue;
      const dy = from - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = 'transform 0.16s ease'; el.style.transform = ''; });
    }
  };

  // Move the orange placeholder to the slot the cursor is hovering, animating the shuffle.
  const place = (clientY) => {
    const after = siblings().find((el) => { const r = el.getBoundingClientRect(); return clientY < r.top + r.height / 2; }) || null;
    if (after === beforeEl) return;
    beforeEl = after;
    flip(() => { if (after) attachmentsEl.insertBefore(placeholder, after); else attachmentsEl.appendChild(placeholder); });
  };

  const move = (ev) => {
    if (!moved) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      ghost = attEl.cloneNode(true);
      ghost.classList.add('att-ghost');
      ghost.style.transform = ''; ghost.style.transition = '';
      ghost.style.width = rect.width + 'px';
      ghost.style.left = rect.left + 'px';
      document.body.appendChild(ghost);
      placeholder = document.createElement('div');
      placeholder.className = 'att-placeholder';
      placeholder.style.height = rect.height + 'px';
      attEl.after(placeholder);
      attEl.classList.add('att-drag-source');
      document.body.classList.add('att-reordering');
    }
    ghost.style.top = (ev.clientY - offY) + 'px';
    place(ev.clientY);
  };
  const up = async () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!moved) return;
    document.body.classList.remove('att-reordering');
    if (ghost) ghost.remove();
    if (!attEl.isConnected || !placeholder.isConnected) { renderAttachments(); return; } // redrawn meanwhile (an upload landed): drop the gesture
    attachmentsEl.insertBefore(attEl, placeholder);
    placeholder.remove();
    attEl.classList.remove('att-drag-source');
    flipTargets().forEach((el) => { el.style.transition = ''; el.style.transform = ''; }); // clear leftover FLIP transforms
    attEl.classList.add('att-dropped');
    setTimeout(() => attEl.classList.remove('att-dropped'), 300);
    const ids = [...attachmentsEl.querySelectorAll('.attachment')].map((el) => el.dataset.attId);
    await reorderAtts(card, ids);
    updateSortBtn(); // the DOM already shows the dropped order — no re-render, so the drop animation survives
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function renderAttachments() {
  const card = currentCard();
  attachmentsEl.innerHTML = '';
  sortedAttachments(card).forEach((att) => attachmentsEl.appendChild(renderAttachment(att)));
}
function attachmentBody(att) {
  if (att.type === 'text') {
    if (editingAtts.has(att.id)) return `<textarea class="att-text-edit" placeholder="Write markdown…"></textarea>`;
    return `<div class="markdown">${renderMarkdown(att.content)}</div>`;
  }
  if (att.type === 'url') {
    const u = webURL(att.url);
    if (!u) return `<span>${escapeHtml(att.title || att.url || '')}</span>`; // not a web link: shown, never followed
    const href = escapeHtml(u);
    if (looksLikeImage(u)) return `<a href="${href}" target="_blank" rel="noopener">${href}</a><img src="${href}" alt="" style="margin-top:6px">`;
    if (looksLikeVideo(u)) return `<a href="${href}" target="_blank" rel="noopener">${href}</a><video src="${href}" controls style="margin-top:6px"></video>`;
    return `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(att.title || u)}</a>`;
  }
  const src = escapeHtml(fileUrl(att));
  if (att.type === 'image') {
    // The demo's files are in this page's own origin: only a plain picture opens in a tab (demo-api.js).
    const opens = !DEMO || window.DriftboardDemo.opensSafely(att.mimeType);
    return `<a href="${src}" ${opens ? 'target="_blank" rel="noopener"' : `download="${escapeHtml(att.originalName || '')}"`}><img src="${src}" alt=""></a>`;
  }
  if (att.type === 'video') return `<video src="${src}" controls></video>`;
  return `<a href="${src}" download="${escapeHtml(att.originalName || '')}">⬇ ${escapeHtml(att.originalName || 'download')}</a> <span style="color:var(--muted);font-size:12px">(${escapeHtml(formatBytes(att.size))})</span>`;
}
function renderAttachment(att) {
  const el = document.createElement('div');
  el.className = 'attachment'; el.dataset.attId = att.id;
  const editing = editingAtts.has(att.id);
  const canEdit = att.type === 'text' && !editing;
  el.innerHTML = `
    <div class="att-head">
      <span class="att-grip" title="Drag to reorder">${ICON.grip}</span>
      <span class="att-type">${escapeHtml(att.type)}</span>
      ${att.originalName ? `<span class="att-name">${escapeHtml(att.originalName)}</span>` : ''}
      <span class="att-time">${escapeHtml(shortDate(att.createdAt))}</span>
      ${editing ? '' : `<span class="att-actions">
        ${canEdit ? `<button class="icon-btn" data-a="edit" title="Edit">${ICON.pencil}</button>` : ''}
        <button class="icon-btn danger" data-a="remove" title="Remove">${ICON.trash}</button>
      </span>`}
    </div>
    <div class="att-body">${attachmentBody(att)}</div>`;

  el.querySelector('.att-grip').addEventListener('pointerdown', (e) => startAttReorder(e, el));

  if (editing) {
    const ta = el.querySelector('.att-text-edit');
    ta.value = att.content || '';
    setTimeout(() => ta.focus({ preventScroll: true }), 0);
    ta.addEventListener('blur', () => commitText(att, ta.value));
  } else {
    const rm = el.querySelector('[data-a="remove"]'); if (rm) rm.addEventListener('click', () => removeAttachment(att.id));
    const ed = el.querySelector('[data-a="edit"]'); if (ed) ed.addEventListener('click', () => { editingAtts.add(att.id); renderAttachments(); });
  }
  return el;
}
async function commitText(att, value) {
  if (!editingAtts.has(att.id)) return;
  editingAtts.delete(att.id);
  const card = currentCard(); if (!card) return;
  if (!value.trim()) {
    try { await api('DELETE', `/api/cards/${card.id}/attachments/${att.id}`); } catch {}
    card.attachments = card.attachments.filter((a) => a.id !== att.id);
    renderAttachments(); renderWorkspace(); return;
  }
  if (value !== att.content) {
    try { const u = await api('PATCH', `/api/cards/${card.id}/attachments/${att.id}`, { content: value }); Object.assign(att, u); }
    catch (e) { toast(e.message); }
  }
  renderAttachments(); renderWorkspace();
}
async function removeAttachment(attId) {
  const card = currentCard();
  const el = attachmentsEl.querySelector(`[data-att-id="${attId}"]`);
  if (el) { el.classList.add('removing'); await new Promise((r) => setTimeout(r, 150)); }
  try {
    await api('DELETE', `/api/cards/${card.id}/attachments/${attId}`);
    card.attachments = card.attachments.filter((a) => a.id !== attId);
    editingAtts.delete(attId); renderAttachments(); renderWorkspace();
  } catch (e) { toast(e.message); }
}
// The board may be redrawn while an attachment is on its way: add it to the card as it is now.
function addToCard(cardId, att) {
  const card = ws.cards.find((c) => c.id === cardId);
  if (card && !card.attachments.some((a) => a.id === att.id)) card.attachments.push(att);
}
async function addJsonAttachment(payload) {
  const cardId = currentCardId;
  const att = await api('POST', `/api/cards/${cardId}/attachments`, payload);
  addToCard(cardId, att);
  return att;
}
let uploading = 0;
async function uploadFiles(files) {
  const cardId = currentCardId; if (!currentCard()) return;
  const newIds = [];
  uploading++;
  try {
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file);
      try { const att = await api('POST', `/api/cards/${cardId}/attachments`, fd, true); addToCard(cardId, att); newIds.push(att.id); }
      catch (e) { toast(`${file.name}: ${e.message}`); }
    }
    if (currentCardId === cardId) await afterAttachmentsAdded(newIds);
    else renderWorkspace(); // another card is open now: only its badge on the canvas changes
  } finally {
    uploading--;
  }
}

// New attachments land at the top under Custom and Newest-first order, and at the
// bottom under Oldest-first — then we scroll so the fresh item is in view.
async function afterAttachmentsAdded(newIds) {
  const card = currentCard(); if (!card) return;
  if (attMode(card) === 'custom' && newIds.length) {
    const rest = sortedAttachments(card).filter((a) => !newIds.includes(a.id)).map((a) => a.id);
    await reorderAtts(card, [...newIds, ...rest]); // Newest/Oldest already fall out of the createdAt sort
  }
  renderAttachments(); renderWorkspace();
  scrollToNewAttachments(newIds, attMode(card) === 'oldest');
}
function scrollToNewAttachments(newIds, toBottom) {
  const els = newIds.map((id) => attachmentsEl.querySelector(`[data-att-id="${id}"]`)).filter(Boolean);
  if (!els.length) return;
  els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  (toBottom ? els[els.length - 1] : els[0]).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// big + / drop button
addDrop.addEventListener('click', async () => {
  try {
    const att = await addJsonAttachment({ type: 'text', content: '' });
    editingAtts.add(att.id);
    await afterAttachmentsAdded([att.id]);
  } catch (e) { toast(e.message); }
});
document.addEventListener('paste', (e) => {
  if (overlay.classList.contains('hidden')) return;
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); uploadFiles(files); }
});
['dragenter', 'dragover'].forEach((evt) => modal.addEventListener(evt, (e) => {
  if (e.dataTransfer?.types?.includes('Files') || e.dataTransfer?.types?.includes('text/uri-list')) { e.preventDefault(); addDrop.classList.add('dragover'); }
}));
modal.addEventListener('dragleave', (e) => { if (e.target === modal) addDrop.classList.remove('dragover'); });
modal.addEventListener('drop', async (e) => {
  addDrop.classList.remove('dragover');
  const dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length) { e.preventDefault(); uploadFiles(dt.files); return; }
  const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
  if (uri && /^https?:\/\//i.test(uri.trim())) { e.preventDefault(); const att = await addJsonAttachment({ type: 'url', url: uri.trim() }); await afterAttachmentsAdded([att.id]); }
});

// delete card (trash icon, undoable)
$('delete-card').addEventListener('click', async () => {
  const card = currentCard(); if (!card) return;
  const title = card.title;
  try { await api('DELETE', `/api/cards/${card.id}`); closeModal(); await reloadWorkspace(); toastAction(`Deleted “${title}”`, 'Undo', undo); }
  catch (e) { toast(e.message); }
});

// ---------- binder editor ----------
const BINDER_PALETTE = [
  '#646d72', '#7f8c8d', '#455a64', '#34495e', '#795548', '#8d6e63',
  '#d21419', '#c0392b', '#e91e63', '#e76125', '#d35400', '#f4a300',
  '#b8860b', '#f1c40f', '#7cb342', '#2e8b57', '#27ae60', '#16a085',
  '#00897b', '#0097a7', '#3b7dd8', '#5c6bc0', '#8e44ad', '#9b59b6',
];
let currentBinderId = null;
const binderOverlay = $('binder-overlay');
const binderColorBar = $('binder-color-bar');
$('binder-close').innerHTML = ICON.close;
$('binder-delete').innerHTML = ICON.trash;
$('binder-edit-color').innerHTML = ICON.pencil;
const currentBinder = () => ws && ws.binders.find((b) => b.id === currentBinderId);

// focusName: only true for a freshly created binder (toolbar), where jumping
// straight into naming is wanted. Double-click / edit just opens the editor.
function openBinderEditor(binderId, focusName = false) {
  currentBinderId = binderId;
  const b = currentBinder(); if (!b) return;
  $('binder-name').value = b.title;
  $('binder-desc').value = b.description || '';
  binderColorBar.style.setProperty('--binder-color', binderColor(b, ws.binders.indexOf(b)));
  binderOverlay.classList.remove('hidden');
  if (focusName) { $('binder-name').focus(); $('binder-name').select(); }
}
function closeBinderEditor() { binderOverlay.classList.add('hidden'); currentBinderId = null; }

// custom colour picker that pops up next to the click (native OS dialog ignores position on Linux)
function openColorPopover(x, y) {
  closeMenu();
  const b = currentBinder(); if (!b) return;
  const current = binderColor(b, ws.binders.indexOf(b));
  const pop = document.createElement('div');
  pop.className = 'color-popover';
  BINDER_PALETTE.forEach((col) => {
    const sw = document.createElement('button');
    sw.className = 'color-swatch' + (col.toLowerCase() === current.toLowerCase() ? ' selected' : '');
    sw.style.background = col;
    sw.title = col;
    sw.addEventListener('click', async () => {
      closeMenu();
      b.color = col;
      binderColorBar.style.setProperty('--binder-color', col);
      renderWorkspace();
      try { await api('PATCH', `/api/binders/${b.id}`, { color: col }); } catch (e) { toast(e.message); }
    });
    pop.appendChild(sw);
  });
  pop.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  pop.style.top = Math.min(y, window.innerHeight - 175) + 'px'; // taller now (24 swatches / 4 rows)
  document.body.appendChild(pop);
  openMenuEl = pop;
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
}
binderColorBar.addEventListener('click', (e) => openColorPopover(e.clientX, e.clientY));
$('binder-edit-color').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openColorPopover(r.left - 180, r.bottom + 6);
});
async function saveBinderName() {
  const b = currentBinder(); if (!b) return;
  const name = $('binder-name').value.trim();
  if (name && name !== b.title) { b.title = name; try { await api('PATCH', `/api/binders/${b.id}`, { title: name }); renderWorkspace(); } catch (e) { toast(e.message); } }
}
$('binder-name').addEventListener('blur', saveBinderName);
$('binder-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('binder-name').blur(); } });
$('binder-desc').addEventListener('blur', async () => {
  const b = currentBinder(); if (!b) return;
  const desc = $('binder-desc').value;
  if (desc !== (b.description || '')) { b.description = desc; try { await api('PATCH', `/api/binders/${b.id}`, { description: desc }); renderWorkspace(); } catch (e) { toast(e.message); } }
});
$('binder-close').addEventListener('click', closeBinderEditor);
$('binder-delete').addEventListener('click', async () => {
  const b = currentBinder(); if (!b) return;
  const title = b.title;
  closeBinderEditor();
  try { await api('DELETE', `/api/binders/${b.id}`); await reloadWorkspace(); toastAction(`Deleted binder “${title}”`, 'Undo', undo); }
  catch (e) { toast(e.message); }
});
binderOverlay.addEventListener('click', (e) => { if (e.target === binderOverlay) closeBinderEditor(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !binderOverlay.classList.contains('hidden')) closeBinderEditor(); });

// ---------- demo mode ----------
document.body.classList.toggle('demo', DEMO); // reveals the header demo banner (styles.css)
if (DEMO) {
  $('demo-reset').addEventListener('click', async () => {
    if (!confirm('Reset the demo? This clears every board, card, and file stored in this browser.')) return;
    try { await window.DriftboardDemo.reset(); location.reload(); }
    catch (e) { toast(e.message); }
  });
}

// ---------- text-field keyboard shortcuts (works in any input/textarea) ----------
// Remember each field's value when editing begins, so Escape can revert cleanly.
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) t.dataset.origValue = t.value;
});
// Capture phase so this runs before the per-field / modal Escape handlers.
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); e.stopPropagation();
    t.blur(); // apply — every field saves on blur
  } else if (e.key === 'Escape') {
    if (t.dataset.origValue !== undefined) t.value = t.dataset.origValue; // revert to pre-edit value…
    e.preventDefault(); e.stopPropagation();
    t.blur(); // …then exit; the save-on-blur sees no change, so nothing is written
  }
}, true);

// ---------- live updates ----------
// Another tab or a script may change the board. Each response carries the board's revision.
// knownRevision is the revision this tab last drew: a write of its own moves it one step, and
// any other step means a change from elsewhere. A read leaves it alone (a read does not
// redraw the board, so what it saw is not on screen); the check below sets it to what it drew.
let knownRevision = null;
let changedElsewhere = false;
let checking = false;
function noteWrite(res) {
  const revision = Number(res.headers.get('X-Board-Revision'));
  if (!revision) return;
  if (knownRevision !== null && revision === knownRevision + 1) knownRevision = revision;
  else changedElsewhere = true;
}
// Never redraw under the user's hands. A drag holds on to the elements it started from, and so
// does a press that has not moved far enough to be a drag yet.
let pointerDown = false;
window.addEventListener('pointerdown', () => { pointerDown = true; }, true);
window.addEventListener('pointerup', () => { pointerDown = false; }, true);
window.addEventListener('pointercancel', () => { pointerDown = false; }, true);
window.addEventListener('blur', () => { pointerDown = false; });
function gesturing() {
  return pointerDown || document.body.classList.contains('dragging-card') || document.body.classList.contains('att-reordering')
    || !!document.querySelector('.binder-dragging');
}
// Nor while a menu or editor is open or a field is being typed in, nor while a save or upload
// is on its way (it would land on the card it started from, after the redraw replaced it).
function busy() {
  const focused = document.activeElement;
  return gesturing() || pendingWrites > 0 || uploading > 0
    || !!openMenuEl || currentBinderId !== null || descEditing || editingAtts.size > 0
    || (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA'));
}
// The same data gives the same text, whatever order its keys were set in.
function stableJSON(value) {
  return JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}
const sameData = (a, b) => stableJSON(a) === stableJSON(b);
const boardContent = ({ view, ...content }) => content; // where another tab looks is its own business
const cardContent = (card) => card && { title: card.title, description: card.description, attachments: card.attachments, attSort: card.attSort };
async function checkForChanges() {
  if (DEMO || locked || away || checking || document.hidden || busy() || !ws) return;
  checking = true;
  try {
    const { data: s, revision } = await request('GET', '/api/state');
    if (revision === knownRevision && !changedElsewhere) return;
    changedElsewhere = false;
    const boardGone = !s.workspaces.some((w) => w.id === activeWorkspaceId);
    const { data: fresh, revision: drawn } = await request('GET', `/api/workspaces/${boardGone ? s.activeWorkspaceId : activeWorkspaceId}`);
    if (busy()) { changedElsewhere = true; return; } // the user started something while we asked: next time
    const tabsChanged = !sameData(s.workspaces, wsList);
    wsList = s.workspaces;
    knownRevision = drawn; // what was drawn, even if older: a server that went back must not redraw forever
    if (boardGone) {
      if (currentCardId) closeModal();
      showWorkspace(fresh);
      toast('This board was deleted elsewhere');
      return;
    }
    if (tabsChanged) renderTabs();
    // Redraw only what changed: a write elsewhere (another board, another tab saving its view)
    // must not restart a video, or lose the scroll and selection in the open card.
    if (sameData(boardContent(fresh), boardContent(ws))) return;
    const shownCard = currentCard();
    ws = fresh; renderWorkspace();
    if (currentCardId) {
      const card = currentCard();
      if (!card) { closeModal(); toast('This card was deleted elsewhere'); return; }
      if (!sameData(cardContent(card), cardContent(shownCard))) showCard(card);
      else showCardMeta(card); // moved, say: only its dates show that
    }
  } catch (e) {
    changedElsewhere = true; // try again next time
    throw e;
  } finally {
    checking = false;
  }
}
if (!DEMO) {
  setInterval(() => { checkForChanges().catch(() => {}); }, 3000);
  document.addEventListener('visibilitychange', () => { checkForChanges().catch(() => {}); });
}

// ---------- links to a card ----------
// #card=<id> opens that card, on whichever board it is (a link from another app, a bookmark).
// The fragment is cleared once dealt with, so the same link works again and a reload does not
// reopen the card.
async function openLinkedCard() {
  const id = new URLSearchParams(location.hash.slice(1)).get('card');
  if (!id || locked || away) return;
  let found;
  try {
    found = await api('GET', `/api/cards/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e.status === 404) { forgetLink(); toast('That card no longer exists'); }
    else if (e.status !== 401 && !e.away) toast(`Could not open that card (${e.message}): reload to try again`);
    return; // locked or away: the link stays for when it works
  }
  forgetLink();
  document.activeElement?.blur(); // saves whatever was being typed
  closeMenu(); closeBinderEditor();
  if (found.workspaceId !== activeWorkspaceId) await switchWorkspace(found.workspaceId);
  else if (!ws.cards.some((c) => c.id === id)) await reloadWorkspace(); // made after this board was drawn
  openCard(id);
}
function forgetLink() {
  history.replaceState(history.state, '', location.pathname + location.search);
}
// A sign-in link put into a tab already at this address changes only the fragment: no reload.
window.addEventListener('hashchange', async () => {
  const code = takeSignInCode();
  if (code && !token) {
    await signInWithCode(code);
    if (!token) return;
    locked = false;
    $('locked').classList.add('hidden');
    start();
    return;
  }
  openLinkedCard();
});

// ---------- go ----------
function start() {
  return loadState().then(openLinkedCard).catch((e) => { if (!locked && !away) toast('Failed to load: ' + e.message); });
}
signInWithCode(takeSignInCode()).then(start);
