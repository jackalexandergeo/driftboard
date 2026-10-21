# Bootstrap: the board and its agents

**For an AI assistant (Claude Code, Codex or similar).** The user hands you this file and
says "set this up for me". It sets up, on their own Linux machine:

1. **The board**: a kanban board in their browser, kept on this machine only.
2. **The helper**: ▶ Start on a card starts an AI agent on it, Claude Code or Codex (whichever
   they use). The agent keeps the card current, turns it red when it needs them, and talks to
   them in the card's chat.
3. **A pinger**: anything that should become a card (a chat, a mailbox, a CI job) is posted to
   the board's Inbox. The bundled `pinger/driftboard-ping` is the first one, and the template
   for their own.

Read this whole file first, then do the steps in order. Where a step says **Ask**, ask the
user and wait. Every value in their config comes from their answers or their own machine.

## Rules for you while you set this up

- **Show every config before you write it**, and write it only once they say yes. If a file is
  there already, show the difference and back the old one up first.
- **The user runs the installers, not you.** They install services that start agents, and
  Claude Code's auto mode refuses them for that (it reads `install-service` as setting up an
  agent runner). So do the checks and write the configs yourself, then hand them each install or
  start command as a `! <command>` line to type in the prompt (Claude Code runs it in this
  session; elsewhere they run it in a terminal), wait, and check the result yourself. Steps 4
  and 5 mark these lines with `!`.
- **Do not start an agent yourself.** The user presses ▶ Start, in step 6. An agent spends their
  AI plan.
- **Never print the board's token or items key**, and never put either on a command line
  (other users of the machine can read every command line). The scripts read them from files.
- Do not commit to, push or change this repository. This is an install.
- Do not log the user out or restart their desktop.

## 1. Check what is needed

Run each check. Stop and tell the user what is missing before going on.

| Needed | Check | If missing |
|---|---|---|
| Linux with a systemd user session | `systemctl --user show-environment` | without it the board and helper run by hand (step 4 prints how) |
| Node.js 18 or newer | `node --version` | the board needs it |
| Python 3.11 or newer | `python3 -c 'import tomllib'` | the helper needs it; the board alone does not |
| git | `git --version` | install git |
| Claude Code, signed in | `claude --version`, then `claude agents --json` answers | the user installs it and runs `! claude` once to sign in |
| or Codex, signed in | `codex --version` and `codex login status` | the user runs `! codex login` |

One of Claude Code or Codex is enough. Without either, the board works on its own (no ▶ Start).

## 2. Get it

    git clone https://github.com/jackalexandergeo/driftboard.git ~/driftboard
    cd ~/driftboard && npm install
    npm test && npm run test:helper        # about three minutes; both should pass

## 3. Ask

Ask one question at a time, offering the default:

1. **Does anyone else log into this machine?** If yes, keep the board's sign-in (the default):
   a browser signs in with `npm run open`, or a PIN they set. If nobody else ever does, the
   board can open without sign-in (`--no-sign-in` in step 4); then every account on the machine
   could read the board and press its buttons, which start agents.
2. **Which tool runs the agents** (`agent.tool`): `claude` or `codex`, from what step 1 found.
3. **The project folder agents start in** (`agent.directory`). Not the home folder. Agents read
   and edit files there.
4. **Folders agents must never read** (private notes, personal files). Each becomes a line in
   `agent.rules`, for example `"Never read ~/private: it is the user's private workspace."`
5. **Other machines** (`[agent.access]`): for `ssh`, `scp`, `sftp`, `sshfs`, `rsync`, or any
   command they name: `deny` (the default), `ask` (each use waits for their yes; Claude only)
   or `allow` (at their own risk).
6. **What agents hold back** (`[agent.limits]`): `chat` (sending messages), `codeHost` (MRs,
   issues, comments), `push`, `http` (requests that change something), `credentials`. Each is
   `never` (whatever is said), `ask` (the default; `credentials` is `never`) or `allow`.
   With Claude, `ask` means each such command waits for their yes. Codex cannot stop and ask,
   so with Codex `ask` means the agent holds back unless they tell it otherwise in the card's chat.
7. **Git hosts** (`agent.gitHosts`): hosts git may reach over ssh, for example `github.com`.
   Fetching is always allowed there; pushing follows `push` above.
8. **Agents at once** (`agent.maxAgents`, default 1). Every agent works in the same project
   folder, so more than one only makes sense for cards that do not edit files there.
9. **Their terminal app** (`[terminal] app`), for ↗ Open in a window: leave it empty for their
   system's default, or name the one they use (`"terminator"`, `"kitty"`, …).

## 4. Install the board

The user types these (see the rules):

    ! ~/driftboard/install-service          # add --no-sign-in if that was their answer to question 1

It checks Node, Python and the tools, installs `driftboard.service` and
`driftboard-helper.service` as systemd user units (keeping any unit it did not write), writes
a starter helper config, and prints what to run next. Then:

    ! systemctl --user enable --now driftboard
    systemctl --user is-active driftboard     # active
    npm --prefix ~/driftboard run open        # opens the board, signed in (with sign-in on)

Without sign-in, they open `http://127.0.0.1:4321/` themselves. The board keeps its data in
`~/.local/share/driftboard`.

## 5. Write the helper's config

Fill `~/.config/driftboard-helper/config.toml` from their answers, **print it in the chat**,
and write it only once they say yes (step 4 wrote a starter one; it is private to them):

```toml
intervalSeconds = 3

[board]
url = "http://127.0.0.1:4321"
tokenFile = "~/.local/share/driftboard/token"
workspaces = ["Inbox"]

[agent]
tool = "<claude or codex>"          # question 2
directory = "<project folder>"      # question 3
maxAgents = 1                       # question 8
gitHosts = []                       # question 7
rules = []                          # question 4

[agent.access]                      # question 5; leave out what stays "deny"

[agent.limits]                      # question 6; leave out what stays "ask"

[terminal]
app = ""                            # question 9
```

Then check it, and have the user start the helper:

    ~/driftboard/helper/bin/driftboard-helper check
    ! systemctl --user enable --now driftboard-helper     # the user types this

`check` says what is in the way and how to fix it. Until step 6 it says the Inbox is missing:
the Inbox appears with the first card.

## 6. Test it end to end

Put a first card on the board with the pinger:

    ~/driftboard/pinger/driftboard-ping "Try an agent: list the top-level folders of the project folder and say which are git repositories" --source bootstrap

**Ask** the user to open the board: the card is in the Inbox's New column with ▶ Start and
＋ Context. They press ▶ Start. Within a few seconds the card says the agent started; then its
progress shows on the card, its answer in the open card, and the card moves to Review. They
can write to the agent in the card's chat at any time. When they are happy, they move the card
to Done, which stops the agent for good.

While the agent works, the open card offers its terminal: **⌨ Terminal** shows the live
session over the card, and **↗ Open in a window** opens it in their terminal app. They can
answer a command it waits on there, or type to it. Closing either leaves the agent running. If
it says it could not start, the card says why.

## 7. Their own pinger

A pinger is any script that posts items to the board. Show them the README's "Work from
anywhere": the bundled pinger, the items key it uses (`~/.local/share/driftboard/items-key`,
which can only add cards), and how to write one in any language. A start that often fits:
copy `pinger/driftboard-ping`, and call its `ping(title, body, source=..., externalId=...,
thread=..., link=...)` for each thing worth a card, from a loop or a cron job. The same
`externalId` sent twice makes one card; items with the same `thread` gather on one card.

## What it never does

- Nothing leaves the machine: the board listens on this machine only, and refuses requests
  from other web sites.
- Agents report through a file the helper forwards: they hold no token and need no network
  for it. A card's token reaches that card only, and only until the card is closed.
- Agents run under permission rules, stand-in commands first on their PATH, and plain hard
  rules: credentials are never read, and what `[agent.limits]` holds back stays held back.
  None of it is a sandbox: keep agents off a machine with access they would not hand to a
  script.

## When something is off

| Symptom | Look at |
|---|---|
| an install is refused (auto mode) | expected: the user runs it as a `! <command>` line (see the rules) |
| `check` names a problem | it says the fix: install or sign in to the tool, start the board, add the Inbox (step 6) |
| the board asks to sign in | open it with `npm --prefix ~/driftboard run open`, not by typing the address |
| ▶ Start does nothing | the helper is not running: `systemctl --user status driftboard-helper`; after a minute the button says so |
| the card says it could not start | the tool is missing or signed out: `claude` / `codex login` |
| the card waits for their yes | `claude attach <id>`, the id the card names |
| the board does not start | `journalctl --user -u driftboard`; an unreadable `board.json` is set aside and the last good copy (`board.json.bak`) is used |
| logs | `journalctl --user -f -u driftboard -u driftboard-helper` |
