import copy
import json
import os
import subprocess
import tempfile
import threading
import unittest
import unittest.mock
import urllib.error

from driftboard_helper.board import BoardClient, BoardError
from driftboard_helper.claude import ClaudeLauncher, SessionBusy
from driftboard_helper.config import DEFAULTS
from driftboard_helper.helper import CONTEXT, REPLY, RESUME, START, STOP, TERMINAL, Helper, passSafely

from .boards import NODE, Board

AGENT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "driftboard-agent")


class FakeClaude:
    """`claude` as the launcher calls it: --bg starts a scripted turn in a thread, --resume runs the
    next one, agents lists, stop stops. A turn reports through the real driftboard-agent."""

    def __init__(self, turns):
        self.turns = turns   # one list of (command, text) per turn
        self.sessions = {}
        self.calls = []
        self.staleAfterWake = False   # as `claude agents` did live: still listing the turn before as done
        self.failResumes = 0   # this many wakes fail, as when claude cannot be run
        self.failStarts = 0    # this many starts fail, as when claude is not signed in

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
            if self.failResumes:
                self.failResumes -= 1
                return 1, "", "claude: could not resume"
            key, session = next((key, session) for key, session in self.sessions.items() if session["full"] == command[3])
            session["messages"].append(command[4])
            if self.staleAfterWake:
                session["state"] = "done"   # the turn before, still
                return 0, "backgrounded · %s · x\n" % key, ""
            self._turn(session)
            return 0, "backgrounded · %s · x\n" % key, ""
        if self.failStarts:
            self.failStarts -= 1
            return 1, "", "claude: not signed in"
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
        self.now = 1000.0
        self.helper = self.newHelper()

    def tearDown(self):
        self.board.close()
        self.directory.cleanup()

    def newHelper(self, **agent):
        config = copy.deepcopy(self.config)
        config["agent"].update(agent)
        state = os.path.join(self.directory.name, "state")
        os.makedirs(state, exist_ok=True)
        return Helper(config, BoardClient(self.board.url, self.board.tokenFile), ClaudeLauncher(self.project, run=self.claude), state,
                      clock=lambda: self.now, listingGrace=30)

    def item(self, title):
        return self.board.call("POST", "/api/items", {"source": "test", "title": title, "body": "Check every invoice."})["cardId"]

    def card(self, cardId):
        return self.board.call("GET", "/api/cards/%s" % cardId)["card"]

    def press(self, cardId, button, text=None):
        self.board.call("POST", "/api/cards/%s/press" % cardId, {"button": button, **({"text": text} if text else {})})

    def buttons(self, cardId):
        return [button["id"] for button in self.card(cardId).get("buttons") or []]

    def settle(self):
        """A pass, the agent's turn, and a pass that sees its turn end (the stand-in's turns are over
        before a pass can see them working: past the listing grace)."""
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()

    def testAnAgentAsksIsAnsweredFromTheCardAndFinishesInReview(self):
        cardId = self.item("Reconcile the October invoices")
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [START["id"], CONTEXT["id"]])
        self.press(cardId, "start")
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [STOP["id"], CONTEXT["id"], TERMINAL["id"]])
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        card = self.card(cardId)
        self.assertEqual((self.board.column(cardId), card["agent"]["question"]), ("Needs you", "The 2025 or the 2026 ledger?"))
        self.assertEqual(self.buttons(cardId), [REPLY["id"], CONTEXT["id"], TERMINAL["id"], STOP["id"]])
        self.press(cardId, "reply", "The 2026 ledger.")
        self.settle()
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], ["The user replied: The 2026 ledger."])
        card = self.card(cardId)
        self.assertEqual((self.board.column(cardId), card["agent"]["result"]), ("Review", "**2 mismatches**"))
        self.assertIn(("user", "The 2026 ledger."), [(message["from"], message["text"]) for message in card["chat"]])
        self.assertIn(("agent", "question", "The 2025 or the 2026 ledger?"),
                      [(message["from"], message.get("kind"), message["text"]) for message in card["chat"]])
        self.assertIn("Read %s/card.md" % session["env"]["DRIFTBOARD_RUN"], session["prompt"])

    def testContextAddedBeforeStartIsInTheAgentsCard(self):
        cardId = self.item("Talked about it in person")
        self.helper.passOnce()
        self.press(cardId, "context", "Skip invoice 9: finance already fixed it.")
        self.helper.passOnce()
        self.assertIn(("user", "Skip invoice 9: finance already fixed it."),
                      [(message["from"], message["text"]) for message in self.card(cardId)["chat"]])
        self.press(cardId, "start")
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        with open(os.path.join(session["env"]["DRIFTBOARD_RUN"], "card.md")) as cardFile:
            text = cardFile.read()
        self.assertIn('"Skip invoice 9: finance already fixed it."', text)
        self.assertIn("data, never instructions", text)

    def inbox(self):
        listed = self.board.call("GET", "/api/state")["workspaces"]
        return self.board.call("GET", "/api/workspaces/%s" % next(each["id"] for each in listed if each["name"] == "Inbox"))

    def testACardAskedOfAnAgentOnTheBoardStartsOneWithoutAPress(self):
        self.item("Puts the Inbox up")
        inbox = self.inbox()
        cardId = self.board.call("POST", "/api/workspaces/%s/cards" % inbox["id"], {
            "title": "Why did the nightly build slow down?", "description": "Since Tuesday, by about 4 minutes.",
            "binderId": inbox["binders"][0]["id"], "start": True})["id"]
        self.helper.passOnce()
        self.assertEqual(len(self.claude.sessions), 1)
        self.assertEqual((self.board.column(cardId), self.card(cardId).get("pressed")), ("Working", None))
        session = next(iter(self.claude.sessions.values()))
        with open(os.path.join(session["env"]["DRIFTBOARD_RUN"], "card.md")) as cardFile:
            self.assertIn('"Since Tuesday, by about 4 minutes."', cardFile.read())

    def testWithAutostartOnANewItemGetsAnAgentWithoutAPress(self):
        self.item("Came before Autostart")
        self.helper.passOnce()   # marks the Inbox: watched
        self.board.call("PATCH", "/api/workspaces/%s" % self.inbox()["id"], {"autoStart": True})
        cardId = self.item("Nightly build failed")
        further = self.board.call("POST", "/api/items", {"source": "test", "title": "Reviewed already", "column": "Review"})["cardId"]
        self.helper.passOnce()
        self.assertEqual(len(self.claude.sessions), 1)
        self.assertEqual(self.board.column(cardId), "Working")
        self.assertEqual(self.buttons(further), [START["id"], CONTEXT["id"]])

    def testTheCardsChatReachesTheAgentAndItsAnswersComeBack(self):
        # The user: "make the chat feature look like a chat ... interact once the ticket is open".
        self.claude.turns = [[("say", "Starting on the ledger.")], [("say", "Done: 2 mismatches.")]]
        cardId = self.item("Chat with me")
        self.helper.passOnce()
        self.board.call("POST", "/api/cards/%s/chat" % cardId, {"text": "Use the 2026 ledger."})   # before Start
        self.press(cardId, "start")
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        with open(os.path.join(session["env"]["DRIFTBOARD_RUN"], "card.md")) as cardFile:
            self.assertIn('"Use the 2026 ledger."', cardFile.read())   # what was said before Start is context
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        self.board.call("POST", "/api/cards/%s/chat" % cardId, {"text": "How many mismatches?"})
        self.settle()
        self.assertEqual(session["messages"], ["The user says: How many mismatches?"])   # once, not again
        self.helper.passOnce()
        chat = [(message["from"], message["text"]) for message in self.card(cardId)["chat"]]
        self.assertEqual(chat, [("user", "Use the 2026 ledger."), ("agent", "Starting on the ledger."),
                                ("user", "How many mismatches?"), ("agent", "Done: 2 mismatches.")])

    def testAPictureInTheChatReachesTheAgentAsAFileItCanOpen(self):
        # The user: "I pasted an image in, but there was no option to send it does the agent see the image?"
        cardId = self.item("Look at this")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        picture = b"\x89PNG\r\n\x1a\n a screenshot"
        attachment = self.board.upload(cardId, "screenshot.png", "image/png", picture)
        self.board.call("POST", "/api/cards/%s/chat" % cardId, {"text": "", "images": [attachment["id"]]})
        self.settle()
        session = next(iter(self.claude.sessions.values()))
        message, = session["messages"]
        self.assertTrue(message.startswith("The user says: The user put a picture in the chat; open it to see it:\n- "), message)
        path = message.split("\n- ")[1]
        self.assertTrue(path.startswith(os.path.join(session["env"]["DRIFTBOARD_RUN"], "pictures", "")), path)
        with open(path, "rb") as pictureFile:
            self.assertEqual(pictureFile.read(), picture)

    def testAChatMessageReachesAnAgentBlockedOnItsQuestion(self):
        # Live: the agent ended its turn on a question, `claude agents` listed it as blocked, and the
        # user's chat message waited for a turn end that, by the helper's count, never came.
        cardId = self.item("Blocked")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        session = next(iter(self.claude.sessions.values()))
        session["state"] = "blocked"
        self.now += 31
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "idle")
        self.board.call("POST", "/api/cards/%s/chat" % cardId, {"text": "hello, we are testing you"})
        self.helper.passOnce()
        self.assertEqual(session["messages"], ["The user says: hello, we are testing you"])

    def testAStoppedAgentResumesFromItsCard(self):
        # The user: "when i hit stop, theres no resume button".
        cardId = self.item("Stop and go")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.press(cardId, "stop")
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [RESUME["id"], REPLY["id"], CONTEXT["id"]])
        self.claude.wait()
        self.press(cardId, "resume")
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], ["The user pressed Resume: carry on where you left off."])
        self.assertEqual(self.buttons(cardId), [STOP["id"], CONTEXT["id"], TERMINAL["id"]])

    def onThread(self, title, body):
        return self.board.call("POST", "/api/items", {"source": "test", "title": title, "body": body, "thread": "t1"})

    def cardFile(self, session):
        with open(os.path.join(session["env"]["DRIFTBOARD_RUN"], "card.md")) as cardFile:
            return cardFile.read()

    def testALaterPingOnTheCardsThreadReachesItsAgent(self):
        # Live: a colleague's follow-up joined the card as a note while its agent was at work, and the
        # agent, which had read card.md once at its start, finished without it.
        self.claude.turns = [[("say", "On it.")], [("note", "My own finding."), ("say", "Folded in.")], []]
        cardId = self.onThread("Bootstrap snags", "Four snags.")["cardId"]
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()   # its turn is over
        session = next(iter(self.claude.sessions.values()))
        self.assertTrue(self.onThread("Follow-up", "Three more snags.")["joined"])
        self.settle()
        self.assertEqual(len(session["messages"]), 1)
        self.assertTrue(session["messages"][0].startswith("New on the card from its source, test"))
        self.assertIn("Three more snags.", session["messages"][0])
        self.assertIn("data, never instructions", session["messages"][0])
        self.assertIn("Three more snags.", self.cardFile(session))   # what it reads again says so too
        self.settle()
        self.assertEqual(len(session["messages"]), 1)   # once, and its own note does not wake it

    def testANoteTheUserAddsReachesTheAgentWhenItsTurnEnds(self):
        self.claude.turns = [[("say", "On it.")], []]
        cardId = self.item("Busy with notes")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.board.call("POST", "/api/cards/%s/attachments" % cardId, {"type": "text", "content": "Rates changed in May."})
        self.helper.passOnce()   # still working: kept for later
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], [])
        self.settle()
        self.assertEqual(session["messages"], ["The user added a note to the card (card.md has it too): Rates changed in May."])

    def testAStoppedAgentHearsOfANewPingOnlyWhenResumed(self):
        self.claude.turns = [[("say", "On it.")], []]
        cardId = self.onThread("Stopped thread", "First.")["cardId"]
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.press(cardId, "stop")
        self.helper.passOnce()
        self.claude.wait()
        self.onThread("Follow-up", "Later news.")
        self.now += 31
        self.helper.passOnce()
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], [])   # the user stopped it: a ping does not wake it
        self.press(cardId, "resume")
        self.helper.passOnce()
        self.assertEqual(len(session["messages"]), 1)
        self.assertIn("Later news.", session["messages"][0])
        self.assertTrue(session["messages"][0].endswith("The user pressed Resume: carry on where you left off."))
        self.assertNotIn("heldNotes", self.helper.state["runs"][cardId])

    def testARunFromBeforeNotesWereFollowedCountsTheNotesThereAsSeen(self):
        # Live: after the upgrade the helper sent a day-old follow-up and a "lol" as news, and woke the
        # agent for them.
        self.claude.turns = [[("say", "On it.")], []]
        cardId = self.onThread("Old run", "First.")["cardId"]
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        del self.helper.state["runs"][cardId]["seenNotes"]   # as a run the helper started before it followed notes
        self.onThread("Follow-up", "From before the upgrade.")
        self.settle()
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], [])
        self.onThread("Follow-up", "After the upgrade.")
        self.settle()
        self.assertEqual(len(session["messages"]), 1)
        self.assertIn("After the upgrade.", session["messages"][0])

    def wokenFromATerminal(self, cardId):
        """The agent's turn is over; then the user types to it in a terminal (claude attach)."""
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "idle")
        session = next(iter(self.claude.sessions.values()))
        session["state"] = "working"
        return session

    def stops(self, session):
        key = next(key for key, value in self.claude.sessions.items() if value is session)
        return [call for call in self.claude.calls if call[1:3] == ["stop", key]]

    def testATurnFromATerminalHoldsMessagesUntilItEnds(self):
        # Live: the user typed to an agent in the board's terminal; the helper still counted it idle, and a
        # wake stopped that turn half way.
        self.claude.turns = [[("say", "On it.")], []]
        cardId = self.item("Driven from a terminal")
        session = self.wokenFromATerminal(cardId)
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "working")
        self.assertEqual(self.buttons(cardId), [STOP["id"], CONTEXT["id"], TERMINAL["id"]])
        self.board.call("POST", "/api/cards/%s/chat" % cardId, {"text": "Also check May."})
        self.helper.passOnce()
        self.assertEqual((session["messages"], self.stops(session)), ([], []))   # its turn goes on
        session["state"] = "done"
        self.helper.passOnce()
        self.claude.wait()
        self.assertEqual(session["messages"], ["The user says: Also check May."])

    def testAWakeRightAfterARestartLeavesATurnFromATerminalAlone(self):
        # Live: the helper restarted while the user had the agent at work from a terminal, found a note for
        # it on its first pass (before it had listed the sessions), and woke it.
        self.claude.turns = [[("say", "On it.")], []]
        cardId = self.onThread("Restarted", "First.")["cardId"]
        session = self.wokenFromATerminal(cardId)
        self.onThread("Follow-up", "Later news.")
        self.helper = self.newHelper()   # restarted: the state on disk still says idle
        self.helper.passOnce()
        self.assertEqual((session["messages"], self.stops(session)), ([], []))
        self.assertEqual(len(self.claude.sessions), 1)   # and no copy
        session["state"] = "done"
        self.helper.passOnce()
        self.claude.wait()
        self.assertEqual(len(session["messages"]), 1)
        self.assertIn("Later news.", session["messages"][0])

    def testContextWhileItWorksWaitsForTheEndOfItsTurn(self):
        cardId = self.item("Busy")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.press(cardId, "context", "Use the new rates.")
        self.helper.passOnce()   # still working (or just done, but not yet seen): kept for later
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()   # its turn ended: woken with the context
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], ["The user added context: Use the new rates."])

    def testAStaleEndedListingRightAfterAWakeDoesNotEndTheTurn(self):
        # Live: `claude agents` listed a just-woken session as done; the helper took its turn as over.
        cardId = self.item("Woken")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "idle")
        session = next(iter(self.claude.sessions.values()))
        self.claude.staleAfterWake = True
        self.press(cardId, "reply", "The 2026 ledger.")
        self.helper.passOnce()   # woken, and listed as done all the same
        self.assertEqual(session["messages"], ["The user replied: The 2026 ledger."])
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "working")   # within the grace: not trusted
        session["state"] = "working"
        self.helper.passOnce()   # seen working ...
        session["state"] = "done"
        self.helper.passOnce()   # ... so this one is the end of its turn
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "idle")

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

    def testOneCardsSurpriseDoesNotStopTheOthersOrTheLoop(self):
        broken, fine = self.item("Broken"), self.item("Fine")
        chat = self.helper._chat

        def failing(card):
            if card["id"] == broken:
                raise KeyError("something the helper did not expect")
            return chat(card)
        self.helper._chat = failing
        with self.assertLogs("driftboard_helper", "ERROR"):
            self.helper.passOnce()
        self.assertEqual(self.buttons(fine), [START["id"], CONTEXT["id"]])

        def broke():
            raise TypeError("an unexpected board reply")
        self.helper.passOnce = broke
        with self.assertLogs("driftboard_helper", "ERROR"):
            passSafely(self.helper)   # logged; the loop goes on

    def testAStartedAgentIsSavedAtOnce(self):
        cardId = self.item("Saved")
        self.helper.passOnce()
        self.press(cardId, "start")
        buttons = self.helper.board.request

        def failingButtons(method, path, body=None, **extra):
            if method == "PATCH" and body and "buttons" in body:
                raise RuntimeError("the pass dies after the start")
            return buttons(method, path, body, **extra)
        self.helper.board.request = failingButtons
        with self.assertRaises(RuntimeError):
            self.helper.passOnce()
        with open(os.path.join(self.directory.name, "state", "state.json")) as stateFile:
            self.assertEqual(json.load(stateFile)["runs"][cardId]["state"], "working")

    def testAnotherScriptsButtonsAndPressesAreLeftAlone(self):
        cardId = self.item("Someone else's")
        self.board.call("PATCH", "/api/cards/%s" % cardId, {"buttons": [{"id": "approve", "label": "Approve"}]})
        self.board.call("POST", "/api/cards/%s/press" % cardId, {"button": "approve"})
        self.helper.passOnce()
        card = self.card(cardId)
        self.assertEqual(([button["id"] for button in card["buttons"]], card["pressed"]["button"]), (["approve"], "approve"))

    def recordRequests(self):
        sent, request = [], self.helper.board.request

        def recording(method, path, body=None, **extra):
            sent.append((method, path, body))
            return request(method, path, body, **extra)
        self.helper.board.request = recording
        return sent

    def marks(self):
        return {each["name"]: each.get("agents") for each in self.board.call("GET", "/api/state")["workspaces"]}

    def testTheBoardsItWatchesCarryItsMarkAndNoOthers(self):
        self.item("Puts the Inbox up")
        groceries = self.board.call("POST", "/api/workspaces", {"name": "Groceries"})
        self.board.call("PATCH", "/api/workspaces/%s" % groceries["id"], {"agents": {"tool": "codex"}})   # watched before
        self.helper.passOnce()
        self.assertEqual(self.marks(), {"My Board": None, "Inbox": {"tool": "claude"}, "Groceries": None})
        sent = self.recordRequests()
        self.helper.passOnce()
        self.assertEqual([path for method, path, _body in sent if path.startswith("/api/workspaces/") and method == "PATCH"], [])

    def testAMarkThatWentMissingIsSetAgain(self):
        self.item("Puts the Inbox up")
        self.helper.passOnce()
        self.board.call("PATCH", "/api/workspaces/%s" % self.inbox()["id"], {"agents": None})   # a board restored, say
        self.helper.passOnce()
        self.assertEqual(self.marks()["Inbox"], {"tool": "claude"})

    def testABoardThatDoesNotKeepTheMarkIsMarkedOncePerRun(self):
        self.item("Puts the Inbox up")
        sent, request = [], self.helper.board.request

        def olderBoard(method, path, body=None, **extra):   # takes the PATCH, keeps nothing of it
            if method == "PATCH" and path.startswith("/api/workspaces/"):
                sent.append(path)
                return {}
            return request(method, path, body, **extra)
        self.helper.board.request = olderBoard
        self.helper.passOnce()
        self.helper.passOnce()
        self.assertEqual(len(sent), 1)

    def testTheHelpersCardsOpenTheirChat(self):
        cardId = self.item("Chat with me")
        sent = self.recordRequests()
        self.helper.passOnce()
        self.assertIn(("PATCH", "/api/cards/%s" % cardId, {"buttons": [START, CONTEXT], "terminalEnabled": False,
                                                          "chatEnabled": True}), sent)

    def testAnAgentsSessionOpensInATerminalWindowFromTheOpenCard(self):
        # The user: "make it so it can open a terminal page with claude for you".
        cardId = self.item("Show me the session")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.settle()
        session = self.helper.state["runs"][cardId]["session"]
        self.assertIn(TERMINAL["id"], self.buttons(cardId))
        self.assertEqual([button.get("place") for button in self.card(cardId)["buttons"] if button["id"] == "terminal"], ["open"])
        opened = []
        with unittest.mock.patch("driftboard_helper.helper.openWindow",
                                 lambda argv, cwd, app=None: opened.append((argv, cwd, app)) or (True, "terminator")):
            self.press(cardId, "terminal")
            self.helper.passOnce()
        self.assertEqual(opened, [(["claude", "attach", session], self.project, "")])
        self.assertNotIn("pressed", self.card(cardId))

    def testACardMovesToWorkingWhenItsAgentStartsOrIsWoken(self):
        # The user: "2 tickets are running, they say new but should be under researching".
        self.claude.turns = [[("progress", "reading")], [("progress", "back at it")]]
        cardId = self.item("Move me")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.helper.passOnce()
        self.assertEqual(self.board.column(cardId), "Working")
        found = self.board.call("GET", "/api/cards/%s" % cardId)
        workspace = self.board.call("GET", "/api/workspaces/%s" % found["workspaceId"])
        review = next(binder["id"] for binder in workspace["binders"] if binder["title"] == "Review")
        self.board.call("POST", "/api/cards/%s/move" % cardId, {"binderId": review, "toIndex": 0})   # the work is in Review
        self.now += 31
        self.helper.passOnce()   # its turn is over
        self.press(cardId, "reply", "Not quite: redo the totals.")
        self.settle()
        self.assertEqual(self.board.column(cardId), "Working")   # sent back: at work again

    def testACardDeletedThenBroughtBackStartsAfresh(self):
        # Live: the user undid a deletion, and the card came back with its run closed and no buttons.
        cardId = self.item("Undo me")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.settle()
        self.board.call("DELETE", "/api/cards/%s" % cardId)
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "closed")
        self.board.call("POST", "/api/undo")
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [START["id"], CONTEXT["id"]])

    def testAWindowThatCannotOpenSaysOnTheCardWhatToRun(self):
        cardId = self.item("No terminal app")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.settle()
        session = self.helper.state["runs"][cardId]["session"]
        with unittest.mock.patch("driftboard_helper.helper.openWindow", lambda argv, cwd, app=None: (False, "no terminal app found")):
            self.press(cardId, "terminal")
            self.helper.passOnce()
        notes = [attachment.get("content") or "" for attachment in self.card(cardId)["attachments"]]
        self.assertTrue(any("no terminal app found" in note and "claude attach %s" % session in note for note in notes), notes)

    def testAPressIsClearedOnlyAsThePressItWas(self):
        # A press made while the helper worked on the one before must not be wiped with it.
        cardId = self.item("Two presses")
        self.helper.passOnce()
        self.press(cardId, "start")
        at = self.card(cardId)["pressed"]["at"]
        sent = self.recordRequests()
        self.helper.passOnce()
        self.assertIn(("PATCH", "/api/cards/%s" % cardId, {"pressed": None, "pressedAt": at}), sent)

    def testAPressWhoseClearFailedIsNotActedOnTwice(self):
        cardId = self.item("Clear fails")
        self.helper.passOnce()
        self.press(cardId, "context", "Use the new rates.")
        request = self.helper.board.request
        failures = [1]

        def failingClear(method, path, body=None, **extra):
            if method == "PATCH" and body and "pressedAt" in body and failures:
                failures.pop()
                raise BoardError("PATCH %s: the board did not answer" % path)
            return request(method, path, body, **extra)
        self.helper.board.request = failingClear
        self.helper.passOnce()   # posted to the chat, then the clear fails
        self.helper.passOnce()   # the same press again: only cleared
        chat = [message["text"] for message in self.card(cardId)["chat"]]
        self.assertEqual(chat, ["Use the new rates."])
        self.assertNotIn("pressed", self.card(cardId))
        self.assertEqual(self.helper.state["runs"][cardId]["contexts"], ["Use the new rates."])

    def testAReplyWhoseWakeFailsIsPostedOnceAndReachesTheAgentLater(self):
        cardId = self.item("Wake fails")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        self.claude.failResumes = 1
        self.press(cardId, "reply", "The 2026 ledger.")
        self.helper.passOnce()   # the wake fails: kept
        self.assertNotIn("pressed", self.card(cardId))
        self.helper.passOnce()   # and delivered once it works
        session = next(iter(self.claude.sessions.values()))
        self.assertEqual(session["messages"], ["The user replied: The 2026 ledger."])
        chat = [message["text"] for message in self.card(cardId)["chat"] if message["from"] == "user"]
        self.assertEqual(chat, ["The 2026 ledger."])

    def notes(self, cardId):
        return [attachment["content"] for attachment in self.card(cardId)["attachments"] if attachment.get("type") == "text"]

    def testAStartThatFailsSaysWhyOnTheCardAndIsNotRetried(self):
        cardId = self.item("Not signed in")
        self.helper.passOnce()
        self.claude.failStarts = 1
        self.press(cardId, "start")
        self.helper.passOnce()
        self.helper.passOnce()
        card = self.card(cardId)
        self.assertNotIn("pressed", card)
        self.assertTrue(card["agent"]["stoppedAt"])   # the token it minted is revoked
        self.assertEqual([note[:24] for note in self.notes(cardId)], ["⚠ Could not start claude"])
        self.assertIn("not signed in", self.notes(cardId)[0])
        self.assertEqual(len([call for call in self.claude.calls if "--settings" in call]), 1)   # tried once, not every pass
        self.assertEqual(self.buttons(cardId), [START["id"], CONTEXT["id"]])   # the user can try again

    def testAFailedSessionIsReportedOnTheCard(self):
        cardId = self.item("Fails")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        next(iter(self.claude.sessions.values()))["state"] = "failed"
        self.now += 31
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "stopped")
        self.assertIn("session failed", " ".join(self.notes(cardId)))
        self.assertEqual(self.buttons(cardId), [RESUME["id"], REPLY["id"], CONTEXT["id"]])

    def testADeletedCardsAgentIsStoppedAndItsSlotFreed(self):
        cardId, waiting = self.item("Deleted"), self.item("Only context")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.press(waiting, "context", "Some context.")
        self.helper.passOnce()
        self.board.call("DELETE", "/api/cards/%s" % cardId)
        self.board.call("DELETE", "/api/cards/%s" % waiting)
        self.helper.passOnce()
        self.assertEqual(self.helper.state["runs"][cardId]["state"], "closed")
        self.assertNotIn(waiting, self.helper.state["runs"])
        self.assertTrue(any(call[1] == "stop" for call in self.claude.calls))
        self.assertEqual(self.helper._running(), 0)

    def testTheToolsSessionsAreListedOnlyWhenAnAgentRuns(self):
        self.item("Idle board")
        self.helper.passOnce()
        self.helper.passOnce()
        self.assertFalse([call for call in self.claude.calls if call[1:3] == ["agents", "--json"]])

    def testStateIsWrittenOnlyWhenItChanged(self):
        cardId = self.item("Quiet")
        self.helper.passOnce()
        self.press(cardId, "context", "Something to keep.")
        self.helper.passOnce()   # a change: written
        path = os.path.join(self.directory.name, "state", "state.json")
        before = os.stat(path).st_mtime_ns
        self.helper.passOnce()
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def testAClosedRunIsForgottenAfterAWeek(self):
        cardId = self.item("Long done")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        run = dict(self.helper.state["runs"][cardId])
        found = self.board.call("GET", "/api/cards/%s" % cardId)
        workspace = self.board.call("GET", "/api/workspaces/%s" % found["workspaceId"])
        done = next(binder["id"] for binder in workspace["binders"] if binder["title"] == "Done")
        self.board.call("POST", "/api/cards/%s/move" % cardId, {"binderId": done, "toIndex": 0})
        self.helper.passOnce()
        self.now += 6 * 86400
        self.helper.passOnce()
        self.assertIn(cardId, self.helper.state["runs"])   # within the week: kept
        self.now += 2 * 86400
        self.helper.passOnce()
        self.assertNotIn(cardId, self.helper.state["runs"])
        self.assertFalse(os.path.exists(run["folder"]) or os.path.exists(run["control"]))

    def testACommandWaitingForTheUsersYesIsShownOnTheCard(self):
        self.claude.turns = [[("progress", "about to push the branch")]]
        cardId = self.item("Needs a yes")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        session = next(iter(self.claude.sessions.values()))
        session["state"] = "blocked"   # no question asked: a permission prompt
        self.now += 31
        self.helper.passOnce()
        shortId = self.helper.state["runs"][cardId]["session"]
        self.assertIn("claude attach %s" % shortId, self.card(cardId)["agent"]["progress"])

    def testAQuestionIsNotMistakenForAPermissionPrompt(self):
        cardId = self.item("Asks")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        next(iter(self.claude.sessions.values()))["state"] = "blocked"
        self.now += 31
        self.helper.passOnce()
        self.assertNotIn("claude attach", self.card(cardId)["agent"].get("progress") or "")

    def testACardAlreadyClosedOffersNoAgent(self):
        # Live: cards posted straight into Won't do got ▶ Start.
        cardId = self.board.call("POST", "/api/items", {"source": "test", "title": "Out of scope", "column": "Won't do"})["cardId"]
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [])

    def testTheStarterBoardsCompletedColumnIsClosedToo(self):
        self.config["board"]["workspaces"] = ["My Board"]
        self.helper = self.newHelper()
        cardId = self.board.call("POST", "/api/items", {"source": "test", "title": "Finished", "workspace": "My Board",
                                                        "column": "Completed"})["cardId"]
        self.helper.passOnce()
        self.assertEqual(self.buttons(cardId), [])

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

    def moveTo(self, cardId, column):
        workspace = self.board.call("GET", "/api/workspaces/%s" % self.board.call("GET", "/api/cards/%s" % cardId)["workspaceId"])
        binder = next(binder for binder in workspace["binders"] if binder["title"] == column)
        self.board.call("POST", "/api/cards/%s/move" % cardId, {"binderId": binder["id"]})

    def testAStartWaitingItsTurnIsDroppedWhenTheUserClosesTheCard(self):
        self.helper = self.newHelper(maxAgents=1)
        first, second = self.item("First"), self.item("Second")
        self.helper.passOnce()
        self.press(first, "start")
        self.press(second, "start")
        self.helper.passOnce()   # the second waits its turn
        self.moveTo(second, "Won't do")
        self.helper.passOnce()
        self.assertIsNone(self.card(second).get("pressed"))
        self.press(first, "stop")
        self.moveTo(second, "New")   # back, as a later item on its thread brings it
        self.helper.passOnce()
        self.helper.passOnce()
        self.assertEqual((len(self.claude.sessions), self.buttons(second)), (1, [START["id"], CONTEXT["id"]]))

    def testAnAgentWhoseTurnEndedHoldsNoSlot(self):
        self.helper = self.newHelper(maxAgents=1)
        first, second = self.item("First"), self.item("Second")
        self.helper.passOnce()
        self.press(first, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()   # its turn ended: idle, in Needs you
        self.press(second, "start")
        self.helper.passOnce()
        self.assertEqual(len(self.claude.sessions), 2)

    def testAWakeWaitsForAFreeSlot(self):
        self.helper = self.newHelper(maxAgents=1)
        first, second = self.item("First"), self.item("Second")
        self.helper.passOnce()
        self.press(first, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        self.press(second, "start")
        self.helper.passOnce()
        self.claude.wait()
        firstSession, secondSession = self.claude.sessions.values()
        secondSession["state"] = "working"   # still at work: the one slot is taken
        self.press(first, "reply", "The 2026 ledger.")
        self.helper.passOnce()
        self.assertEqual(firstSession["messages"], [])   # kept, not woken past the limit
        secondSession["state"] = "done"
        self.now += 31
        self.helper.passOnce()   # the slot is free: woken with it
        self.assertEqual(firstSession["messages"], ["The user replied: The 2026 ledger."])

    def testTheSessionsSettingsHoldTheFloorAndTheUsersAccess(self):
        self.helper = self.newHelper(access={"ssh": "ask"}, rules=["Never touch the production ledger."],
                                     limits={"codeHost": "never", "push": "never", "http": "never"})
        cardId = self.item("Settings")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        session = next(iter(self.claude.sessions.values()))
        permissions = session["settings"]["permissions"]
        for rule in ("Bash(git *push*)", "Bash(gh *pr merge*)", "Bash(glab *mr note*)", "Bash(curl *--data*)", "Read(~/.ssh/**)"):
            self.assertIn(rule, permissions["deny"])
        self.assertIn("Bash(ssh *)", permissions["ask"])
        self.assertIn("Never touch the production ledger.", session["settings"]["autoMode"]["hard_deny"])
        with open(session["env"]["CLAUDE_ENV_FILE"]) as environmentFile:
            first = environmentFile.read().split("=", 1)[1].split(":")[0]
        self.assertEqual(sorted(os.listdir(first)), ["gh", "git", "glab", "scp", "sftp"])   # ssh opened: no stand-in
        run = self.helper.state["runs"][cardId]
        self.assertEqual(os.stat(os.path.join(run["control"], "settings.json")).st_mode & 0o777, 0o600)
        # this machine's own secrets, wherever they are: the board's token and the helper's state
        state = os.path.realpath(os.path.join(self.directory.name, "state"))
        token = os.path.realpath(self.board.tokenFile)
        for rule in ("Read(/%s)" % token, "Bash(*%s*)" % token, "Read(/%s/**)" % os.path.dirname(token),
                     "Read(/%s/state.json)" % state, "Read(/%s/control/**)" % state, "Edit(/%s/control/**)" % state):
            self.assertIn(rule, permissions["deny"])
        # the agent writes its run folder; its settings and stand-ins are not in it
        self.assertFalse(set(os.listdir(run["folder"])) & {"settings.json", "guards", "session-env.sh"})
        self.assertFalse(first.startswith(run["folder"]))

    def testARunFromBeforeTheControlFolderKeepsItsSettingsPath(self):
        cardId = self.item("Old run")
        self.helper.passOnce()
        self.press(cardId, "start")
        self.helper.passOnce()
        self.claude.wait()
        self.now += 31
        self.helper.passOnce()
        run = self.helper.state["runs"][cardId]
        for key in ("control", "settingsPath"):   # as an older helper left it
            run.pop(key)
        self.press(cardId, "reply", "Carry on.")
        self.helper.passOnce()
        with open(os.path.join(run["folder"], "settings.json")) as settingsFile:   # where its session reads them
            settings = json.load(settingsFile)
        self.assertEqual(settings["env"]["CLAUDE_ENV_FILE"], os.path.join(run["control"], "session-env.sh"))


class ClaudeLauncherTest(unittest.TestCase):
    def testAResumeThatStartsACopyStopsTheCopyAndTheMessageWaits(self):
        # Live: --resume on a session still in a turn printed this, and the helper took it for a wake
        # that failed, so it woke the session once more.
        calls = []

        def run(command, workingDirectory):
            calls.append(command)
            if command[1:3] == ["--bg", "--resume"]:
                return 0, ("backgrounded · 7d9d0914\n  claude attach 7d9d0914    open in this terminal\n"
                           "note: session d25cc0a8 is already running in the background, so this started a copy as 7d9d\n"), ""
            return 0, "", ""
        with self.assertRaises(SessionBusy):
            ClaudeLauncher("/tmp", run=run).resume("d25cc0a8", "d25cc0a8-full", "New on the card")
        self.assertEqual(calls[-1], ["claude", "stop", "7d9d0914"])


if __name__ == "__main__":
    unittest.main()
