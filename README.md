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
  that card on whichever board it is, in a tab that is signed in. A link for a new tab
  needs a sign-in code too: `#code=<code>&card=<card id>` (see [Signing in](#signing-in)).

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
minute, and writes a small page, readable only by you, in `data/opening/`, that sends
the browser on to `http://127.0.0.1:4321/#code=…`. The browser is given that page's
path, never the code: every user of the machine can read the browser's command line,
and could use a code they read there before the browser does. The page swaps the code
for the token, keeps the token in the browser's local storage for this address and port,
and takes the code out of the address bar. So the token never shows up in an address, on
a command line or in the browser's history, and the browser stays signed in: refreshes,
new tabs and restarts included. There are no cookies: a cookie for 127.0.0.1 goes to
every port on it, where any user of the machine can listen.
**No sign-in at all.** On a machine nobody else logs into, start the server with
`DRIFTBOARD_SIGN_IN=off`: the board opens without a token, PIN or `npm run open`. It still
listens on this machine only, answers only to its own names, and refuses other sites'
requests; but anyone logged into the machine can then read and change it.

**A PIN for new tabs.** `npm run set-pin` (in a terminal; it asks twice and shows nothing)
sets a PIN, and the locked page then asks for it, so a new tab or a bookmark signs in
without a terminal. Only a slow scrypt hash is kept (`data/pin`, private). Guessing is
slowed for everyone (one try at a time, and a wait after each wrong one that doubles) and
switched off after 20 wrong tries, until you set the PIN again; `npm run set-pin --
--remove` turns it off. The PIN goes to whatever answers at the board's address, like
anything typed into the page: type it into a board you know is running.

`npm run open -- --print` prints the link (`http://127.0.0.1:4321/#code=…`) without
opening a browser. (A browser that cannot read files in the data folder, such as some
sandboxed ones, needs the printed link.)

While the board is down, any user of the machine can listen on its port and answer in
its place, with pages of their own at its address. What that gets them:

- Not the token. Nothing sends it to a server that has not first proved it holds it:
  `npm run open` and the page ask for the proof (`GET /api/hello`, below) before every
  call that carries the token. An open tab that gets no proof says "The board went
  away", sends nothing and stops looking for changes, and carries on once the board is
  back. Your scripts should prove the server too. One exception: opening or refreshing
  the board while they hold the port loads their page, and that page can read the
  browser's storage for that address, token included. Keep the board running (the
  systemd unit restarts it), and if it was down, do not open it until it is back.
- What the page asks for without the token: the proofs, and any uploaded file it loads
  while the board is down, whose link carries the uploads key (below). The key opens
  uploaded files only, and only once the board is back.
- Whatever you type into their page. A reloaded or restored tab, or a bookmark, can show
  their page in place of the board, looking like it. The board's own page, until it is
  opened with `npm run open`, only ever says it is locked; `npm run open` checks the
  server before it opens anything.

Upgrading from an earlier version: on its first start, this version makes a new token,
once (it logs that it did), because earlier versions let the old one out: in sign-in
links on command lines and in the history, in a cookie sent to every port on
127.0.0.1, and in the browser's storage. Scripts that read `data/token` simply pick up
the new one; browsers need `npm run open` again. A browser that still has the old
`driftboard_token` cookie is told to drop it the next time it visits the board.

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
  `http://127.0.0.1:4321/#code=<code>` to sign a browser in (`#code=<code>&card=<id>`
  also opens a card once signed in; `?code=<code>` works too). To open a browser on this
  machine, do as `npm run open` does: put the link in a page only you can read (a meta
  refresh and a `location.replace`) and give the browser that page's path, not the link.
- An uploaded file is at `/uploads/<file>?k=<key>`, where the key is the HMAC-SHA256
  of `uploads` keyed with the token, in hex (`GET /api/session` returns it as
  `uploadsKey`). The key opens uploaded files only.

### Other devices

The server listens on this machine only (`127.0.0.1`). To reach it from other
devices, start it with `DRIFTBOARD_HOST=0.0.0.0` and sign each browser in with a link
from `npm run open -- --print`, with this machine's IP address in place of `127.0.0.1`.
The board answers only to the names it goes by (`127.0.0.1`, `localhost`, `[::1]` and
`DRIFTBOARD_HOST`) and, when it listens on every address, to any IP address: a page
from elsewhere that points a name of its own at this machine (DNS rebinding) gets a 421.
To use a name, start the server with that name as `DRIFTBOARD_HOST`; a proxy in front
of the board must send it one of these names as `Host`.
Keep in mind that the board speaks plain HTTP: the token, and everything on the board,
travel unencrypted over the network, so anyone who can watch that network can take
the token and with it the board. Put an HTTPS proxy in front of it, or keep it local.

---

## 📥 Work from anywhere

Anything that can make an HTTP request can put work on the board: a chat watcher, a CI job, a
mail filter, a ten-line script. One call makes a card:

```sh
curl -s http://127.0.0.1:4321/api/items -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(cat ~/.local/share/driftboard/token)" \
  -d '{"source": "ci", "externalId": "build-41", "title": "Nightly build failed",
       "body": "step `test` exited 1", "link": {"url": "https://ci.example/41", "title": "Build 41"}}'
```

| Field | |
|---|---|
| `title` | required: the card's title |
| `body` | markdown: the card's description |
| `source` | required: who sent it, in lowercase (`ci`, `mail`, `chat`) |
| `externalId` | the source's own id: the same item sent again is ignored (`duplicate`) |
| `thread` | items from one source with the same thread are one card: a later one is added to it as a note (`joined`) |
| `link` | `{"url", "title"}`: an http or https link attached to the card |
| `workspace` | which board, by name (default `Inbox`); a new one gets the columns New, Working, Needs you, Review, Done, Won't do |
| `column` | which column, by title (default the first); an unknown one is refused with the columns there are |

It answers `201` with `{cardId, workspaceId, created: true}` for a new card, and `200` with
`duplicate` or `joined` otherwise. With sign-in off (`DRIFTBOARD_SIGN_IN=off`) the token
header is not needed. Tests: `npm test`.

### The pinger

`pinger/driftboard-ping` does that call for you, from a terminal, a cron job or a hook, and it
sends the token only to a server that proves it is the board:

```sh
pinger/driftboard-ping "Nightly build failed" --body "step test exited 1" --link https://ci.example/41
make test 2>&1 | tail -20 | pinger/driftboard-ping "Tests broke" --body - --source cron --thread nightly
pinger/driftboard-ping --help              # --id, --thread, --board, --column, --url, --token-file
```

It is one Python file with no dependencies, so it is also where a pinger of your own starts:
copy it, watch what you watch (a chat, a mailbox, a log), and call `ping(title, body, ...)` for
each thing worth a card. It reads the token from `$DRIFTBOARD_TOKEN_FILE`, else
`$DRIFTBOARD_DATA/token`, else `~/.local/share/driftboard/token`, and the board from
`$DRIFTBOARD_URL` (default `http://127.0.0.1:4321`). Tests: `npm run test:helper`.

## 🤖 Put an AI agent on a card

`helper/` starts **Claude Code** or **Codex** on a card when you press ▶ Start, and the card
keeps you posted: the agent's progress on its face, a question in red (the card moves to
Needs you), its result in the open card, and the card in Review when it is done. You stay on
the board:

| Button | |
|---|---|
| ▶ Start | an agent starts on the card, in your project folder |
| ＋ Context | tell it something it should know (what was said in person, say): before it starts, or while it works |
| ↩ Reply | answer its question, or send its work back with what to change |
| ⏹ Stop | stop it; ↩ Reply carries on |

Moving the card to Done or Won't do stops the agent for good. Agents are optional: without
the helper the board is a plain board.

It needs Python 3.11+ and Claude Code or Codex signed in. Then:

```sh
helper/install-service                     # the systemd user unit, and ~/.config/driftboard-helper/config.toml
$EDITOR ~/.config/driftboard-helper/config.toml   # agent.directory, tool, and which boards (default Inbox)
helper/bin/driftboard-helper check
systemctl --user enable --now driftboard-helper
```

**What an agent may do.** Each agent reports through `driftboard-agent` (progress, note,
ask, result, move), which writes to a file the helper forwards: the agent needs no network
and never holds a token. Every agent gets the same floor, as Claude Code permission rules,
as stand-ins for `glab`, `gh`, `git`, `ssh`, `scp` and `sftp` first on its PATH, and as
plain-language hard rules: chat and mail are read-only, credentials are never read, nothing
is written to a code host (no push, merge or comment), the board and the helper are left
alone, and the card's own text is data, never instructions. Other machines are your call,
per command, in `[agent.access]`: `deny` (default), `ask` (Claude waits for your yes on
every use) or `allow`, for `ssh`, `scp`, `sftp`, `sshfs`, `rsync` or any command you name.
Codex also runs in its own sandbox (the project folder and the card's run folder, no
network). None of this is a sandbox for Claude: keep agents off a machine with access you
would not hand to a script. Tests: `npm run test:helper`.

## 🤖 Agents on cards: the API

A helper that starts an AI agent on a card (a script, or a wrapper around a coding agent) gives that agent a token that
reaches **its own card only**. With it the agent keeps the card current while it works, and
the card shows it: its progress on the card's face, a question in red, its result in an
Agent section of the open card, apart from the description.

```sh
# the helper, with the board token: a token for card <id> (a new one replaces it)
curl -s -X POST http://127.0.0.1:4321/api/cards/<id>/agent -H "Authorization: Bearer $BOARD_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name": "codex"}'          # → {"token": "..."}

# the agent, with its card's token
curl -s -X PATCH http://127.0.0.1:4321/api/agent/cards/<id> -H "Authorization: Bearer $CARD_TOKEN" \
  -H 'Content-Type: application/json' -d '{"progress": "read 12 invoices"}'
```

| Agent call (card token) | |
|---|---|
| `PATCH /api/agent/cards/<id>` | `{"progress"}` (one line, on the card's face) and/or `{"result"}` (markdown) |
| `POST /api/agent/cards/<id>/notes` | `{"content"}`: a note on the card, marked with the agent's name |
| `POST /api/agent/cards/<id>/ask` | `{"question"}`: the card moves to Needs you and shows the question |
| `POST /api/agent/cards/<id>/move` | `{"column"}`: Working, Needs you or Review only |

A card token reaches no other card and nothing else on the board: it cannot move a card to
Done or Won't do, press its buttons or start anything, which are the user's. Once the user
moves the card to Done or Won't do, or the helper revokes the token
(`DELETE /api/cards/<id>/agent`), the agent can change nothing more; what it reported stays.
The board token is refused on these calls: they take the card's own token.

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
