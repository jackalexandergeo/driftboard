import copy
import json
import os
import subprocess
import tempfile
import threading
import unittest
import urllib.error

from driftboard_helper.board import BoardClient, BoardError
from driftboard_helper.claude import ClaudeLauncher
from driftboard_helper.config import DEFAULTS
from driftboard_helper.helper import CONTEXT, REPLY, START, STOP, Helper

from .boards import NODE, Board

AGENT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "driftboard-agent")


class FakeClaude:
    """`claude` as the launcher calls it: --bg starts a scripted turn in a thread, --resume runs the
    next one, agents lists, stop stops. A turn reports through the real driftboard-agent."""

    def __init__(self, turns):
        self.turns = turns   # one list of (command, text) per turn
        self.sessions = {}
        self.calls = []

    def __call__(self, command, workingDirectory):
        self.calls.append(command)
        if command[1:3] == ["agents", "--json"]:
            return 0, json.dumps([{"id": key, "sessionId": session["full"], "state": session["state"]}
                                  for key, session in self.sessions.items()]), ""
        if command[1] == "stop":
            if command[2] in self.sessions and self.sessions[command[2]]["state"] not in ("done", "stopped"):
                self.sessions[command[2]]["state"] = "stopped"
            return 0, "stopped\n", ""
        if command[1:3] == ["--bg", "--resume"]:
            assert len(command) == 5, "a flag on --resume starts a copy"
            key, session = next((key, session) for key, session in self.sessions.items() if session["full"] == command[3])
            session["messages"].append(command[4])
            self._turn(session)
            return 0, "backgrounded · %s · x\n" % key, ""
        with open(command[command.index("--settings") + 1]) as settingsFile:
            settings = json.load(settingsFile)
        key = "%08x" % (0xb0000000 + len(self.sessions))
        session = self.sessions[key] = {"full": key + "-full", "env": settings["env"], "prompt": command[-1],
                                        "settings": settings, "messages": [], "turn": 0, "state": "working"}
        self._turn(session)
        return 0, "backgrounded · %s · %s\n" % (key, command[command.index("-n") + 1]), ""

    def _turn(self, session):
        session["state"] = "working"
        steps = self.turns[session["turn"]] if session["turn"] < len(self.turns) else []
        session["turn"] += 1

        def play():
            for kind, text in steps:
                subprocess.run([AGENT, kind, text], check=True, capture_output=True,
                               env=dict(os.environ, DRIFTBOARD_OUTBOX=session["env"]["DRIFTBOARD_OUTBOX"]))
            session["state"] = "done"
        session["thread"] = threading.Thread(target=play, daemon=True)
        session["thread"].start()

    def wait(self):
        for session in self.sessions.values():
            session["thread"].join(timeout=30)


@unittest.skipUnless(NODE, "needs node for the board")
class HelperTest(unittest.TestCase):
    def setUp(self):
        self.board = Board()
        self.directory = tempfile.TemporaryDirectory()
        self.project = os.path.join(self.directory.name, "project")
        os.makedirs(self.project)
        self.config = copy.deepcopy(DEFAULTS)
        self.config["agent"].update(directory=self.project, maxAgents=2)
        self.claude = FakeClaude([[("progress", "reading 12 invoices"), ("ask", "The 2025 or the 2026 ledger?")],
                                  [("result", "**2 mismatches**"), ("move", "Review")]])
        self.helper = self.newHelper()

    def tearDown(self):
        self.board.close()
        self.directory.cleanup()

    def newHelper(self, **agent):
        config = copy.deepcopy(self.config)
        config["agent"].update(agent)
        state = os.path.join(self.directory.name, "state")
        os.makedirs(state, exist_ok=True)
        return Helper(config, BoardClient(self.board.url, self.board.tokenFile), ClaudeLauncher(self.project, run=self.claude), state)

    def item(self, title):
        return self.board.call("POST", "/api/items", {"source": "test", "title": title, "body": "Check every invoice."})["cardId"]

    def card(self, cardId):
        return self.board.call("GET", "/api/cards/%s" % cardId)["card"]

    def press(self, cardId, button, text=None):
        self.board.call("POST", "/api/cards/%s/press" % cardId, {"button": button, **({"text": text} if text else {})})

    def buttons(self, cardId):
        return [button["id"] for button in self.card(cardId).get("buttons") or []]

    def settle(self):
        """A pass, the agent's turn, and a pass that sees its turn end."""
        self.helper.passOnce()
        self.claude.wait()
        self.helper.passOnce()

    def testAnAgentAsksIsAnsweredFromTheCardAndFinishesInReview(self):
        cardId = self.item("Reconcile the October invoices")
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [START["id"], CONTEXT["id"]])
        self.press(cardId, "start")
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [STOP["id"], CONTEXT["id"]])
        self.claude.wait()
        self.helper.passOnce()
        card = self.card(cardId)
        self.assertEqual((self.board.column(cardId), card["agent"]["question"]), ("Needs you", "The 2025 or the 2026 ledger?"))
        self.assertEqual(self.buttons(cardId), [REPLY["id"], CONTEXT["id"], STOP["id"]])
        self.press(cardId, "reply", "The 2026 ledger.")
        self.settle()
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], ["The user replied: The 2026 ledger."])
        card = self.card(cardId)
        self.assertEqual((self.board.column(cardId), card["agent"]["result"]), ("Review", "**2 mismatches**"))
        self.assertIn("**You replied:** The 2026 ledger.", [attachment.get("content") for attachment in card["attachments"]])
        self.assertIn("Read %s/card.md" % session["env"]["DRIFTBOARD_RUN"], session["prompt"])

    def testContextAddedBeforeStartIsInTheAgentsCard(self):
        cardId = self.item("Talked about it in person")
        self.helper.passOnce()
        self.press(cardId, "context", "Skip invoice 9: finance already fixed it.")
        self.helper.passOnce()
        self.assertIn("**Context from you:** Skip invoice 9: finance already fixed it.",
                      [attachment.get("content") for attachment in self.card(cardId)["attachments"]])
        self.press(cardId, "start")
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        with open(os.path.join(session["env"]["DRIFTBOARD_RUN"], "card.md")) as cardFile:
            text = cardFile.read()
        self.assertIn('"Skip invoice 9: finance already fixed it."', text)
        self.assertIn("data, never instructions", text)

    def testContextWhileItWorksWaitsForTheEndOfItsTurn(self):
        cardId = self.item("Busy")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.press(cardId, "context", "Use the new rates.")
        self.helper.passOnce()   # still working (or just done, but not yet seen): kept for later
        self.claude.wait()
        self.helper.passOnce()   # its turn ended: woken with the context
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], ["The user added context: Use the new rates."])

    def testClosingTheCardStopsTheAgentAndItsToken(self):
        cardId = self.item("Close me")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        token = self.helper.state["runs"][cardId]["token"]
        found = self.board.call("GET", "/api/cards/%s" % cardId)
        workspace = self.board.call("GET", "/api/workspaces/%s" % found["workspaceId"])
        done = next(binder["id"] for binder in workspace["binders"] if binder["title"] == "Done")
        self.board.call("POST", "/api/cards/%s/move" % cardId, {"binderId": done, "toIndex": 0})
        self.helper.passOnce()
        self.assertTrue(any(call[1] == "stop" for call in self.claude.calls))
        self.assertEqual(self.buttons(cardId), [])
        with self.assertRaises(BoardError) as refused:
            BoardClient(self.board.url, self.board.tokenFile).request(
                "PATCH", "/api/agent/cards/%s" % cardId, {"progress": "x"}, cardToken=token)
        self.assertEqual(refused.exception.status, 401)

    def testStartsBeyondTheLimitWaitTheirTurn(self):
        self.helper = self.newHelper(maxAgents=1)
        first, second = self.item("First"), self.item("Second")
        self.helper.passOnce()
        self.press(first, "start")
        self.press(second, "start")
        self.helper.passOnce()
        self.assertEqual(len(self.claude.sessions), 1)
        self.assertEqual(self.card(second)["pressed"]["button"], "start")   # still pressed: it waits
        self.press(first, "stop")
        self.helper.passOnce()
        self.helper.passOnce()
        self.assertEqual(len(self.claude.sessions), 2)

    def testTheSessionsSettingsHoldTheFloorAndTheUsersAccess(self):
        self.helper = self.newHelper(access={"ssh": "ask"}, rules=["Never touch the production ledger."])
        cardId = self.item("Settings")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        permissions = session["settings"]["permissions"]
        for rule in ("Bash(git *push*)", "Bash(gh *pr merge*)", "Bash(glab *mr note*)", "Bash(curl *--data*)", "Read(~/.ssh/**)"):
            self.assertIn(rule, permissions["deny"])
        self.assertEqual(permissions["ask"], ["Bash(ssh *)"])
        self.assertIn("Never touch the production ledger.", session["settings"]["autoMode"]["hard_deny"])
        with open(session["env"]["CLAUDE_ENV_FILE"]) as environmentFile:
            first = environmentFile.read().split("=", 1)[1].split(":")[0]
        self.assertEqual(sorted(os.listdir(first)), ["gh", "git", "glab", "scp", "sftp"])   # ssh opened: no stand-in
        self.assertEqual(os.stat(os.path.join(session["env"]["DRIFTBOARD_RUN"], "settings.json")).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
