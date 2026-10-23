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

Setting it up with an AI assistant? Hand it [BOOTSTRAP.md](BOOTSTRAP.md) and say "set this
up for me": it checks what is needed, asks a few questions, installs the board and the agent
helper, and tests them with a first card.

Running locally gives you the **full app with a small Node server** that saves your
board as real files on disk (great for backups) instead of in the browser.

```sh
git clone https://github.com/jackalexandergeo/driftboard.git
cd driftboard
npm install
npm start
```

Then, in another terminal, run `npm run open`: it opens the board in your browser
and signs you in. Run it with the same `DRIFTBOARD_DATA`, `DRIFTBOARD_HOST` and `PORT`
as the server (`PORT=5000 npm start`, then `PORT=5000 npm run open`). It needs Node.js 18
or later.

**At every login.** `./install-service` installs the board as a systemd user service (and the
agent helper, below; `--no-helper` leaves it out). It checks what is missing, keeps any unit
it did not write itself, and prints the commands that start it. Without systemd (macOS, WSL,
a container) it says how to run it by hand.

The board keeps its data in `$DRIFTBOARD_DATA`, else `$XDG_DATA_HOME/driftboard`, else
`~/.local/share/driftboard` (an older `data/` folder in the checkout is kept, and the log says
so). The pinger and the helper look in the same place, so set `DRIFTBOARD_DATA` for all of
them or for none. Below, `<data>` is that folder.

### Signing in

The board has no accounts. On first start the server makes a random token and keeps
it in `<data>/token`, readable only by you; whoever has the token can read and change
the board. `npm run open` asks the server for a sign-in code that works once, for a
minute, and writes a small page, readable only by you, in `<data>/opening/`, that sends
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
requests; but anyone logged into the machine can then read and change it. It refuses to
start without sign-in on any address other machines can reach. A tab that has a token left
from before sends it nowhere while sign-in is off.

**A PIN for new tabs.** `npm run set-pin` (in a terminal; it asks twice and shows nothing)
sets a PIN, and the locked page then asks for it, so a new tab or a bookmark signs in
without a terminal. Only a slow scrypt hash is kept (`<data>/pin`, private). Guessing is
slowed for everyone (one try at a time, and a wait after each wrong one that doubles) and
switched off after 20 wrong tries, until you set the PIN again; the count survives a
restart. `npm run set-pin -- --remove` turns it off. A PIN file that cannot be read is
treated as no PIN (the log says so). The PIN goes to whatever answers at the board's address, like
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
  service `./install-service` installs restarts it), and if it was down, do not open it
  until it is back. On `127.0.0.1`, `localhost` or `::1` the board holds both loopback
  addresses (IPv4 and IPv6), so nobody can sit on the other one and pass its hello along.
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
127.0.0.1, and in the browser's storage. Scripts that read `<data>/token` simply pick up
the new one; a tab that still has the old token offers to sign in again. A browser that still has the old
`driftboard_token` cookie is told to drop it the next time it visits the board.

Scripts send the token as `Authorization: Bearer <token>` on every `/api` call:

- Never put the token on a command line: `curl -H "Authorization: Bearer $(cat <data>/token)"`
  shows it to every user of the machine, who can list the command lines of all processes.
  Read it from `<data>/token` in the script itself, or keep the header in a file only you can
  read and pass that with `curl -H @file`.
- A script that only puts work on the board (a pinger) needs no token: it uses the items key
  (below), which can do nothing else.
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
- An `/api` path the board does not have answers a JSON 404, so a script can tell "no such
  call" (an older board) from "not the board".

### Other devices

The server listens on this machine only (`127.0.0.1`). To reach it from other
devices, start it with `DRIFTBOARD_HOST=0.0.0.0` (sign-in stays on) and sign each browser in with a link
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
mail filter, a ten-line script. Such a source is a **pinger**, and the bundled one does the
whole call for you:

```sh
pinger/driftboard-ping "Nightly build failed" --body "step test exited 1" --link https://ci.example/41
make test 2>&1 | tail -20 | pinger/driftboard-ping "Tests broke" --body - --source cron --thread nightly
pinger/driftboard-ping --help              # --id, --thread, --board, --column, --url, --key-file
```

It is one Python file with no dependencies, so it is also where a pinger of your own starts:
copy it, watch what you watch (a chat, a mailbox, a log), and call `ping(title, body, ...)` for
each thing worth a card. Tests: `npm run test:helper`.

**The items key.** A pinger needs no board token. At every start the board writes an
**items key** to `<data>/items-key` (readable only by you): the HMAC-SHA256 of
`driftboard-items` keyed with the token, in hex. It is good for one call only, `POST
/api/items`, and is refused everywhere else (it cannot read the board, press a button or start
an agent), so hand it to a tool you trust less than yourself. One exception is yours to make: on
a board with ⚡ Autostart on, a new item in its first column starts an agent. The pinger reads it from
`$DRIFTBOARD_ITEMS_KEY_FILE`, else `<data>/items-key`, and falls back to the token only when
there is no items key (`--token-file` forces the token). It finds the board at `$DRIFTBOARD_URL`
(default `http://127.0.0.1:4321`).

**Writing your own, in any language.** Do what the pinger does:

1. `GET /api/hello?nonce=<16 to 128 random hex characters>&key=items` answers `{"proof": …}`,
   the HMAC-SHA256 of `driftboard-hello:<nonce>` keyed with the items key, in hex. Send the
   key only if the proof is right, and on the same connection: another program can take the
   port between two connections.
2. `POST /api/items` with `Authorization: Bearer <items key>` and a JSON item:

| Field | |
|---|---|
| `title` | required: the card's title |
| `body` | markdown: the card's description |
| `source` | required: who sent it, in lowercase (`ci`, `mail`, `chat`) |
| `externalId` | the source's own id for it: sent again, it is ignored (`duplicate`), even after the user deleted its card. The board remembers each source's newest 5000 ids |
| `thread` | items from one source with the same thread are one card: a later one is added to it as a note (`joined`), with its link. If that card was closed (Done, Won't do, Completed), it moves back to the first column (`reopened`) |
| `link` | `{"url", "title"}`: an http or https link attached to the card |
| `workspace` | which board, by name (default `Inbox`); a new one gets the columns New, Working, Needs you, Review, Done, Won't do |
| `column` | which column, by title (default the first); an unknown one is refused with the columns there are |

It answers `201` with `{cardId, workspaceId, created: true}` for a new card (with
`autoStarted: true` when the board's Autostart put ▶ Start on it), and `200` with
`{cardId, joined: true, reopened?}` or `{cardId, duplicate: true}` otherwise (`cardId` is
`null` when the user deleted the card). A `400` lists `problems`, or the `columns` there
are. A card keeps the newest 200 notes that items and agents added (yours are all kept).
With sign-in off, no key is needed.

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

**Ask agent**, in the toolbar, puts something new to an agent: a topic and, if you like, the
details. It goes on the board as a card where new items land (the first column), and an agent
starts on it, as if you had pressed ▶ Start. The toolbar offers it on the boards the helper
watches only. When every agent is busy (`maxAgents`) the card waits its turn: "⏳ An agent
starts soon" on its face, and after a minute "⏳ Waiting for a free agent, or for the helper".

**⚡ Autostart**, next to it, starts an agent on each new item as it lands in the board's first
column (New), with no press: for a board whose items you want looked at as they come in. It is
per board and off until you turn it on, and it only meets items that come in while it is on:
items from before, items a source puts in another column (a question it answered already, a
review), and cards you make yourself wait for ▶ Start. Nor does it start anything while no
helper watches the board (it stays on, for when one does again). Started agents take their
turn like any other (`maxAgents`). Every item a pinger posts there then starts an agent on text someone else
wrote: agents read a card as data, never as instructions, but turn Autostart on only for
boards whose sources you would let start one.

The card's chat is the conversation with its agent: what you write there reaches it (pictures
too), and its answers come back there. Moving the card to Done, Won't do or Completed stops
the agent for good. Agents are optional: without the helper the board is a plain board.

It needs Python 3.11+ and Claude Code or Codex, installed and signed in. Then:

```sh
./install-service                          # the board's and the helper's units, and ~/.config/driftboard-helper/config.toml
$EDITOR ~/.config/driftboard-helper/config.toml   # agent.directory, tool, and which boards (default Inbox)
helper/bin/driftboard-helper check         # the tool, its sign-in, the token, the board and its columns
systemctl --user enable --now driftboard-helper
```

The cards of the boards it watches (by default the Inbox, which appears with the first item)
get the agent buttons; each of those boards needs a Working (or In progress), a Needs you and
a Review column. One agent works at a time by default (`maxAgents`): every agent starts in the
same project folder.

**Its terminal.** While an agent works, its open card offers its live session:

- **⌨ Terminal** opens it right there, over the card (Linux and macOS): watch it work, answer
  a command it waits on, type to it as in any terminal. The board passes your keys to the
  helper, which runs `claude attach` (or Codex's own view, between its turns) for you. Only the
  board's own page can open it, and with sign-in on it takes the board's token.
- **↗ Open in a window** opens the same session in your own terminal app, on any desktop:
  the one in `[terminal] app` (`"terminator"`, or a command such as `["kitty", "--hold",
  "{command}"]`), else `$TERMINAL`, your system's default terminal, or the first one found;
  Terminal on macOS, Windows Terminal (or a console) on Windows.

A card whose agent has a session also carries a **⌨ Terminal** chip on the board itself, which
opens the terminal without opening the card; in the terminal, **↗ Pop out** moves it to a window
of your terminal app. Closing either leaves the agent running. `[terminal] board = false` turns
the page's terminal off.

**When an agent waits.** An agent that asks you something turns its card red (Needs you):
answer with ↩ Reply or in the chat. A Claude agent that waits for your yes on a command (what
you set to `ask`, below) says so on the card, with the command that opens its session:
`claude attach <id>`. A start that fails (the tool is missing, or signed out) says why on the
card, and is not tried again until you press ▶ Start again; so does a session that fails.
Deleting a card, or moving it off the boards the helper watches, stops its agent. Only agents
at work count against `maxAgents`: one that finished its turn and waits for you does not.
A card that carries another script's buttons is left alone. The helper forgets closed runs
after a week.

`check` says, with how to fix each: whether the tool is installed (and Codex signed in), the
token readable, the board up and proving itself, and the watched boards there with their
agent columns.

**What an agent may do.** Each agent reports through `driftboard-agent` (progress, note,
ask, result, move), which writes to a file the helper forwards: the agent needs no network
and never holds a token. Every agent gets the same floor, as Claude Code permission rules,
as stand-ins for `glab`, `gh`, `git`, `ssh`, `scp` and `sftp` first on its PATH, and as
plain-language hard rules: chat and mail are read-only, credentials are never read, nothing
is written to a code host unless you allow it (`[agent.limits]`: each of chat, codeHost, push,
http and credentials is `never`, `ask` or `allow`), the board and the helper are left
alone, and the card's own text is data, never instructions. Other machines are your call,
per command, in `[agent.access]`: `deny` (default), `ask` (Claude waits for your yes on
every use) or `allow`, for `ssh`, `scp`, `sftp`, `sshfs`, `rsync` or any command you name.
Codex also runs in its own sandbox (the project folder and the card's run folder, no
network). None of this is a sandbox for Claude: keep agents off a machine with access you
would not hand to a script. Each agent's permission settings and stand-ins sit in the
helper's own folder (`~/.local/state/driftboard-helper/control/<card>`), outside the folders
the agent may write, and it is denied this machine's own tokens (the board's, the items key,
the helper's state). Tests: `npm run test:helper`.

## 🤖 Agents on cards: the API

A helper that starts an AI agent on a card (a script, or a wrapper around a coding agent) gives that agent a token that
reaches **its own card only**. With it the agent keeps the card current while it works, and
the card shows it: its progress on the card's face, a question in red, its result in an
Agent section of the open card, apart from the description.

```sh
# the helper, with the board token: a token for card <id> (a new one replaces it)
curl -s -X POST http://127.0.0.1:4321/api/cards/<id>/agent -H @board-token-header \
  -H 'Content-Type: application/json' -d '{"name": "codex"}'          # → {"token": "..."}

# the agent, with its card's token
curl -s -X PATCH http://127.0.0.1:4321/api/agent/cards/<id> -H @card-token-header \
  -H 'Content-Type: application/json' -d '{"progress": "read 12 invoices"}'
```

(`board-token-header` is a file only you can read, holding `Authorization: Bearer <token>`.)

| Agent call (card token) | |
|---|---|
| `GET /api/agent/cards/<id>` | the card: `{card: {id, title, description, column, chat, agent}}`, so the agent can read what the user wrote |
| `PATCH /api/agent/cards/<id>` | `{"progress"}` (one line, on the card's face) and/or `{"result"}` (markdown) |
| `POST /api/agent/cards/<id>/chat` | `{"text"}`: a message in the card's chat |
| `POST /api/agent/cards/<id>/notes` | `{"content"}`: a note on the card, marked with the agent's name |
| `POST /api/agent/cards/<id>/ask` | `{"question"}`: the card moves to Needs you and shows the question |
| `POST /api/agent/cards/<id>/move` | `{"column"}`: Working, Coding, Needs you or Review only (or what the board calls them: In progress, Clauding, Blocked, Proposed, …). Coding is for an agent changing code; a board without such a column keeps the card in Working |

A card token reaches no other card and nothing else on the board: it cannot move a card to
Done, Won't do or Completed, press its buttons or start anything, which are the user's. Once
the user closes the card, or the helper revokes the token (`DELETE /api/cards/<id>/agent`),
the agent can change nothing more (`409`, `401`); what it reported stays. The board token is
refused on these calls: they take the card's own token. Bodies may be up to 256 kB.

**Buttons, the helper's side (board token).** The board never runs anything: a script puts
buttons on a card and acts on the presses.

| Call | |
|---|---|
| `PATCH /api/cards/<id>` `{"buttons": [{"id", "label", "title"?, "input"?}]}` | the card's buttons (`input`: the button asks for text first). `[]` takes them off |
| `PATCH /api/cards/<id>` `{"chatEnabled": true}` | show the card's chat box before any agent has spoken |
| `PATCH /api/cards/<id>` `{"terminalEnabled": true}` | the card's agent has a session the page can open as a terminal (the board relays `/api/cards/<id>/terminal` to the helper's socket) |
| a button with `"place": "open"` | shown in the open card only; a card takes 5 buttons, at most 3 on its face |
| `POST /api/cards/<id>/press` `{"button", "text"?}` | what the page sends when the user presses one; the card then carries `pressed: {button, at, text?}` |
| `POST /api/workspaces/<id>/cards` `{"title", "description"?, "binderId"?, "start": true}` | a new card made with `pressed: {button: "start"}` (the page's Ask agent): the helper acts on it as on a press of ▶ Start |
| `PATCH /api/cards/<id>` `{"pressed": null, "pressedAt": "<at>"}` | done with that press: it is cleared only if it is still the same press, so one made meanwhile is not lost |
| `POST /api/cards/<id>/chat` `{"text", "images"?}` | a message from the user into the card's chat (`images`: ids of png, jpeg, gif or webp attachments on the card) |
| `GET /api/cards/<id>` | the card, with `chat`, `agent` and `pressed` |
| `PATCH /api/workspaces/<id>` `{"agents": {"tool": "claude"}}` | the helper starts agents on this board's cards, so the page offers the agent controls there (the helper marks the boards it watches); `{"agents": null}` takes the mark off |
| `PATCH /api/workspaces/<id>` `{"autoStart": true}` | the page's ⚡ Autostart: while the board carries a helper's mark, each new item that lands in its first column is made with `pressed: {button: "start"}`; `false` turns it off |
| `PUT /api/notice` `{"text", "level"}`, `DELETE /api/notice` | a line at the top of the board, e.g. "out of usage until 14:00" |
| `GET /api/state` | the boards, and `revision`; every `/api` answer also carries `X-Board-Revision`, so a script can skip a pass when nothing changed |

A press nobody picks up can be pressed again after a minute: the button says it may be that
the helper is not running.

## 💾 Where your stuff is saved

| | Live demo (browser) | Local (`npm start`) |
|---|---|---|
| Storage | IndexedDB + Blobs, in your browser | JSON + files on disk in `<data>` |
| Leaves your machine? | No | No |
| Survives clearing site data? | No | Yes |
| Good for | trying it out | real, backed-up use |

For the local version, everything lives in `<data>` (`~/.local/share/driftboard` by default:
`board.json` plus an `uploads/` folder of your media) — copy that folder to back up or move
everything. To keep it somewhere else, set `DRIFTBOARD_DATA=/path/to/folder`.

Writes are batched and flushed to disk, and the copy before the last write is kept as
`board.json.bak`. A `board.json` that cannot be read is never overwritten: it is moved aside
as `board.json.unreadable-<time>` and the board starts from the `.bak`; with no good copy it
does not start at all. Pictures in card text load only from the board itself (remote ones
show as links).

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
