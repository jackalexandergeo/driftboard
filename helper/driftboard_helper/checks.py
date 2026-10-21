"""`driftboard-helper check`: what stands between this machine and a helper that works, each
with how to fix it: the config, the tool (installed, signed in), the board's token, the board
itself, and the boards the helper watches."""

import shutil
import subprocess

from .board import BoardClient, BoardError
from .config import TOOLS, configProblems

# The board's own names for the three columns an agent moves its card among (server.js).
AGENT_COLUMNS = {"Working": ("Working", "Researching", "In progress", "In Progress", "Doing"),
                 "Needs you": ("Needs you", "Blocked"),
                 "Review": ("Review", "Proposed", "In review", "Reviewing")}
TOOL_HINTS = {"claude": "install Claude Code (npm install -g @anthropic-ai/claude-code) and sign in by running `claude`",
              "codex": "install Codex (npm install -g @openai/codex) and sign in with `codex login`"}


def runTool(command):
    """(exit status, what it printed). Tests replace this."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return result.returncode, (result.stdout + result.stderr).strip()


def toolChecks(tool, run, which):
    path = which(tool)
    if not path:
        return [(False, "%s is installed" % tool, "%s is not on PATH: %s" % (tool, TOOL_HINTS[tool]))]
    if tool == "codex":
        status, output = run([path, "login", "status"])
        return [(status == 0, "codex is signed in", output[:200] or "run `codex login`")]
    status, output = run([path, "--version"])
    return [(status == 0, "claude runs (%s)" % (output.splitlines()[0] if output else path),
             output[:200] or TOOL_HINTS["claude"])]


def boardChecks(config, client):
    try:
        client.token()
    except BoardError as error:
        return [(False, "the board's token is readable", "%s: start the board once (it writes its token), and set "
                 "board.tokenFile to the token in its data folder (DRIFTBOARD_DATA)" % error)]
    try:
        listed = client.request("GET", "/api/state")
    except BoardError as error:
        return [(True, "the board's token is readable", ""),
                (False, "the board answers at %s and proves it holds the token" % client.url,
                 "%s: is the board running? (npm start, or systemctl --user status driftboard)" % error)]
    results = [(True, "the board's token is readable", ""), (True, "the board answers at %s" % client.url, "")]
    workspaces = {summary.get("name"): summary.get("id") for summary in listed.get("workspaces") or []}
    for name in config["board"]["workspaces"]:
        if name not in workspaces:
            results.append((False, "the board %r exists" % name,
                            "it is made by the first item posted to it (pinger/driftboard-ping --board %r 'First "
                            "card'), or add it on the board with the columns Working, Needs you and Review" % name))
            continue
        titles = {binder.get("title") for binder in
                  client.request("GET", "/api/workspaces/%s" % workspaces[name]).get("binders") or []}
        missing = [role for role, names in AGENT_COLUMNS.items() if not titles & set(names)]
        results.append((not missing, "the board %r has the agent's columns" % name,
                        "add a column named %s (an agent moves its card there)" % " and ".join(repr(role) for role in missing)))
    return results


def checks(config, run=runTool, which=shutil.which, client=None):
    """[(ok, what was checked, how to fix it)]: everything, even after a problem, so one run shows all."""
    problems = configProblems(config)
    results = [(not problems, "the config", "; ".join(problems))]
    tool = config["agent"].get("tool")
    if tool in TOOLS:
        results += toolChecks(tool, run, which)
    client = client or BoardClient(config["board"]["url"], config["board"]["tokenFile"])
    return results + boardChecks(config, client)


def report(results):
    """The lines to print, and whether everything is fine."""
    lines = ["%s %s%s" % ("✓" if ok else "✗", what, "" if ok else ": %s" % hint) for ok, what, hint in results]
    return lines, all(ok for ok, _what, _hint in results)
