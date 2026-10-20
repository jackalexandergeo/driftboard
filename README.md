<p align="center">
  <img alt="Driftboard logo" src="docs/favicon.svg" width="96" height="96">
</p>

<h1 align="center">Driftboard</h1>

<p align="center">
  <b>An infinite-canvas to-do board.</b> Float cards anywhere, file them into colorful binders,<br>
  and drop images, videos, links, and notes onto any card.
</p>

<p align="center">
  <a href="https://mitchellaidant.github.io/driftboard/"><img alt="Live Demo" src="https://img.shields.io/badge/▶%20%20Live%20Demo-e76125?style=for-the-badge&logoColor=white"></a>
</p>

<p align="center">
  <img alt="Vanilla JS" src="https://img.shields.io/badge/vanilla%20JS-f7df1e?style=flat-square&logo=javascript&logoColor=black">
  <img alt="Node + Express" src="https://img.shields.io/badge/Node%20%2B%20Express-2e8b57?style=flat-square&logo=node.js&logoColor=white">
</p>

<p align="center">
  <img alt="Driftboard board" src="docs/media/cardMoveAnimations.gif" width="900">
</p>

---

## 🎡 What you can do

### Drag everything, with a bit of bounce
Grab a card and move it wherever you like it; drop it into a
binder or leave it floating on the canvas.

### Rich cards with attachments
Open any card for a title, a description, and a stack of attachments —
**text notes, links, images, videos, and files**. Drag a file to the binder,
or just paste (⌘/Ctrl+V) straight onto the card. Text uses markdown formatting!

### Reorder attachments by hand
Drag any attachment by its grip: a lifted preview follows your cursor and an
**orange placeholder** shows exactly where it'll land, while the rest slide out of
the way.

<p align="center"><img alt="Attachment reordering" src="docs/media/showCardAttachments.gif" width="820"></p>

---

## ✨ Try it now — no install

**[▶ Open the live demo →](https://mitchellaidant.github.io/driftboard/)**

The demo runs **entirely in your browser** — there's no server and nothing is
uploaded anywhere. Your board (and any files you drop in) are saved **on your own
machine** in the browser's local storage, which can be cleared, so DO NOT use the demo
for your personal use. Instead, [Run it locally](#-run-it-locally).

---

## 🧭 The tour

**Canvas**
- **Pan** — drag empty space, or scroll (two-finger on a trackpad).
- **Zoom** — ⌘/Ctrl + scroll, or the `+` / `−` / `100%` controls. `100%` resets the view.

**Boards** (the tabs up top)
- **+** makes a new empty board and opens it.
- **Double-click a tab** to rename it; the **⋯** menu also has Rename / Delete.

**Binders & cards**
- Add a **binder** or a floating **card** from the bottom toolbar; a binder also
  has its own *+ Add a card*.
- **Move a card** by dragging — into a binder to file it, or onto open canvas to
  let it float. **Move a binder** by its title bar.
- **Edit a binder** — double-click it to rename, pick an accent **color**, and add
  a description shown under its title.
- **Open a card** — click it. The title saves on blur; edit the description with
  the ✏ pencil (or double-click it) and click away to save.

**Attachments**
- The big **+**: click for a markdown note, or drag a file / paste to upload.
  Dropping a link adds it as a URL. New items land at the top (or the bottom in
  oldest-first order) and scroll into view.
- The sort button cycles **Newest → Oldest → Custom**; dragging to reorder switches
  to Custom automatically.

**Appearance**
- **Light / dark** toggle at the top-right (remembered per browser).
- **Snap to grid** toggle so cards and binders line up as you drag.

**Live**
- Changes made in another tab, or by a script through the API, show up within a few
  seconds; nothing is redrawn while you are dragging, typing or have a menu open.
- **Link to a card** with `#card=<card id>` at the end of the board's address: it opens
  that card on whichever board it is.

**Undo**
- Deleting a card or binder is **undoable** — the toast's **Undo** button or
  **⌘/Ctrl+Z**. The last 40 deletions come back, even after a restart.

---

## 💻 Run it locally

Running locally gives you the **full app with a small Node server** that saves your
board as real files on disk (great for backups) instead of in the browser.

```sh
git clone https://github.com/mitchellaidant/driftboard.git
cd driftboard
npm install
npm start
```

Then, in another terminal, run `npm run open`: it opens the board in your browser
and signs you in. Run it with the same `DRIFTBOARD_DATA`, `DRIFTBOARD_HOST` and `PORT`
as the server (`PORT=5000 npm start`, then `PORT=5000 npm run open`).

### Signing in

The board has no accounts. On first start the server makes a random token and keeps
it in `data/token`, readable only by you; whoever has the token can read and change
the board. `npm run open` asks the server for a sign-in code that works once, for a
minute, and opens `http://127.0.0.1:4321/?code=…`; the page swaps the code for the
token, keeps it in its memory only and takes the code out of the address bar. So the
token never shows up in an address, in the browser's command line (which every user of
the machine can read), in its history or in its storage. There are no cookies. A page
stays signed in for as long as it is open: after a reload, or in a new tab, open the
board again with `npm run open` (or the app that opened it).
`npm run open -- --print` prints the link without opening a browser.

While the board is down, any user of the machine can listen on its port and answer in
its place, with pages of their own at its address. What that gets them:

- Not the token. Nothing sends it to a server that has not first proved it holds it:
  `npm run open` and the page ask for the proof (`GET /api/hello`, below) before every
  call that carries the token. An open tab that gets no proof says "The board went
  away", sends nothing and stops looking for changes, and carries on once the board is
  back. Their pages find no token in the browser's storage either. Your scripts should
  prove the server too.
- What the page asks for without the token: the proofs, and any uploaded file it loads
  while the board is down, whose link carries the uploads key (below). The key opens
  uploaded files only, and only once the board is back.
- Whatever you type into their page. A reloaded or restored tab, or a bookmark, can show
  their page in place of the board, looking like it. The board's own page, until it is
  opened with `npm run open`, only ever says it is locked; `npm run open` checks the
  server before it opens anything.

Scripts send the token as `Authorization: Bearer <token>` on every `/api` call:

- Never put the token on a command line: `curl -H "Authorization: Bearer $(cat data/token)"`
  shows it to every user of the machine, who can list the command lines of all processes.
  Read it from `data/token` in the script itself, or keep the header in a file only you can
  read and pass that with `curl -H @file`.
- First make sure the server is the board: `GET /api/hello?nonce=<nonce>`, with 16 to 128
  fresh random hex characters, needs no token and answers `{"proof": …}`, the HMAC-SHA256
  of `driftboard-hello:<nonce>` keyed with the token, in hex. Send the token only if the
  proof is right, and on the same connection if you can (`open.js` shows how): another
  program can take the port between two connections.
- `POST /api/sign-in-codes` returns `{"code": …, "expiresAt": …}`: open
  `http://127.0.0.1:4321/?code=<code>` to sign a browser in (add `#card=<id>` to open a
  card once signed in).
- An uploaded file is at `/uploads/<file>?k=<key>`, where the key is the HMAC-SHA256
  of `uploads` keyed with the token, in hex (`GET /api/session` returns it as
  `uploadsKey`). The key opens uploaded files only.

### Other devices

The server listens on this machine only (`127.0.0.1`). To reach it from other
devices, start it with `DRIFTBOARD_HOST=0.0.0.0` and sign each browser in with a link
from `npm run open -- --print`, with this machine's address in place of `127.0.0.1`.
Keep in mind that the board speaks plain HTTP: the token, and everything on the board,
travel unencrypted over the network, so anyone who can watch that network can take
the token and with it the board. Put an HTTPS proxy in front of it, or keep it local.

---

## 💾 Where your stuff is saved

| | Live demo (browser) | Local (`npm start`) |
|---|---|---|
| Storage | IndexedDB + Blobs, in your browser | JSON + files on disk under `data/` |
| Leaves your machine? | No | No |
| Survives clearing site data? | No | Yes |
| Good for | trying it out | real, backed-up use |

For the local version, everything lives in `data/` (`board.json` plus an
`uploads/` folder of your media) — copy that folder to back up or move everything.
To keep it somewhere else, set `DRIFTBOARD_DATA=/path/to/folder`.

---

## 🧩 One codebase, two modes

Both versions are the **same frontend** in `docs/`. It talks to storage through a
single function, so it can run against the Node backend *or* a browser-only backend
with no other changes:

- **Server mode** — `server.js` (Express) serves `docs/` and stores data on disk.
- **Demo mode** — `docs/demo-api.js` reimplements the same API against IndexedDB,
  so the site works as a static page (that's how GitHub Pages hosts it).

<details>
<summary>Publishing the demo to GitHub Pages</summary>

`docs/` is already static-ready. In the repo, go to **Settings → Pages → Build and
deployment → Source: Deploy from a branch**, pick **`main`** and the **`/docs`**
folder, and save. Pages serves it at `https://<user>.github.io/<repo>/`.
</details>
