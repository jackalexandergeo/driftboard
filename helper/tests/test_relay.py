import os
import tempfile
import unittest

from driftboard_helper.board import BoardClient
from driftboard_helper.outbox import append
from driftboard_helper.relay import Relay

from .boards import NODE, Board


@unittest.skipUnless(NODE, "needs node for the board")
class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.board = Board()

    @classmethod
    def tearDownClass(cls):
        cls.board.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.outbox = os.path.join(self.directory.name, "outbox.jsonl")
        self.client = BoardClient(self.board.url, self.board.tokenFile)
        self.cardId = self.board.call("POST", "/api/items", {"source": "test", "title": "Reconcile invoices"})["cardId"]
        self.cardToken = self.board.call("POST", "/api/cards/%s/agent" % self.cardId, {"name": "codex"})["token"]

    def tearDown(self):
        self.directory.cleanup()

    def testReportsReachTheCardOnceAndInOrder(self):
        relay = Relay(self.client, self.cardId, self.cardToken, self.outbox)
        append(self.outbox, {"kind": "progress", "text": "reading 12 invoices"})
        append(self.outbox, {"kind": "ask", "text": "The 2025 or the 2026 ledger?"})
        self.assertEqual(relay.pump(), 2)
        self.assertEqual(self.board.column(self.cardId), "Needs you")
        append(self.outbox, {"kind": "result", "text": "**2 mismatches**"})
        append(self.outbox, {"kind": "move", "column": "Review"})
        self.assertEqual(relay.pump(), 2)
        self.assertEqual(relay.pump(), 0)   # nothing new: nothing sent again
        agent = self.board.call("GET", "/api/cards/%s" % self.cardId)["card"]["agent"]
        self.assertEqual((agent["progress"], agent["result"], agent.get("question")),
                         ("reading 12 invoices", "**2 mismatches**", None))
        self.assertEqual(self.board.column(self.cardId), "Review")

    def testAClosedCardStopsTheRelay(self):
        relay = Relay(self.client, self.cardId, self.cardToken, self.outbox)
        found = self.board.call("GET", "/api/cards/%s" % self.cardId)
        workspace = self.board.call("GET", "/api/workspaces/%s" % found["workspaceId"])
        done = next(binder["id"] for binder in workspace["binders"] if binder["title"] == "Done")
        self.board.call("POST", "/api/cards/%s/move" % self.cardId, {"binderId": done, "toIndex": 0})
        append(self.outbox, {"kind": "progress", "text": "still going"})
        relay.pump()
        self.assertTrue(relay.closed)

    def testABoardThatCannotBeReachedKeepsTheReportForLater(self):
        relay = Relay(BoardClient("http://127.0.0.1:9", self.board.tokenFile), self.cardId, self.cardToken, self.outbox)
        append(self.outbox, {"kind": "progress", "text": "waiting for the board"})
        self.assertEqual((relay.pump(), relay.offset), (0, 0))
        relay.board = self.client
        self.assertEqual(relay.pump(), 1)


if __name__ == "__main__":
    unittest.main()
