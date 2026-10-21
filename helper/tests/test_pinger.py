"""pinger/driftboard-ping against a real board, and against a server that is not the board."""

import contextlib
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import tempfile
import threading
import unittest
from unittest import mock

from .boards import NODE, REPO, Board

PINGER = os.path.join(REPO, "pinger", "driftboard-ping")
loader = importlib.machinery.SourceFileLoader("driftboard_ping", PINGER)
pinger = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(pinger)


def run(*argv, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch("sys.stdin", io.StringIO(stdin)), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = pinger.main(list(argv))
    return status, out.getvalue(), err.getvalue()


@unittest.skipUnless(NODE, "needs node for the board")
class PingerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.board = Board()

    @classmethod
    def tearDownClass(cls):
        cls.board.close()

    def ping(self, *argv, stdin=""):
        return run(*argv, "--url", self.board.url, "--token-file", self.board.tokenFile, "--json", stdin=stdin)

    def testAPingIsACardWithItsBodyAndLink(self):
        status, out, _ = self.ping("Nightly build failed", "--body", "-", "--source", "cron",
                                   "--link", "https://ci.example/41", "--link-title", "Build 41", stdin="step `test` exited 1")
        self.assertEqual(status, 0)
        cardId = json.loads(out)["cardId"]
        card = self.board.call("GET", "/api/cards/%s" % cardId)["card"]
        self.assertEqual((card["title"], card["description"]), ("Nightly build failed", "step `test` exited 1"))
        self.assertEqual([attachment["url"] for attachment in card["attachments"]], ["https://ci.example/41"])
        self.assertEqual(self.board.column(cardId), "New")

    def testOneThreadIsOneCardAndOneIdIsSentOnce(self):
        first = json.loads(self.ping("Can you look at the export?", "--thread", "t-1", "--id", "m-1")[1])
        again = json.loads(self.ping("Can you look at the export?", "--thread", "t-1", "--id", "m-1")[1])
        later = json.loads(self.ping("Still broken", "--thread", "t-1", "--id", "m-2")[1])
        self.assertEqual((again["cardId"], again.get("duplicate")), (first["cardId"], True))
        self.assertEqual((later["cardId"], later.get("joined")), (first["cardId"], True))

    def testARefusalSaysWhy(self):
        status, _, err = self.ping("Flaky test", "--column", "Someday")
        self.assertEqual(status, 1)
        self.assertIn('no column "Someday" on Inbox (its columns: New, Working, Needs you', err)
        status, _, err = run("x", "--url", self.board.url, "--token-file", os.path.join(REPO, "no-such-token"))
        self.assertEqual(status, 1)
        self.assertIn("the board wants its items key or token: none at", err)

    def testByDefaultThePingerSendsTheItemsKeyFromTheBoardsDataFolder(self):
        with mock.patch.dict(os.environ, {"DRIFTBOARD_DATA": self.board.data}):
            for name in ("DRIFTBOARD_ITEMS_KEY_FILE", "DRIFTBOARD_TOKEN_FILE"):
                os.environ.pop(name, None)
            self.assertEqual(pinger.defaultSecret(), (os.path.join(self.board.data, "items-key"), "items"))
            status, out, _ = run("Sent with the items key", "--url", self.board.url, "--json")
        self.assertEqual(status, 0)
        self.assertEqual(self.board.call("GET", "/api/cards/%s" % json.loads(out)["cardId"])["card"]["title"],
                         "Sent with the items key")


class NotTheBoard(http.server.BaseHTTPRequestHandler):
    """Answers like the board, but cannot prove it holds the token."""
    seen = []

    def do_GET(self):
        self._answer({"proof": "0" * 64})

    def do_POST(self):
        NotTheBoard.seen.append(self.headers.get("Authorization"))
        self._answer({"cardId": "stolen", "created": True})

    def _answer(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class ImpostorTest(unittest.TestCase):
    def testTheTokenGoesOnlyToTheBoard(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), NotTheBoard)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.NamedTemporaryFile("w", suffix=".token") as tokenFile:
            tokenFile.write("the-real-token")
            tokenFile.flush()
            status, _, err = run("x", "--url", "http://127.0.0.1:%d" % server.server_address[1], "--token-file", tokenFile.name)
        self.assertEqual(status, 1)
        self.assertIn("could not prove it is the board; its token was not sent", err)
        with tempfile.NamedTemporaryFile("w", suffix=".key") as keyFile:
            keyFile.write("the-items-key")
            keyFile.flush()
            status, _, err = run("x", "--url", "http://127.0.0.1:%d" % server.server_address[1], "--key-file", keyFile.name)
        self.assertEqual(status, 1)
        self.assertIn("could not prove it is the board; its items key was not sent", err)
        self.assertEqual(NotTheBoard.seen, [])


if __name__ == "__main__":
    unittest.main()
