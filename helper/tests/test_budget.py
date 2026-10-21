import copy
import json
import os
import tempfile
import unittest
import urllib.error

from driftboard_helper.board import BoardClient
from driftboard_helper.checks import usageChecks
from driftboard_helper.claude import ClaudeLauncher
from driftboard_helper.config import DEFAULTS, configProblems
from driftboard_helper.helper import CONTEXT, REPLY, RESUME, START, Helper
from driftboard_helper.usage import (USAGE_URL, WINDOW_SECONDS, TranscriptLedger, UsageMeter, epochSeconds,
                                    weightOf)

from . import test_helper
from .boards import NODE, Board


class FakeUsage:
    """The share of the 5-hour limit each session took, as the test sets it."""

    def __init__(self):
        self.spent = {}   # short session id -> percent of the limit
        self.resetsAt = 20000.0
        self.known = True

    def refresh(self):
        pass

    def ofLimit(self, sessionIds):
        return sum(self.spent.get(session, 0) for session in sessionIds) if self.known else None


def call(model, moment, output, key):
    return json.dumps({"type": "assistant", "timestamp": moment, "message": {
        "id": key, "model": model, "usage": {"input_tokens": 0, "output_tokens": output}}}) + "\n"


class UsageMeterTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.now = epochSeconds("2027-01-15T09:00:00Z")
        project = os.path.join(self.directory.name, "-home-someone-work")
        os.makedirs(os.path.join(project, "aaaaaaaa-agent", "subagents"))
        self.write(os.path.join(project, "aaaaaaaa-agent.jsonl"),
                   call("claude-sonnet-5-5", "2027-01-15T08:00:00Z", 1000, "one"))
        self.write(os.path.join(project, "aaaaaaaa-agent", "subagents", "agent-1.jsonl"),
                   call("claude-haiku-5-5", "2027-01-15T08:01:00Z", 3000, "two"))
        self.write(os.path.join(project, "bbbbbbbb-user.jsonl"),
                   call("claude-sonnet-5-5", "2027-01-15T08:02:00Z", 4000, "three")
                   + call("claude-sonnet-5-5", "2027-01-14T08:00:00Z", 9000, "yesterday"))
        self.windows = {"five_hour": {"utilization": 40, "resets_at": "2027-01-15T10:00:00Z"}}
        ledger = TranscriptLedger(root=self.directory.name, clock=lambda: self.now)
        self.meter = UsageMeter(fetch=lambda: self.windows, ledger=ledger, clock=lambda: self.now)

    def tearDown(self):
        self.directory.cleanup()

    def write(self, path, text):
        with open(path, "w") as transcript:
            transcript.write(text)
        os.utime(path, (self.now, self.now))

    def testASessionsShareIsItsWeightAgainstAllUseTimesTheWindowsUtilization(self):
        self.meter.refresh()
        # sonnet 1000 out (3 x 5000) + haiku 3000 out (1 x 15000) = 30000 of 30000 + 60000; 40% of the limit used
        self.assertEqual(self.meter.ofLimit(["aaaaaaaa"]), round(30000 / 90000 * 40, 1))
        self.assertEqual(self.meter.ofLimit(["bbbbbbbb-user"]), round(60000 / 90000 * 40, 1))
        self.assertEqual(self.meter.ofLimit(["short"]), 0.0)   # too short to name a session

    def testNothingIsKnownBeforeTheEndpointAnswers(self):
        self.meter._fetch = lambda: (_ for _ in ()).throw(OSError("offline"))
        self.meter.refresh()
        self.assertIsNone(self.meter.ofLimit(["aaaaaaaa"]))

    def testA429WaitsFifteenMinutesBeforeAskingAgain(self):
        asked = []

        def busy():
            asked.append(self.now)
            raise urllib.error.HTTPError(USAGE_URL, 429, "Too Many Requests", None, None)
        self.meter._fetch = busy
        self.meter.refresh()
        self.now += 300
        self.meter.refresh()
        self.now += 600
        self.meter.refresh()
        self.assertEqual(len(asked), 2)

    def testUseBeforeTheWindowDoesNotCount(self):
        self.windows["five_hour"]["resets_at"] = "2027-01-15T13:01:00Z"   # the window opened at 08:01
        self.meter.refresh()
        self.assertEqual(self.meter.resetsAt - WINDOW_SECONDS, epochSeconds("2027-01-15T08:01:00Z"))
        self.assertEqual(self.meter.ofLimit(["aaaaaaaa"]), round(15000 / 75000 * 40, 1))

    def testWeightsFollowTheModel(self):
        usage = {"usage": {"output_tokens": 1_000_000}}
        self.assertEqual(weightOf(dict(usage, model="claude-opus-5-5")), 25.0)
        self.assertEqual(weightOf(dict(usage, model="claude-haiku-5-5")), 5.0)


class BudgetConfigTest(unittest.TestCase):
    def config(self, **budget):
        config = copy.deepcopy(DEFAULTS)
        config["agent"].update(directory=tempfile.gettempdir(), budget=budget)
        return config

    def testAPercentFromZeroToAHundredIsABudget(self):
        self.assertEqual(configProblems(self.config(cardPercent=10, totalPercent=15)), [])
        self.assertEqual(configProblems(self.config()), [])

    def testAnythingElseIsAProblem(self):
        self.assertTrue(configProblems(self.config(cardPercent=150)))
        self.assertTrue(configProblems(self.config(totalPercent="15")))
        self.assertTrue(configProblems(self.config(perDay=5)))

    def testCheckSaysWhetherUsageIsReadable(self):
        self.assertEqual(usageChecks(lambda: {"five_hour": {"utilization": 12}}),
                         [(True, "Claude usage is readable (12% of the 5-hour limit used)", "")])
        ok, _what, hint = usageChecks(lambda: (_ for _ in ()).throw(ValueError("not signed in to Claude")))[0]
        self.assertFalse(ok)
        self.assertIn("no budget is kept", hint)

    def testCodexCannotBeBudgeted(self):
        config = self.config(totalPercent=15)
        config["agent"]["tool"] = "codex"
        self.assertIn("agent.budget needs Claude Code: it reads Claude's usage and transcripts", configProblems(config))


@unittest.skipUnless(NODE, "needs node for the board")
class BudgetTest(unittest.TestCase):
    def setUp(self):
        self.board = Board()
        self.directory = tempfile.TemporaryDirectory()
        self.project = os.path.join(self.directory.name, "project")
        os.makedirs(self.project)
        self.claude = test_helper.FakeClaude([[("progress", "reading")], [("progress", "reading on")]])
        self.usage = FakeUsage()
        self.now = 1000.0

    def tearDown(self):
        self.claude.wait()   # its turns write into the folders about to go
        self.board.close()
        self.directory.cleanup()

    def newHelper(self, **budget):
        config = copy.deepcopy(DEFAULTS)
        config["agent"].update(directory=self.project, maxAgents=3, budget=budget)
        state = os.path.join(self.directory.name, "state")
        os.makedirs(state, exist_ok=True)
        return Helper(config, BoardClient(self.board.url, self.board.tokenFile), ClaudeLauncher(self.project, run=self.claude),
                      state, clock=lambda: self.now, listingGrace=30, usage=self.usage)

    def item(self, title):
        return self.board.call("POST", "/api/items", {"source": "test", "title": title, "body": "Look into it."})["cardId"]

    def card(self, cardId):
        return self.board.call("GET", "/api/cards/%s" % cardId)["card"]

    def press(self, cardId, button):
        self.board.call("POST", "/api/cards/%s/press" % cardId, {"button": button})

    def buttons(self, cardId):
        return [button["id"] for button in self.card(cardId).get("buttons") or []]

    def notes(self, cardId):
        return [attachment["content"] for attachment in self.card(cardId)["attachments"] if attachment.get("type") == "text"]

    def notice(self):
        return (self.board.call("GET", "/api/state").get("notice") or {}).get("text")

    def started(self, helper, title, spent):
        cardId = self.item(title)
        helper.passOnce()
        self.usage.spent["%08x" % (0xb0000000 + len(self.claude.sessions))] = spent
        self.press(cardId, "start")
        helper.passOnce()
        return cardId

    def testACardPastItsBudgetStopsAndResumeAllowsItAsMuchAgain(self):
        helper = self.newHelper(cardPercent=5)
        cardId = self.started(helper, "Dig through the logs", 6)
        self.assertEqual(self.buttons(cardId), [RESUME["id"], REPLY["id"], CONTEXT["id"]])
        self.assertIn("⏸ Stopped: this card's agent used 6% of the 5-hour Claude limit (card budget 5%). ▶ Resume or "
                      "a reply allows it 5% more.", self.notes(cardId))
        self.assertIn(["claude", "stop", "b0000000"], self.claude.calls)
        self.press(cardId, "resume")
        helper.passOnce()
        self.assertEqual(helper.state["runs"][cardId]["state"], "working")   # 6% of the 11% it may now use
        self.usage.spent["b0000000"] = 11
        helper.passOnce()
        self.assertEqual(helper.state["runs"][cardId]["state"], "stopped")

    def testAgentsTogetherPastTheTotalBudgetStopAndNoneStartsUntilTheReset(self):
        helper = self.newHelper(totalPercent=10)
        first = self.started(helper, "First", 4)
        second = self.started(helper, "Second", 7)
        self.assertEqual([helper.state["runs"][cardId]["state"] for cardId in (first, second)], ["stopped", "stopped"])
        self.assertTrue(self.notice().startswith("Agents paused: together they used 11% of the 5-hour Claude limit "
                                                 "(budget 10%)"))
        third = self.item("Third")
        helper.passOnce()
        self.press(third, "start")
        helper.passOnce()
        self.assertEqual(len(self.claude.sessions), 2)   # its press waits for the reset
        self.press(first, "resume")
        helper.passOnce()
        self.assertEqual(helper.state["runs"][first]["state"], "stopped")
        self.usage.resetsAt += 5 * 3600   # a new window: what they used before is in the last one
        self.usage.spent = {}
        helper.passOnce()
        helper.passOnce()
        self.assertIsNone(self.notice())
        self.assertEqual(len(self.claude.sessions), 3)
        self.assertEqual(helper.state["runs"][first]["state"], "working")
        self.assertNotEqual(self.buttons(third), [START["id"], CONTEXT["id"]])

    def testAShareThatIsNotKnownStopsNothing(self):
        helper = self.newHelper(cardPercent=1, totalPercent=1)
        self.usage.known = False
        cardId = self.started(helper, "Unknown", 50)
        self.assertEqual(helper.state["runs"][cardId]["state"], "working")
        self.assertIsNone(self.notice())

    def testANoticeAnotherScriptPutUpStays(self):
        helper = self.newHelper(totalPercent=10)
        self.board.call("PUT", "/api/notice", {"text": "Out of Claude usage until 18:00", "level": "error"})
        self.started(helper, "Busy", 2)
        helper.passOnce()
        self.assertEqual(self.notice(), "Out of Claude usage until 18:00")

    def testWithoutABudgetNothingIsMeasured(self):
        helper = self.newHelper()
        self.usage.known = False
        self.usage.refresh = lambda: self.fail("measured without a budget")
        cardId = self.started(helper, "Free", 90)
        self.assertEqual(helper.state["runs"][cardId]["state"], "working")
